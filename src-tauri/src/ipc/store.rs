//! `store_*` commands — the conversation list the sidebar is built on.
//!
//! ## What crosses this boundary, and what deliberately does not
//!
//! A stored [`vela_store::Conversation`] carries `provider_id` and `model_id`.
//! [`ConversationSummary`] drops both. That is not an oversight and it is not
//! laziness: conventions §0 rule 3 says the UI branches on capability flags and
//! never on a backend identity, and the cheapest way to keep that true is for
//! the navigation surface to have no vocabulary for one. The transcript surface
//! records which model said what, per message, where it belongs.
//!
//! ## Two searches, because one index cannot answer the question
//!
//! `search_messages` is FTS5 over message content. It cannot find a
//! conversation the user *named* "Rendering notes" and never typed those words
//! into, because titles are not in the index. `search_conversations` is a
//! substring match on the title. [`search`] runs both and returns them as two
//! labelled halves rather than one blended list, so the UI can say where a hit
//! came from instead of implying the words appear in the transcript.
//!
//! ## Why the raw query is rewritten before it reaches FTS
//!
//! FTS5 has a query language. A user typing `what's "the deal` into a search box
//! is not writing one, and surfacing `INVALID_PAYLOAD` at them for an unbalanced
//! quote would be the search box blaming the user for its own syntax.
//! [`fts_query`] extracts alphanumeric runs and reassembles a conjunction of
//! quoted terms with the last one prefix-matched, so typing narrows results as
//! you go. It is pinned across both languages by
//! `tests/parity/navigation.json`.

use serde::{Deserialize, Serialize};
use tauri::State;
use vela_store::{
    Conversation, ConversationId, ConversationPatch, ConversationQuery, MessageQuery,
    NewConversation, SearchHitKind, VelaStore,
};

use super::{Ack, IpcError, IpcResult};
use crate::store_host::StoreHandle;

/// The title a conversation gets before it has said anything worth naming it
/// after. Mirrored in `src/platform/browser-adapter.ts`.
pub const UNTITLED_TITLE: &str = "New conversation";

/// Longest derived title, in Unicode scalar values. Mirrored on the TS side,
/// where `[...text]` iterates code points for the same reason.
pub const MAX_TITLE_CHARS: usize = 48;

/// Below this, a truncated title is not cut back to a word boundary — trimming
/// "Antidisestablishmentarianism…" down to nothing would be worse than a
/// mid-word cut.
const MIN_WORD_BOUNDARY: usize = 24;

/// Characters stripped from the tail of a truncated title before the ellipsis.
const TRAILING_NOISE: &[char] = &[
    ' ', '.', ',', ';', ':', '!', '?', '-', '\u{2013}', '\u{2014}', '\u{2026}',
];

/// Hard ceiling on any title the renderer supplies. Long enough for a sentence,
/// short enough that a paste of a whole document cannot become a sidebar row.
const MAX_SUPPLIED_TITLE: usize = 200;

const DEFAULT_LIST_LIMIT: u32 = 500;
const DEFAULT_SEARCH_LIMIT: u32 = 50;
const MAX_SEARCH_LIMIT: u32 = 200;

/* -------------------------------------------------------------------------- */
/* wire types                                                                 */
/* -------------------------------------------------------------------------- */

/// A conversation as the navigation surface sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub id: String,
    pub title: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    /// `None` when nothing has been said yet. Distinct from `createdAtMs`: a
    /// conversation opened and abandoned is not a conversation held.
    pub last_message_at_ms: Option<i64>,
    pub message_count: i64,
    /// The title is still the placeholder, so the UI may render it quietly and
    /// may ask the host to derive a real one.
    pub title_is_placeholder: bool,
}

