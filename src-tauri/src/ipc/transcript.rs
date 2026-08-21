//! `store_*_message` — writing and reading the transcript.
//!
//! # The defect this module closes
//!
//! Phase C's functionality critic: *"The conversation surface has no message
//! persistence path at all — the transcript is pure React state that is
//! destroyed the moment you leave the conversation. There is no IPC command to
//! write or read a message in either direction."*
//!
//! `vela-store` has had `conversations` and `messages` tables since Phase A,
//! with FTS5 search over message content, per-part rows, and a **distinct
//! reasoning content type**. `store_search` already searched them. Nothing
//! could put anything in them.
//!
//! # The three rules
//!
//! 1. **No SQL here.** These commands call the [`MessageRepository`] trait and
//!    nothing else. The IPC layer does not know that the system of record is
//!    SQLite, and `vela-store` does not know that an IPC layer exists.
//! 2. **Reasoning is stored as reasoning.** A `ContentPart::Reasoning` written
//!    through here comes back as `ContentPart::Reasoning`, with its signature
//!    and its `redacted` flag — it is never flattened into the answer. That is
//!    what lets the transcript be re-sent to a model *without* replaying
//!    another model's thinking at it ([`MessageQuery::without_reasoning`], which
//!    [`list_messages`] exposes as `includeReasoning: false`), and what keeps a
//!    search hit inside a thinking block labelled as one.
//! 3. **A streaming turn is written before it finishes.** [`append_message`]
//!    takes a status, so the renderer writes a `streaming` row when the turn
//!    starts and [`update_message`] closes it out. A crash mid-generation then
//!    loses the tail, not the turn. The schema modelled this from the start;
//!    this is the surface that finally uses it.
//!
//! # What the renderer may and may not change
//!
//! [`update_message`] can set parts, status, usage, stop reason and error
//! message. **It cannot clear them**: an absent field means "leave it alone",
//! and there is no way to spell "set this back to nothing". Generation
//! outcomes are written once, by the surface that observed them; a renderer
//! that could erase a `failed` status could make a failed turn look complete.

use serde::{Deserialize, Serialize};
use tauri::State;
use vela_store::{
    AnsweredBy, ConversationId, Message, MessageId, MessagePatch, MessageQuery, MessageRole,
    MessageStatus, NewMessage, StopReason, TokenUsage, VelaStore,
};

use super::content::{to_store_parts, ContentPartDto};
use super::{Ack, IpcError, IpcResult};
use crate::store_host::StoreHandle;

/// Most messages returned in one read. A transcript longer than this is paged
/// through `afterSeq`, which is what the field is for.
const DEFAULT_MESSAGE_LIMIT: u32 = 1_000;
const MAX_MESSAGE_LIMIT: u32 = 5_000;

/* -------------------------------------------------------------------------- */
/* wire types                                                                 */
/* -------------------------------------------------------------------------- */

/// One stored message, as the transcript surface sees it.
///
/// Unlike `ConversationSummary` this **does** carry `providerId` / `modelId`:
/// which model said which thing is a per-message fact and belongs in the
/// transcript. It is a record of what happened, not a switch the UI branches
/// on — conventions §0.3 forbids the second, not the first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDto {
    pub id: String,
    pub conversation_id: String,
    /// Position in the conversation, assigned by the store. Dense and
    /// 0-based; `afterSeq` is exclusive, so paging from the last seq seen
    /// returns exactly what arrived since.
    pub seq: i64,
    pub role: MessageRole,
    pub status: MessageStatus,
    pub parts: Vec<ContentPartDto>,
    /// The endpoint the turn was **addressed to** — the user's selection.
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    /// The endpoint that **actually answered**, from
    /// `vela_providers::AnswerProvenance`. `null` is "not recorded", never
    /// "the same as `providerId`" — see `vela_store::Message`.
    pub answered_by_provider_id: Option<String>,
    pub answered_by_model_id: Option<String>,
    pub usage: TokenUsage,
    pub stop_reason: Option<StopReason>,
    pub error_message: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

impl From<Message> for MessageDto {
    fn from(message: Message) -> Self {
        Self {
            id: message.id.into_string(),
            conversation_id: message.conversation_id.into_string(),
            seq: message.seq,
            role: message.role,
            status: message.status,
            parts: message.parts.iter().map(ContentPartDto::from).collect(),
            provider_id: message.provider_id,
            model_id: message.model_id,
            answered_by_provider_id: message.answered_by_provider_id,
            answered_by_model_id: message.answered_by_model_id,
            usage: message.usage,
            stop_reason: message.stop_reason,
            error_message: message.error_message,
            created_at_ms: message.created_at.as_millis(),
            updated_at_ms: message.updated_at.as_millis(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreAppendMessageReq {
    pub conversation_id: String,
    pub role: MessageRole,
    pub parts: Vec<ContentPartDto>,
    /// Defaults to `complete`. Send `streaming` when opening a turn that is
    /// still generating.
    #[serde(default = "complete_status")]
    pub status: MessageStatus,
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub model_id: Option<String>,
    /// Who actually answered. Omitted means "not recorded", which is what a
    /// caller that genuinely does not know must send — never the selection.
    #[serde(default)]
    pub answered_by_provider_id: Option<String>,
    #[serde(default)]
    pub answered_by_model_id: Option<String>,
    #[serde(default)]
    pub usage: TokenUsage,
    #[serde(default)]
    pub stop_reason: Option<StopReason>,
    #[serde(default)]
    pub error_message: Option<String>,
}

fn complete_status() -> MessageStatus {
    MessageStatus::Complete
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreUpdateMessageReq {
    pub message_id: String,
    /// Replaces the whole part list. Streaming appends re-send the buffer they
    /// have; the store owns ordering, so a partial append would need a second
    /// notion of position that nothing else in the schema has.
    #[serde(default)]
    pub parts: Option<Vec<ContentPartDto>>,
    #[serde(default)]
    pub status: Option<MessageStatus>,
    #[serde(default)]
    pub usage: Option<TokenUsage>,
    #[serde(default)]
    pub stop_reason: Option<StopReason>,
    #[serde(default)]
    pub error_message: Option<String>,
    /// Who actually answered, which is only known once the turn came back.
    ///
    /// [`append_message`] takes the same fact, and an ordinary send uses it:
    /// that path has the whole answer in hand before it writes anything. An
    /// **agent run** does not — it opens the row when the turn opens, before a
    /// single token has arrived, and the endpoint that answered is a fact of
    /// the `done` frame. Without this field the run's only remaining write
    /// cannot carry it, so every row an agent run left behind came back from
    /// the store unattributed however loudly the host had said who answered.
    ///
    /// Omitted means "not learned"; the recorded value is left alone. There is
    /// no spelling for "forget who answered" — see `vela_store::MessagePatch`.
    ///
    /// **One object, not two keys.** Both halves are required inside it, and
    /// `serde` enforces that here at the wire: `{"answeredBy":{"providerId":…}}`
    /// with no `modelId` is a deserialization error, not a half-filled struct.
    /// The reason is [`update_message`]'s merge semantics — see
    /// `vela_store::AnsweredBy` — and this is the level where a hand-written
    /// JSON payload would otherwise slip a half through.
    #[serde(default)]
    pub answered_by: Option<AnsweredByDto>,
}

/// The wire form of `vela_store::AnsweredBy`: both halves, spelled as the
/// renderer's `AnswerProvenance` spells them.
///
/// Mirrors `src/platform/contract.ts`'s `AnswerProvenance`, which is what the
/// renderer already holds when it closes a turn out — so the payload is that
/// value verbatim rather than a pair of fields the call site reassembles.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnsweredByDto {
    pub provider_id: String,
    pub model_id: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreListMessagesReq {
    pub conversation_id: String,
    /// `false` leaves reasoning parts out — the projection the "rebuild the
    /// prompt" path wants. It is a projection, never a delete.
    #[serde(default = "yes")]
    pub include_reasoning: bool,
    /// Only messages after this position. Drives incremental loading.
    #[serde(default)]
    pub after_seq: Option<i64>,
    #[serde(default)]
    pub limit: Option<u32>,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreMessageRefReq {
    pub message_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRes {
    pub message: MessageDto,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageListRes {
    pub messages: Vec<MessageDto>,
}

/* -------------------------------------------------------------------------- */
/* logic — plain functions over the repository trait                          */
/* -------------------------------------------------------------------------- */

fn conversation_id(raw: &str) -> IpcResult<ConversationId> {
    Ok(ConversationId::new(raw.trim())?)
}

fn message_id(raw: &str) -> IpcResult<MessageId> {
    Ok(MessageId::new(raw.trim())?)
}

/// Writes one message. The turn's own content, exactly as it happened.
pub fn append_message(store: &dyn VelaStore, req: StoreAppendMessageReq) -> IpcResult<MessageRes> {
    let conversation = conversation_id(&req.conversation_id)?;
    if req.parts.is_empty() {
        return Err(IpcError::invalid(
            "invalid parts: a message needs at least one part",
        ));
    }
    let parts = to_store_parts(&req.parts, "message")?;

    let mut input = NewMessage::new(conversation, req.role)
        .with_parts(parts)
        .with_status(req.status)
        .with_usage(req.usage);
    input.provider_id = req.provider_id.filter(|id| !id.trim().is_empty());
    input.model_id = req.model_id.filter(|id| !id.trim().is_empty());
    // Blank folds to "not recorded", exactly as the selection does. A blank
    // string would otherwise be stored as an attribution to an endpoint with no
    // name, which `NewMessage::validate` refuses anyway — this makes the
    // renderer's `''` mean the same thing as its `null` rather than a 400.
    input.answered_by_provider_id = req
        .answered_by_provider_id
        .filter(|id| !id.trim().is_empty());
    input.answered_by_model_id = req.answered_by_model_id.filter(|id| !id.trim().is_empty());
    input.stop_reason = req.stop_reason;
    input.error_message = req.error_message;

    Ok(MessageRes {
        message: store.append_message(input)?.into(),
    })
}

/// What an `answeredBy` object on an update means, in the two cases a renderer
/// can produce and the one it cannot.
///
/// Wholly blank folds to `None` — "not learned" — for the reason the append
/// path folds a blank id: `''` is how some callers spell absent, and a
/// difference with no meaning behind it between two commands is a trap. A
/// *partially* blank object is not folded and not repaired: it goes on to
/// `MessagePatch::validate`, which refuses it, because the alternative is
/// storing a pair that names one endpoint and nobody. Neither half can be
/// missing outright — `AnsweredByDto` has no `Option` for `serde` to leave at
/// its default.
fn learned_attribution(dto: AnsweredByDto) -> Option<AnsweredBy> {
    if dto.provider_id.trim().is_empty() && dto.model_id.trim().is_empty() {
        return None;
    }
    Some(AnsweredBy {
        provider_id: dto.provider_id,
        model_id: dto.model_id,
    })
}

/// Amends a message already written — the call that closes out a streaming
/// turn. See the module docs for why nothing here can *clear* a field.
pub fn update_message(store: &dyn VelaStore, req: StoreUpdateMessageReq) -> IpcResult<MessageRes> {
    let id = message_id(&req.message_id)?;
    let parts = match &req.parts {
        Some(parts) if parts.is_empty() => {
            return Err(IpcError::invalid(
                "invalid parts: a message needs at least one part",
            ))
        }
        Some(parts) => Some(to_store_parts(parts, "message")?),
        None => None,
    };

    let patch = MessagePatch {
        parts,
        status: req.status,
        usage: req.usage,
        stop_reason: req.stop_reason.map(Some),
        error_message: req.error_message.map(Some),
        answered_by: req.answered_by.and_then(learned_attribution),
    };
    if patch.is_empty() {
        // Nothing to do is not a failure, but it must not read as a write:
        // return the row as it stands.
        return Ok(MessageRes {
            message: store.get_message(&id)?.into(),
        });
    }
    Ok(MessageRes {
        message: store.update_message(&id, patch)?.into(),
    })
}

/// Loads a transcript. This is the read that makes a conversation survive
/// leaving it.
pub fn list_messages(
    store: &dyn VelaStore,
    req: StoreListMessagesReq,
) -> IpcResult<MessageListRes> {
    let conversation = conversation_id(&req.conversation_id)?;
    let limit = req
        .limit
        .unwrap_or(DEFAULT_MESSAGE_LIMIT)
        .min(MAX_MESSAGE_LIMIT);

    let mut query = MessageQuery {
        include_reasoning: req.include_reasoning,
        after_seq: req.after_seq,
        limit: Some(limit),
    };
    if let Some(seq) = req.after_seq {
        query.after_seq = Some(seq);
    }

    Ok(MessageListRes {
        messages: store
            .list_messages(&conversation, query)?
            .into_iter()
            .map(MessageDto::from)
            .collect(),
    })
}

/// Removes one message. Present so an aborted or unwanted turn can be taken
/// back out of the record rather than left in it forever.
pub fn delete_message(store: &dyn VelaStore, req: StoreMessageRefReq) -> IpcResult<Ack> {
    store.delete_message(&message_id(&req.message_id)?)?;
    Ok(Ack::ok())
}

/* -------------------------------------------------------------------------- */
/* commands — thin adapters                                                   */
/* -------------------------------------------------------------------------- */

#[tauri::command]
pub fn store_append_message(
    store: State<'_, StoreHandle>,
    payload: StoreAppendMessageReq,
) -> IpcResult<MessageRes> {
    append_message(store.store(), payload)
}

#[tauri::command]
pub fn store_update_message(
    store: State<'_, StoreHandle>,
    payload: StoreUpdateMessageReq,
) -> IpcResult<MessageRes> {
    update_message(store.store(), payload)
}

#[tauri::command]
pub fn store_list_messages(
    store: State<'_, StoreHandle>,
    payload: StoreListMessagesReq,
) -> IpcResult<MessageListRes> {
    list_messages(store.store(), payload)
}

#[tauri::command]
pub fn store_delete_message(
    store: State<'_, StoreHandle>,
    payload: StoreMessageRefReq,
) -> IpcResult<Ack> {
    delete_message(store.store(), payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::IpcErrorCode;
    use vela_store::{ConversationRepository, DatabaseLocation, NewConversation, SqliteStore};

    /// VERIFIED-BY-FAKE: an in-memory database. Real schema, real migrations,
    /// real SQL — no file.
    fn store() -> SqliteStore {
        SqliteStore::open(DatabaseLocation::InMemory).unwrap()
    }

    fn conversation(store: &SqliteStore) -> String {
        store
            .create_conversation(NewConversation::titled("a chat"))
            .unwrap()
            .id
            .into_string()
    }

    fn user_turn(conversation_id: &str, text: &str) -> StoreAppendMessageReq {
        StoreAppendMessageReq {
            conversation_id: conversation_id.to_owned(),
            role: MessageRole::User,
            parts: vec![ContentPartDto::text(text)],
            status: MessageStatus::Complete,
            provider_id: None,
            model_id: None,
            answered_by_provider_id: None,
            answered_by_model_id: None,
            usage: TokenUsage::default(),
            stop_reason: None,
            error_message: None,
        }
    }

    #[test]
    fn a_message_written_through_ipc_is_readable_through_ipc() {
        // The whole defect in one test: before this module the transcript died
        // with the React tree that held it.
        let store = store();
        let chat = conversation(&store);
        append_message(&store, user_turn(&chat, "hello")).unwrap();

        let loaded = list_messages(
            &store,
            StoreListMessagesReq {
                conversation_id: chat,
                include_reasoning: true,
                after_seq: None,
                limit: None,
            },
        )
        .unwrap();
        assert_eq!(loaded.messages.len(), 1);
        assert_eq!(
            loaded.messages[0].parts,
            vec![ContentPartDto::text("hello")]
        );
        assert_eq!(
            loaded.messages[0].seq, 0,
            "the store assigns positions from 0"
        );
    }

    #[test]
    fn reasoning_is_persisted_distinctly_and_can_be_projected_out() {
        let store = store();
        let chat = conversation(&store);
        append_message(
            &store,
            StoreAppendMessageReq {
                conversation_id: chat.clone(),
                role: MessageRole::Assistant,
                parts: vec![
                    ContentPartDto::Reasoning {
                        text: "the user wants a number".into(),
                        signature: Some("sig-abc".into()),
                        redacted: false,
                    },
                    ContentPartDto::text("391"),
                ],
                status: MessageStatus::Complete,
                provider_id: Some("llamacpp".into()),
                model_id: Some("qwen".into()),
                answered_by_provider_id: Some("llamacpp".into()),
                answered_by_model_id: Some("qwen".into()),
                usage: TokenUsage {
                    output_tokens: Some(12),
                    reasoning_tokens: Some(266),
                    ..TokenUsage::default()
                },
                stop_reason: Some(StopReason::EndTurn),
                error_message: None,
            },
        )
        .unwrap();

        let with = list_messages(
            &store,
            StoreListMessagesReq {
                conversation_id: chat.clone(),
                include_reasoning: true,
                after_seq: None,
                limit: None,
            },
        )
        .unwrap();
        let parts = &with.messages[0].parts;
        assert_eq!(parts.len(), 2, "reasoning and answer are two parts");
        assert!(matches!(
            &parts[0],
            ContentPartDto::Reasoning { signature: Some(sig), redacted: false, .. } if sig == "sig-abc"
        ));
        assert_eq!(parts[1], ContentPartDto::text("391"));
        assert_eq!(with.messages[0].usage.reasoning_tokens, Some(266));
        assert_eq!(with.messages[0].stop_reason, Some(StopReason::EndTurn));
        assert_eq!(with.messages[0].model_id.as_deref(), Some("qwen"));

        let without = list_messages(
            &store,
            StoreListMessagesReq {
                conversation_id: chat,
                include_reasoning: false,
                after_seq: None,
                limit: None,
            },
        )
        .unwrap();
        assert_eq!(
            without.messages[0].parts,
            vec![ContentPartDto::text("391")],
            "the prompt-rebuilding projection must not replay thinking at the model"
        );
    }

    #[test]
    fn an_image_survives_the_round_trip_byte_for_byte() {
        let store = store();
        let chat = conversation(&store);
        let bytes: Vec<u8> = (0u8..=255).collect();
        let mut req = user_turn(&chat, "");
        req.parts = vec![ContentPartDto::Image {
            mime_type: "image/png".into(),
            data: vela_providers::base64_encode(&bytes),
        }];
        append_message(&store, req).unwrap();

        let loaded = list_messages(
            &store,
            StoreListMessagesReq {
                conversation_id: chat,
                include_reasoning: true,
                after_seq: None,
                limit: None,
            },
        )
        .unwrap();
        match &loaded.messages[0].parts[0] {
            ContentPartDto::Image { mime_type, data } => {
                assert_eq!(mime_type, "image/png");
                assert_eq!(vela_providers::base64_decode(data).unwrap(), bytes);
            }
            other => panic!("expected an image, got {other:?}"),
        }
    }

    #[test]
    fn a_streaming_turn_is_opened_then_closed_out() {
        // Rule 3: the row exists before the tokens do, so a crash costs the
        // tail rather than the turn.
        let store = store();
        let chat = conversation(&store);
        let opened = append_message(
            &store,
            StoreAppendMessageReq {
                status: MessageStatus::Streaming,
                role: MessageRole::Assistant,
                parts: vec![ContentPartDto::text("")],
                ..user_turn(&chat, "")
            },
        )
        .unwrap()
        .message;
        assert_eq!(opened.status, MessageStatus::Streaming);

        let closed = update_message(
            &store,
            StoreUpdateMessageReq {
                message_id: opened.id.clone(),
                parts: Some(vec![ContentPartDto::text("the whole answer")]),
                status: Some(MessageStatus::Complete),
                usage: Some(TokenUsage {
                    output_tokens: Some(4),
                    ..TokenUsage::default()
                }),
                stop_reason: Some(StopReason::EndTurn),
                error_message: None,
                answered_by: None,
            },
        )
        .unwrap()
        .message;

        assert_eq!(closed.id, opened.id, "the same row, amended");
        assert_eq!(closed.status, MessageStatus::Complete);
        assert_eq!(closed.parts, vec![ContentPartDto::text("the whole answer")]);
        assert_eq!(closed.usage.output_tokens, Some(4));
    }

    /// **The closing update carries who answered, and it is not the selection.**
    ///
    /// The append above cannot: the row is opened before the first token, when
    /// the only endpoint anyone knows about is the one the turn was addressed
    /// to. `AgentRun::runTurn` in `src/runtime/agent-loop-harness.ts` opens such
    /// a row and used to close it out with parts, status, usage and stop reason
    /// — the attribution was in its hand at that line and had nowhere to go.
    ///
    /// The fixture disagrees on purpose: the turn was addressed to
    /// `local-llamacpp` and `hosted-openai` answered. An implementation that
    /// echoed the selection into the answering columns would satisfy "not null"
    /// and fail the last two assertions, which is the whole point of writing
    /// them.
    #[test]
    fn a_streaming_turn_learns_who_answered_when_it_is_closed_out() {
        let store = store();
        let chat = conversation(&store);
        let opened = append_message(
            &store,
            StoreAppendMessageReq {
                status: MessageStatus::Streaming,
                role: MessageRole::Assistant,
                parts: vec![ContentPartDto::text("")],
                provider_id: Some("local-llamacpp".into()),
                model_id: Some("qwen3-8b".into()),
                ..user_turn(&chat, "")
            },
        )
        .unwrap()
        .message;
        assert_eq!(
            opened.answered_by_provider_id, None,
            "the row opens before anyone has answered"
        );

        let closed = update_message(
            &store,
            StoreUpdateMessageReq {
                message_id: opened.id.clone(),
                parts: Some(vec![ContentPartDto::text("the whole answer")]),
                status: Some(MessageStatus::Complete),
                usage: None,
                stop_reason: Some(StopReason::EndTurn),
                error_message: None,
                answered_by: Some(AnsweredByDto {
                    provider_id: "hosted-openai".into(),
                    model_id: "gpt-4o-mini".into(),
                }),
            },
        )
        .unwrap()
        .message;

        assert_eq!(
            closed.answered_by_provider_id.as_deref(),
            Some("hosted-openai")
        );
        assert_eq!(closed.answered_by_model_id.as_deref(), Some("gpt-4o-mini"));
        assert_eq!(closed.provider_id.as_deref(), Some("local-llamacpp"));
        assert_ne!(closed.answered_by_provider_id, closed.provider_id);
        assert_ne!(closed.answered_by_model_id, closed.model_id);

        // And it survives the read the transcript surface actually performs.
        let reloaded = list_messages(
            &store,
            StoreListMessagesReq {
                conversation_id: chat,
                include_reasoning: true,
                after_seq: None,
                limit: None,
            },
        )
        .unwrap();
        assert_eq!(
            reloaded.messages[0].answered_by_provider_id.as_deref(),
            Some("hosted-openai")
        );
    }

    /// A **wholly** blank attribution folds to "not learned", not to a 400.
    ///
    /// `append_message` already treats `''` this way, and the renderer's
    /// `answeredBy` is `AnswerProvenance | null` — a caller that spells the
    /// absent case as empty strings on one command and gets a rejection on the
    /// other has found a difference with no meaning behind it.
    ///
    /// Only wholly. A pair with one blank half is refused rather than folded or
    /// repaired: folding drops an attribution the caller believed it had sent,
    /// and repairing writes a named endpoint beside a nameless model. That case
    /// is `sqlite::tests::an_update_cannot_replace_one_half_of_a_recorded_attribution`,
    /// and `learned_attribution` is where the two part company.
    #[test]
    fn a_blank_attribution_on_an_update_means_not_learned() {
        let store = store();
        let chat = conversation(&store);
        let opened = append_message(
            &store,
            StoreAppendMessageReq {
                status: MessageStatus::Streaming,
                role: MessageRole::Assistant,
                parts: vec![ContentPartDto::text("")],
                answered_by_provider_id: Some("hosted-openai".into()),
                answered_by_model_id: Some("gpt-4o-mini".into()),
                ..user_turn(&chat, "")
            },
        )
        .unwrap()
        .message;

        let closed = update_message(
            &store,
            StoreUpdateMessageReq {
                message_id: opened.id,
                parts: None,
                status: Some(MessageStatus::Complete),
                usage: None,
                stop_reason: None,
                error_message: None,
                answered_by: Some(AnsweredByDto {
                    provider_id: "   ".into(),
                    model_id: String::new(),
                }),
            },
        )
        .unwrap()
        .message;

        assert_eq!(closed.status, MessageStatus::Complete);
        assert_eq!(
            closed.answered_by_provider_id.as_deref(),
            Some("hosted-openai"),
            "blank is `not learned`, which leaves the recorded fact standing"
        );
        assert_eq!(closed.answered_by_model_id.as_deref(), Some("gpt-4o-mini"));
    }

    /// **A half-blank pair is an invalid payload, and the row is untouched.**
    ///
    /// The seam this covers is `learned_attribution`'s `&&`. With an `||` there
    /// the same request would fold to "not learned" and the rest of the update
    /// would go through — a status change recorded, an attribution the caller
    /// believed it sent silently dropped, and no error anywhere. Silence is the
    /// defect this command exists to end, so the half is refused instead, and
    /// the refusal costs the whole statement rather than half of it.
    #[test]
    fn a_half_blank_attribution_on_an_update_is_refused_whole() {
        let store = store();
        let chat = conversation(&store);
        let opened = append_message(
            &store,
            StoreAppendMessageReq {
                status: MessageStatus::Streaming,
                role: MessageRole::Assistant,
                parts: vec![ContentPartDto::text("")],
                answered_by_provider_id: Some("hosted-openai".into()),
                answered_by_model_id: Some("gpt-4o-mini".into()),
                ..user_turn(&chat, "")
            },
        )
        .unwrap()
        .message;

        let error = update_message(
            &store,
            StoreUpdateMessageReq {
                message_id: opened.id.clone(),
                parts: None,
                status: Some(MessageStatus::Complete),
                usage: None,
                stop_reason: None,
                error_message: None,
                answered_by: Some(AnsweredByDto {
                    provider_id: "anthropic".into(),
                    model_id: "   ".into(),
                }),
            },
        )
        .unwrap_err();
        assert_eq!(error.code, IpcErrorCode::InvalidPayload);

        let reloaded = list_messages(
            &store,
            StoreListMessagesReq {
                conversation_id: chat,
                include_reasoning: true,
                after_seq: None,
                limit: None,
            },
        )
        .unwrap();
        let standing = &reloaded.messages[0];
        assert_eq!(standing.status, MessageStatus::Streaming);
        assert_eq!(
            standing.answered_by_provider_id.as_deref(),
            Some("hosted-openai"),
            "the recorded attribution stands; a refused patch writes nothing"
        );
        assert_eq!(
            standing.answered_by_model_id.as_deref(),
            Some("gpt-4o-mini")
        );
    }

    #[test]
    fn a_cancelled_turn_keeps_what_arrived() {
        let store = store();
        let chat = conversation(&store);
        let opened = append_message(
            &store,
            StoreAppendMessageReq {
                status: MessageStatus::Streaming,
                role: MessageRole::Assistant,
                parts: vec![ContentPartDto::text("half an ans")],
                ..user_turn(&chat, "")
            },
        )
        .unwrap()
        .message;

        let stopped = update_message(
            &store,
            StoreUpdateMessageReq {
                message_id: opened.id,
                parts: None,
                status: Some(MessageStatus::Cancelled),
                usage: None,
                stop_reason: Some(StopReason::Cancelled),
                error_message: None,
                answered_by: None,
            },
        )
        .unwrap()
        .message;
        assert_eq!(stopped.status, MessageStatus::Cancelled);
        assert_eq!(
            stopped.parts,
            vec![ContentPartDto::text("half an ans")],
            "an omitted field leaves the value alone"
        );
    }

    #[test]
    fn a_transcript_can_be_loaded_incrementally() {
        let store = store();
        let chat = conversation(&store);
        for text in ["one", "two", "three"] {
            append_message(&store, user_turn(&chat, text)).unwrap();
        }
        let tail = list_messages(
            &store,
            StoreListMessagesReq {
                conversation_id: chat.clone(),
                include_reasoning: true,
                after_seq: Some(0),
                limit: None,
            },
        )
        .unwrap();
        assert_eq!(tail.messages.len(), 2, "afterSeq is exclusive");
        assert_eq!(tail.messages[0].seq, 1);

        let capped = list_messages(
            &store,
            StoreListMessagesReq {
                conversation_id: chat,
                include_reasoning: true,
                after_seq: None,
                limit: Some(1),
            },
        )
        .unwrap();
        assert_eq!(capped.messages.len(), 1);
    }

    #[test]
    fn a_message_written_here_is_findable_by_the_search_that_already_existed() {
        // `store_search` has searched this index since Phase A and had nothing
        // to find. This is the join.
        let store = store();
        let chat = conversation(&store);
        append_message(&store, user_turn(&chat, "the rendering pipeline")).unwrap();

        let hits = crate::ipc::store::search(
            &store,
            crate::ipc::store::StoreSearchReq {
                query: "rendering".into(),
                limit: None,
            },
        )
        .unwrap();
        assert_eq!(hits.messages.len(), 1, "a stored message must be findable");
    }

    #[test]
    fn a_message_can_be_taken_back_out_of_the_record() {
        let store = store();
        let chat = conversation(&store);
        let written = append_message(&store, user_turn(&chat, "oops"))
            .unwrap()
            .message;
        delete_message(
            &store,
            StoreMessageRefReq {
                message_id: written.id,
            },
        )
        .unwrap();
        let loaded = list_messages(
            &store,
            StoreListMessagesReq {
                conversation_id: chat,
                include_reasoning: true,
                after_seq: None,
                limit: None,
            },
        )
        .unwrap();
        assert!(loaded.messages.is_empty());
    }

    #[test]
    fn a_message_for_a_conversation_that_does_not_exist_is_refused() {
        let store = store();
        let error =
            append_message(&store, user_turn("conv_0000000000000000000000", "hi")).unwrap_err();
        assert!(
            matches!(
                error.code,
                IpcErrorCode::NotFound | IpcErrorCode::InvalidPayload
            ),
            "{error:?}"
        );
    }

    #[test]
    fn a_message_with_no_parts_is_refused_rather_than_written_empty() {
        let store = store();
        let chat = conversation(&store);
        let mut req = user_turn(&chat, "");
        req.parts.clear();
        let error = append_message(&store, req).unwrap_err();
        assert_eq!(error.code, IpcErrorCode::InvalidPayload);
        assert!(error.message.contains("at least one part"));

        let error = update_message(
            &store,
            StoreUpdateMessageReq {
                message_id: "msg_x".into(),
                parts: Some(Vec::new()),
                status: None,
                usage: None,
                stop_reason: None,
                error_message: None,
                answered_by: None,
            },
        )
        .unwrap_err();
        assert_eq!(error.code, IpcErrorCode::InvalidPayload);
    }

    #[test]
    fn a_blank_id_is_an_invalid_payload_and_not_a_lookup() {
        let store = store();
        for error in [
            list_messages(
                &store,
                StoreListMessagesReq {
                    conversation_id: "   ".into(),
                    include_reasoning: true,
                    after_seq: None,
                    limit: None,
                },
            )
            .unwrap_err(),
            delete_message(
                &store,
                StoreMessageRefReq {
                    message_id: " ".into(),
                },
            )
            .unwrap_err(),
        ] {
            assert_eq!(error.code, IpcErrorCode::InvalidPayload, "{error:?}");
        }
    }

    #[test]
    fn the_wire_shape_is_camel_case() {
        let store = store();
        let chat = conversation(&store);
        let written = append_message(&store, user_turn(&chat, "hello")).unwrap();
        let json = serde_json::to_value(&written).unwrap();
        let message = &json["message"];
        assert_eq!(message["conversationId"], chat);
        assert!(message["createdAtMs"].is_i64());
        assert_eq!(message["parts"][0]["kind"], "text");
        assert_eq!(message["status"], "complete");
        assert!(message["stopReason"].is_null());
    }

    #[test]
    fn a_request_with_only_the_required_fields_deserialises() {
        // What the renderer actually sends for the common case.
        let req: StoreAppendMessageReq = serde_json::from_str(
            r#"{"conversationId":"conv_1","role":"user",
                "parts":[{"kind":"text","text":"hi"}]}"#,
        )
        .unwrap();
        assert_eq!(req.status, MessageStatus::Complete);
        assert!(req.usage.is_unreported());

        let req: StoreListMessagesReq =
            serde_json::from_str(r#"{"conversationId":"conv_1"}"#).unwrap();
        assert!(
            req.include_reasoning,
            "a transcript read includes thinking unless asked otherwise"
        );
    }

    /// **The wire keys the renderer spells are the ones that bind.**
    ///
    /// Every other test in this module builds a `StoreUpdateMessageReq` in Rust,
    /// which proves the store writes what the struct holds and says nothing
    /// about how the struct gets filled. The renderer does not call this
    /// function; it posts JSON. `#[serde(rename_all = "camelCase")]` is what
    /// joins the two, and `serde` answers an unknown key by leaving the field at
    /// its `#[serde(default)]` — so a misspelling on either side is not an error
    /// anywhere, it is silence, which is the exact failure this whole change
    /// exists to end. The literal below is the payload
    /// `src/runtime/agent-loop-harness.ts` produces at its `done` branch.
    ///
    /// There is no automated parity guard over these DTOs — the one in
    /// `src/platform/chat-contract-parity.test.ts` says in its own header that
    /// the `src-tauri/src/ipc/` types are out of its scope — so this test is the
    /// only thing standing between a renamed field and a silent no-op.
    #[test]
    fn the_renderers_spelling_of_the_attribution_binds_on_an_update() {
        let req: StoreUpdateMessageReq = serde_json::from_str(
            r#"{"messageId":"msg_1","status":"complete",
                "answeredBy":{"providerId":"hosted-openai","modelId":"gpt-4o-mini"}}"#,
        )
        .unwrap();
        let answered_by = req.answered_by.expect("the object binds");
        assert_eq!(answered_by.provider_id, "hosted-openai");
        assert_eq!(answered_by.model_id, "gpt-4o-mini");

        // And the omission the same call site produces for an unattributed turn.
        let silent: StoreUpdateMessageReq =
            serde_json::from_str(r#"{"messageId":"msg_1","status":"complete"}"#).unwrap();
        assert!(silent.answered_by.is_none());

        // A half is not a payload. `providerId` alone does not deserialize into
        // an `AnsweredByDto` holding an empty model — it does not deserialize
        // at all, which is the difference between a rejected call and a
        // fabricated pairing recorded against the row.
        let half = serde_json::from_str::<StoreUpdateMessageReq>(
            r#"{"messageId":"msg_1","answeredBy":{"providerId":"anthropic"}}"#,
        );
        assert!(half.is_err(), "a half-written attribution must not bind");

        // The snake_case spelling is *not* what the wire carries. This is the
        // assertion that reddens if `rename_all` is ever dropped from the
        // struct: serde would then take `answered_by` and ignore `answeredBy`,
        // and every attribution the renderer sends would become silence.
        let snake: StoreUpdateMessageReq = serde_json::from_str(
            r#"{"messageId":"msg_1","answered_by":{"providerId":"a","modelId":"b"}}"#,
        )
        .unwrap();
        assert!(
            snake.answered_by.is_none(),
            "camelCase is the wire spelling"
        );
    }
}