impl From<Conversation> for ConversationSummary {
    fn from(conversation: Conversation) -> Self {
        Self {
            title_is_placeholder: is_placeholder_title(&conversation.title),
            id: conversation.id.into_string(),
            title: conversation.title,
            created_at_ms: conversation.created_at.as_millis(),
            updated_at_ms: conversation.updated_at.as_millis(),
            last_message_at_ms: conversation.last_message_at.map(|t| t.as_millis()),
            message_count: conversation.message_count,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MessageHitKind {
    Answer,
    /// The match is inside a reasoning block. Labelled so the UI can say so
    /// rather than quoting private thinking as though it were an answer.
    Reasoning,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageHit {
    pub message_id: String,
    pub conversation_id: String,
    pub conversation_title: String,
    pub kind: MessageHitKind,
    /// The matched text, with the hit delimited by `[` and `]`.
    pub snippet: String,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreListConversationsReq {
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationListRes {
    pub conversations: Vec<ConversationSummary>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreCreateConversationReq {
    /// Omit to open an untitled conversation, which is the normal case.
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRes {
    pub conversation: ConversationSummary,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreRenameConversationReq {
    pub conversation_id: String,
    pub title: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreConversationRefReq {
    pub conversation_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreSearchReq {
    pub query: String,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreSearchRes {
    /// Conversations whose **title** matched.
    pub conversations: Vec<ConversationSummary>,
    /// Messages whose **content** matched.
    pub messages: Vec<MessageHit>,
}

/* -------------------------------------------------------------------------- */
/* pure helpers — mirrored in TypeScript, pinned by tests/parity/navigation.json */
/* -------------------------------------------------------------------------- */

pub fn is_placeholder_title(title: &str) -> bool {
    title.trim().is_empty() || title.trim() == UNTITLED_TITLE
}

/// Reduces a message to something that reads as a name in a 240px-wide list.
///
/// Returns `None` when there is nothing nameable — an image-only turn, a bare
/// code fence, whitespace. `None` means "leave the placeholder alone", never
/// "use an empty title".
pub fn derive_title(text: &str) -> Option<String> {
    let line = text.lines().map(strip_markdown_lead_in).find(|candidate| {
        // A fence tells you the language, not the subject.
        !candidate.is_empty() && !candidate.starts_with("```")
    })?;

    let collapsed = collapse_whitespace(&line);
    if collapsed.is_empty() {
        return None;
    }
    Some(truncate_title(&collapsed))
}

/// Strips the markdown that opens a line — heading hashes, a quote caret, a
/// bullet, an ordered-list number — and trims. `"## Why the sails"` is about the
/// sails, not about hashes.
fn strip_markdown_lead_in(line: &str) -> String {
    let trimmed = line.trim();
    let markers: String = trimmed
        .chars()
        .take_while(|c| matches!(c, '#' | '>' | '-' | '*' | '+' | ' '))
        .collect();
    if !markers.is_empty() {
        let rest = trimmed[markers.len()..].trim();
        // A lead-in is separated from its text by a space (`## Why`, `- item`),
        // or it is the whole line (`---`, a horizontal rule, which leaves
        // nothing and correctly disqualifies the line). Without that test,
        // `-5 degrees today` becomes `5 degrees today` and `*emphasis* here`
        // loses its first character.
        if markers.ends_with(' ') || rest.is_empty() {
            return rest.to_owned();
        }
    }

    // `1. ` / `12) ` — an ordered-list marker, and nothing else numeric.
    let digits: String = trimmed.chars().take_while(char::is_ascii_digit).collect();
    if !digits.is_empty() {
        let remainder = &trimmed[digits.len()..];
        if let Some(after) = remainder
            .strip_prefix(". ")
            .or_else(|| remainder.strip_prefix(") "))
        {
            return after.trim_start().to_owned();
        }
    }
    trimmed.to_owned()
}

fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_title(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= MAX_TITLE_CHARS {
        return text.to_owned();
    }

    let head: String = chars[..MAX_TITLE_CHARS].iter().collect();
    let cut = match head.rfind(' ') {
        // `rfind` is a byte index; the boundary test has to be in characters,
        // or a title full of accents cuts at a different place than the TS side.
        Some(byte) if head[..byte].chars().count() >= MIN_WORD_BOUNDARY => head[..byte].to_owned(),
        _ => head.clone(),
    };
    let trimmed = cut.trim_end_matches(TRAILING_NOISE);
    let stem = if trimmed.is_empty() { &head } else { trimmed };
    format!("{stem}\u{2026}")
}

/// Rewrites what the user typed into an FTS5 expression.
///
/// Alphanumeric runs become quoted terms joined by `AND`; the last one is
/// prefix-matched so results narrow while typing rather than vanishing between
/// whole words. Returns `None` when nothing survives — punctuation alone is not
/// a content search, and passing it through would make FTS reject a query the
/// user has every right to type.
pub fn fts_query(raw: &str) -> Option<String> {
    let terms: Vec<String> = raw
        .split(|c: char| !c.is_alphanumeric())
        .filter(|term| !term.is_empty())
        .map(str::to_lowercase)
        .collect();
    if terms.is_empty() {
        return None;
    }
    let last = terms.len() - 1;
    Some(
        terms
            .iter()
            .enumerate()
            .map(|(index, term)| {
                if index == last {
                    format!("\"{term}\"*")
                } else {
                    format!("\"{term}\"")
                }
            })
            .collect::<Vec<_>>()
            .join(" AND "),
    )
}

/* -------------------------------------------------------------------------- */
/* logic                                                                      */
/* -------------------------------------------------------------------------- */

fn conversation_id(raw: &str) -> IpcResult<ConversationId> {
    ConversationId::new(raw.trim()).map_err(IpcError::from)
}

fn validate_title(raw: &str) -> IpcResult<String> {
    let title = collapse_whitespace(raw);
    if title.is_empty() {
        return Err(IpcError::invalid("invalid title: must not be blank"));
    }
    if title.chars().count() > MAX_SUPPLIED_TITLE {
        return Err(IpcError::invalid(format!(
            "invalid title: must be at most {MAX_SUPPLIED_TITLE} characters"
        )));
    }
    Ok(title)
}

pub fn list(
    store: &dyn VelaStore,
    req: StoreListConversationsReq,
) -> IpcResult<ConversationListRes> {
    let conversations = store
        .list_conversations(ConversationQuery {
            limit: Some(req.limit.unwrap_or(DEFAULT_LIST_LIMIT)),
            ..ConversationQuery::default()
        })?
        .into_iter()
        .map(ConversationSummary::from)
        .collect();
    Ok(ConversationListRes { conversations })
}

pub fn create(
    store: &dyn VelaStore,
    req: StoreCreateConversationReq,
) -> IpcResult<ConversationRes> {
    let title = match req.title.as_deref() {
        Some(supplied) => validate_title(supplied)?,
        None => UNTITLED_TITLE.to_owned(),
    };
    Ok(ConversationRes {
        conversation: store
            .create_conversation(NewConversation::titled(title))?
            .into(),
    })
}

pub fn rename(
    store: &dyn VelaStore,
    req: StoreRenameConversationReq,
) -> IpcResult<ConversationRes> {
    let id = conversation_id(&req.conversation_id)?;
    let title = validate_title(&req.title)?;
    Ok(ConversationRes {
        conversation: store
            .update_conversation(
                &id,
                ConversationPatch {
                    title: Some(title),
                    ..ConversationPatch::default()
                },
            )?
            .into(),
    })
}

pub fn delete(store: &dyn VelaStore, req: StoreConversationRefReq) -> IpcResult<Ack> {
    let id = conversation_id(&req.conversation_id)?;
    // Deleting an absent conversation is NOT_FOUND rather than a silent success:
    // the sidebar just asked to destroy something, and "it was already gone" is
    // information, not noise.
    store.get_conversation(&id)?;
    store.delete_conversation(&id)?;
    Ok(Ack::ok())
}

/// Names an untitled conversation after what was actually said in it.
///
/// Idempotent and non-destructive: a conversation the user has titled — or one
/// with nothing nameable in it — comes back unchanged. The renderer may call
/// this for every placeholder row it lists without having to track which ones it
/// has already asked about.
pub fn autotitle(
    store: &dyn VelaStore,
    req: StoreConversationRefReq,
) -> IpcResult<ConversationRes> {
    let id = conversation_id(&req.conversation_id)?;
    let conversation = store.get_conversation(&id)?;
    if !is_placeholder_title(&conversation.title) {
        return Ok(ConversationRes {
            conversation: conversation.into(),
        });
    }

    // Reasoning is excluded on purpose. Naming a conversation after the model's
    // private thinking would put words in the sidebar that the user never saw
    // and the model never committed to.
    let derived = store
        .list_messages(&id, MessageQuery::without_reasoning().limited(8))?
        .into_iter()
        .find_map(|message| derive_title(&message.answer_text()));

    let Some(title) = derived else {
        return Ok(ConversationRes {
            conversation: conversation.into(),
        });
    };

    Ok(ConversationRes {
        conversation: store
            .update_conversation(
                &id,
                ConversationPatch {
                    title: Some(title),
                    ..ConversationPatch::default()
                },
            )?
            .into(),
    })
}

pub fn search(store: &dyn VelaStore, req: StoreSearchReq) -> IpcResult<StoreSearchRes> {
    let raw = req.query.trim();
    let limit = req
        .limit
        .unwrap_or(DEFAULT_SEARCH_LIMIT)
        .min(MAX_SEARCH_LIMIT);
    if raw.is_empty() {
        // An empty box is not a failed search. The sidebar's own list is the
        // answer to "show me everything".
        return Ok(StoreSearchRes {
            conversations: Vec::new(),
            messages: Vec::new(),
        });
    }

    let conversations = store
        .search_conversations(raw, limit)?
        .into_iter()
        .map(ConversationSummary::from)
        .collect();

    let messages = match fts_query(raw) {
        Some(expression) => store
            .search_messages(&expression, limit)?
            .into_iter()
            .map(|hit| MessageHit {
                message_id: hit.message_id.into_string(),
                conversation_id: hit.conversation_id.into_string(),
                conversation_title: hit.conversation_title,
                kind: match hit.kind {
                    SearchHitKind::Answer => MessageHitKind::Answer,
                    SearchHitKind::Reasoning => MessageHitKind::Reasoning,
                },
                snippet: hit.snippet,
                created_at_ms: hit.created_at.as_millis(),
            })
            .collect(),
        None => Vec::new(),
    };

    Ok(StoreSearchRes {
        conversations,
        messages,
    })
}

/* -------------------------------------------------------------------------- */
/* commands — thin adapters, nothing but extraction and delegation            */
/* -------------------------------------------------------------------------- */

#[tauri::command]
pub fn store_list_conversations(
    store: State<'_, StoreHandle>,
    payload: StoreListConversationsReq,
) -> IpcResult<ConversationListRes> {
    list(store.store(), payload)
}

#[tauri::command]
pub fn store_create_conversation(
    store: State<'_, StoreHandle>,
    payload: StoreCreateConversationReq,
) -> IpcResult<ConversationRes> {
    create(store.store(), payload)
}

#[tauri::command]
pub fn store_rename_conversation(
    store: State<'_, StoreHandle>,
    payload: StoreRenameConversationReq,
) -> IpcResult<ConversationRes> {
    rename(store.store(), payload)
}

#[tauri::command]
pub fn store_delete_conversation(
    store: State<'_, StoreHandle>,
    payload: StoreConversationRefReq,
) -> IpcResult<Ack> {
    delete(store.store(), payload)
}

#[tauri::command]
pub fn store_autotitle_conversation(
    store: State<'_, StoreHandle>,
    payload: StoreConversationRefReq,
) -> IpcResult<ConversationRes> {
    autotitle(store.store(), payload)
}

#[tauri::command]
pub fn store_search(
    store: State<'_, StoreHandle>,
    payload: StoreSearchReq,
) -> IpcResult<StoreSearchRes> {
    search(store.store(), payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::IpcErrorCode;
    use vela_store::{ContentPart, DatabaseLocation, MessageRepository, NewMessage, SqliteStore};

    fn store() -> SqliteStore {
        SqliteStore::open(DatabaseLocation::InMemory).expect("in-memory store opens")
    }

    fn new_chat(store: &SqliteStore) -> String {
        create(store, StoreCreateConversationReq::default())
            .unwrap()
            .conversation
            .id
    }

    #[test]
    fn a_new_conversation_is_a_placeholder_the_ui_can_recognise() {
        let store = store();
        let created = create(&store, StoreCreateConversationReq::default())
            .unwrap()
            .conversation;

        assert_eq!(created.title, UNTITLED_TITLE);
        assert!(created.title_is_placeholder);
        assert_eq!(created.message_count, 0);
        assert_eq!(created.last_message_at_ms, None);
    }

    #[test]
    fn the_summary_carries_no_backend_identity() {
        let store = store();
        let chat = ConversationId::new(new_chat(&store)).unwrap();
        store
            .append_message(
                NewMessage::assistant(chat.clone(), vec![ContentPart::text("hello")])
                    .with_model("some-runtime", "some-model"),
            )
            .unwrap();

        let listed = list(&store, StoreListConversationsReq::default()).unwrap();
        let json = serde_json::to_value(&listed).unwrap();
        let row = &json["conversations"][0];
        // The store knows. This wire type must not — a field the renderer can
        // read is a field the renderer will eventually branch on.
        assert!(row.get("providerId").is_none());
        assert!(row.get("modelId").is_none());
        assert_eq!(row["messageCount"], 1);
    }

    #[test]
    fn renaming_rejects_a_blank_title_rather_than_storing_one() {
        let store = store();
        let id = new_chat(&store);

        let error = rename(
            &store,
            StoreRenameConversationReq {
                conversation_id: id.clone(),
                title: "   ".into(),
            },
        )
        .unwrap_err();
        assert_eq!(error.code, IpcErrorCode::InvalidPayload);

        let renamed = rename(
            &store,
            StoreRenameConversationReq {
                conversation_id: id,
                title: "  Star   charts  ".into(),
            },
        )
        .unwrap()
        .conversation;
        assert_eq!(renamed.title, "Star charts");
        assert!(!renamed.title_is_placeholder);
    }

    #[test]
    fn deleting_an_unknown_conversation_is_not_found_not_a_silent_success() {
        let store = store();
        let error = delete(
            &store,
            StoreConversationRefReq {
                conversation_id: "conv_ghost".into(),
            },
        )
        .unwrap_err();
        assert_eq!(error.code, IpcErrorCode::NotFound);
    }

    #[test]
    fn deleting_removes_the_conversation_from_the_list() {
        let store = store();
        let id = new_chat(&store);
        delete(
            &store,
            StoreConversationRefReq {
                conversation_id: id.clone(),
            },
        )
        .unwrap();

        assert!(list(&store, StoreListConversationsReq::default())
            .unwrap()
            .conversations
            .is_empty());
    }

    #[test]
    fn autotitling_names_a_placeholder_after_the_first_thing_said_in_it() {
        let store = store();
        let id = new_chat(&store);
        let chat = ConversationId::new(id.clone()).unwrap();
        store
            .append_message(NewMessage::user(
                chat,
                "## Why is the night sky dark?\n\nOlbers' paradox, please.",
            ))
            .unwrap();

        let titled = autotitle(
            &store,
            StoreConversationRefReq {
                conversation_id: id,
            },
        )
        .unwrap()
        .conversation;

        assert_eq!(titled.title, "Why is the night sky dark?");
        assert!(!titled.title_is_placeholder);
    }

    #[test]
    fn autotitling_never_names_a_conversation_after_the_models_private_thinking() {
        let store = store();
        let id = new_chat(&store);
        let chat = ConversationId::new(id.clone()).unwrap();
        store
            .append_message(NewMessage::assistant(
                chat,
                vec![
                    ContentPart::reasoning("the user probably means Vega, not Vela"),
                    ContentPart::text("Vela is a southern constellation."),
                ],
            ))
            .unwrap();

        let titled = autotitle(
            &store,
            StoreConversationRefReq {
                conversation_id: id,
            },
        )
        .unwrap()
        .conversation;

        assert_eq!(titled.title, "Vela is a southern constellation.");
        assert!(!titled.title.contains("probably"));
    }

    #[test]
    fn autotitling_leaves_a_user_chosen_title_and_an_empty_conversation_alone() {
        let store = store();
        let id = new_chat(&store);
        rename(
            &store,
            StoreRenameConversationReq {
                conversation_id: id.clone(),
                title: "Mine".into(),
            },
        )
        .unwrap();
        let chat = ConversationId::new(id.clone()).unwrap();
        store
            .append_message(NewMessage::user(chat, "something else entirely"))
            .unwrap();

        let request = StoreConversationRefReq {
            conversation_id: id,
        };
        assert_eq!(
            autotitle(&store, request.clone())
                .unwrap()
                .conversation
                .title,
            "Mine"
        );

        let empty = new_chat(&store);
        let untouched = autotitle(
            &store,
            StoreConversationRefReq {
                conversation_id: empty,
            },
        )
        .unwrap()
        .conversation;
        assert_eq!(untouched.title, UNTITLED_TITLE);
        assert!(untouched.title_is_placeholder);
    }

    #[test]
    fn search_finds_a_title_the_content_index_cannot_and_labels_the_halves() {
        let store = store();
        let named = create(
            &store,
            StoreCreateConversationReq {
                title: Some("Rendering notes".into()),
            },
        )
        .unwrap()
        .conversation;
        let other = ConversationId::new(new_chat(&store)).unwrap();
        store
            .append_message(NewMessage::user(other, "how does rendering work"))
            .unwrap();

        let found = search(
            &store,
            StoreSearchReq {
                query: "rendering".into(),
                limit: None,
            },
        )
        .unwrap();

        assert_eq!(found.conversations.len(), 1);
        assert_eq!(found.conversations[0].id, named.id);
        assert_eq!(found.messages.len(), 1);
        assert!(found.messages[0].snippet.contains("[rendering]"));
        assert_eq!(found.messages[0].kind, MessageHitKind::Answer);
    }

    #[test]
    fn a_reasoning_hit_is_labelled_as_one() {
        let store = store();
        let chat = ConversationId::new(new_chat(&store)).unwrap();
        store
            .append_message(NewMessage::assistant(
                chat,
                vec![
                    ContentPart::reasoning("parallax puts it at 310 light years"),
                    ContentPart::text("About 310 light years."),
                ],
            ))
            .unwrap();

        let found = search(
            &store,
            StoreSearchReq {
                query: "parallax".into(),
                limit: None,
            },
        )
        .unwrap();
        assert_eq!(found.messages.len(), 1);
        assert_eq!(found.messages[0].kind, MessageHitKind::Reasoning);
    }

    #[test]
    fn a_query_the_fts_grammar_would_reject_still_searches() {
        let store = store();
        let chat = ConversationId::new(new_chat(&store)).unwrap();
        store
            .append_message(NewMessage::user(chat, "the deal with sails"))
            .unwrap();

        // Raw, this is `SQLITE_ERROR` from FTS5 — an unbalanced quote.
        assert!(store.search_messages("\"the deal", 10).is_err());

        let found = search(
            &store,
            StoreSearchReq {
                query: "\"the deal".into(),
                limit: None,
            },
        )
        .unwrap();
        assert_eq!(found.messages.len(), 1);
    }

    #[test]
    fn punctuation_alone_searches_titles_and_asks_nothing_of_the_content_index() {
        let store = store();
        create(
            &store,
            StoreCreateConversationReq {
                title: Some("100% context".into()),
            },
        )
        .unwrap();

        let found = search(
            &store,
            StoreSearchReq {
                query: "%".into(),
                limit: None,
            },
        )
        .unwrap();
        assert_eq!(found.conversations.len(), 1);
        assert!(found.messages.is_empty());
    }

    #[test]
    fn an_empty_query_is_an_empty_result_not_an_error() {
        let store = store();
        new_chat(&store);
        let found = search(
            &store,
            StoreSearchReq {
                query: "   ".into(),
                limit: None,
            },
        )
        .unwrap();
        assert!(found.conversations.is_empty());
        assert!(found.messages.is_empty());
    }

    #[test]
    fn a_prefix_matches_while_the_user_is_still_typing() {
        let store = store();
        let chat = ConversationId::new(new_chat(&store)).unwrap();
        store
            .append_message(NewMessage::user(chat, "constellation navigation"))
            .unwrap();

        for typed in ["const", "constell", "constellation nav"] {
            let found = search(
                &store,
                StoreSearchReq {
                    query: typed.into(),
                    limit: None,
                },
            )
            .unwrap();
            assert_eq!(found.messages.len(), 1, "`{typed}` found nothing");
        }
    }

    #[test]
    fn the_fts_rewrite_prefixes_only_the_last_term() {
        assert_eq!(fts_query("sails"), Some("\"sails\"*".into()));
        assert_eq!(
            fts_query("night sky"),
            Some("\"night\" AND \"sky\"*".into())
        );
        assert_eq!(fts_query("  ...  "), None);
        assert_eq!(fts_query(""), None);
    }
}
