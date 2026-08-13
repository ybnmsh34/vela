//! **The one content vocabulary at the IPC boundary.**
//!
//! # Why this module exists
//!
//! `ChatMessageInput` used to be `{ role, text: String }` and `build_request`
//! mapped every message to exactly one `ContentPart::Text`. The provider core
//! has carried images, reasoning blocks, tool calls and tool results since
//! Phase B, and `vela-store` has had a distinct reasoning content type since
//! Phase A — but neither could be *addressed* from the renderer, so no shipping
//! path could send a picture or produce a tool call no matter what the endpoint
//! supported. That is the composition-root defect in its second costume: two
//! rich models on either side of a boundary that only knew how to say `String`.
//!
//! [`ContentPartDto`] is the shape that crosses. It is deliberately **one**
//! type used by both directions — the chat request going out and the stored
//! transcript coming back — because two content vocabularies is how the two
//! sides drift apart again.
//!
//! # Bytes on the wire
//!
//! An image is `Vec<u8>` in both domain models and **standard base64** here.
//! Not a `data:` URL and not a file path: a `data:` prefix would make the
//! renderer responsible for a MIME string the host has to validate anyway, and
//! a path would be a dangling pointer the moment the user moves the file —
//! Vela is offline-first, so the bytes are the record.
//!
//! The codec is [`vela_providers::base64_encode`] / [`base64_decode`], the same
//! pair the wire encoders use, so an image cannot be re-encoded differently on
//! its way through the host.

use serde::{Deserialize, Serialize};

use super::{IpcError, IpcResult};

/// Largest single decoded image Vela will accept from the renderer. Comfortably
/// above a full-resolution screenshot, bounded so a runaway caller cannot ask
/// the host to allocate without limit.
pub const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;

/// Longest single text or reasoning part.
pub const MAX_TEXT_BYTES: usize = 1_048_576;

/// Most parts in one message.
pub const MAX_PARTS: usize = 256;

/// One piece of a message, as it crosses the IPC boundary.
///
/// Tagged with `kind`, matching both `vela_providers::ContentPart` and
/// `vela_store::ContentPart` so the renderer switches on one discriminant
/// everywhere.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ContentPartDto {
    /// Ordinary text. This — and only this — is the answer.
    Text { text: String },

    /// A reasoning / `<think>` block.
    ///
    /// **Carried and stored distinctly from the answer, never merged into it.**
    /// The schema has modelled it separately since Phase A precisely so the UI
    /// can collapse it, so it can be excluded from what is re-sent to a model,
    /// and so it can be exported or discarded on its own.
    Reasoning {
        text: String,
        /// Some backends sign reasoning blocks and require the signature back
        /// verbatim; round-tripping it is not optional.
        #[serde(default)]
        signature: Option<String>,
        /// The backend withheld the block; `text` is a placeholder, not
        /// thoughts.
        #[serde(default)]
        redacted: bool,
    },

    /// Inline image bytes, standard base64. See the module docs.
    Image { mime_type: String, data: String },

    /// The model asked to run a tool.
    ToolCall {
        call_id: String,
        name: String,
        arguments: serde_json::Value,
    },

    /// The outcome of a tool call. A failure is data, not an error: it belongs
    /// in the transcript and is usually fed back to the model.
    ToolResult {
        call_id: String,
        content: String,
        #[serde(default)]
        is_error: bool,
    },
}

impl ContentPartDto {
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text { text: text.into() }
    }

    pub fn reasoning(text: impl Into<String>) -> Self {
        Self::Reasoning {
            text: text.into(),
            signature: None,
            redacted: false,
        }
    }

    /// Validates the part and decodes its bytes. `where` names the field path
    /// so a rejection blames a coordinate the caller can find.
    fn decoded_image(mime_type: &str, data: &str, whose: &str) -> IpcResult<(String, Vec<u8>)> {
        let mime = mime_type.trim();
        if mime.is_empty() {
            return Err(IpcError::invalid(format!(
                "invalid {whose}.mimeType: must not be blank"
            )));
        }
        // Bound the *encoded* length first: decoding a gigabyte to find out it
        // is too big is the allocation the bound exists to prevent. Base64 is
        // 4 bytes per 3, so this is the smallest safe over-estimate.
        if data.len() > MAX_IMAGE_BYTES / 3 * 4 + 4 {
            return Err(IpcError::invalid(format!(
                "invalid {whose}.data: exceeds {MAX_IMAGE_BYTES} bytes"
            )));
        }
        let bytes = vela_providers::base64_decode(data).ok_or_else(|| {
            IpcError::invalid(format!("invalid {whose}.data: not standard base64"))
        })?;
        if bytes.len() > MAX_IMAGE_BYTES {
            return Err(IpcError::invalid(format!(
                "invalid {whose}.data: exceeds {MAX_IMAGE_BYTES} bytes"
            )));
        }
        if bytes.is_empty() {
            return Err(IpcError::invalid(format!(
                "invalid {whose}.data: must not be empty"
            )));
        }
        Ok((mime.to_owned(), bytes))
    }

    fn check_text(text: &str, whose: &str) -> IpcResult<()> {
        if text.len() > MAX_TEXT_BYTES {
            return Err(IpcError::invalid(format!(
                "invalid {whose}.text: exceeds {MAX_TEXT_BYTES} bytes"
            )));
        }
        Ok(())
    }

    fn check_call_id(call_id: &str, whose: &str) -> IpcResult<()> {
        if call_id.trim().is_empty() {
            return Err(IpcError::invalid(format!(
                "invalid {whose}.callId: must not be blank"
            )));
        }
        Ok(())
    }

    /// Toward the provider layer — what goes to the endpoint.
    pub fn to_provider_part(&self, whose: &str) -> IpcResult<vela_providers::ContentPart> {
        use vela_providers::ContentPart as Part;
        Ok(match self {
            Self::Text { text } => {
                Self::check_text(text, whose)?;
                Part::Text { text: text.clone() }
            }
            Self::Reasoning {
                text,
                signature,
                redacted,
            } => {
                Self::check_text(text, whose)?;
                Part::Reasoning {
                    text: text.clone(),
                    signature: signature.clone(),
                    redacted: *redacted,
                }
            }
            Self::Image { mime_type, data } => {
                let (mime_type, data) = Self::decoded_image(mime_type, data, whose)?;
                Part::Image { mime_type, data }
            }
            Self::ToolCall {
                call_id,
                name,
                arguments,
            } => {
                Self::check_call_id(call_id, whose)?;
                if name.trim().is_empty() {
                    return Err(IpcError::invalid(format!(
                        "invalid {whose}.name: must not be blank"
                    )));
                }
                Part::ToolCall {
                    call_id: call_id.clone(),
                    name: name.clone(),
                    arguments: arguments.clone(),
                }
            }
            Self::ToolResult {
                call_id,
                content,
                is_error,
            } => {
                Self::check_call_id(call_id, whose)?;
                Self::check_text(content, whose)?;
                Part::ToolResult {
                    call_id: call_id.clone(),
                    content: content.clone(),
                    is_error: *is_error,
                }
            }
        })
    }

    /// Toward the system of record — what gets written down.
    ///
    /// Separate from [`Self::to_provider_part`] and not routed through it: the
    /// two domain models are deliberately independent types (`vela-store` must
    /// not depend on the provider seam), and collapsing them here would
    /// reintroduce exactly that coupling.
    pub fn to_store_part(&self, whose: &str) -> IpcResult<vela_store::ContentPart> {
        use vela_store::ContentPart as Part;
        Ok(match self {
            Self::Text { text } => {
                Self::check_text(text, whose)?;
                Part::Text { text: text.clone() }
            }
            Self::Reasoning {
                text,
                signature,
                redacted,
            } => {
                Self::check_text(text, whose)?;
                Part::Reasoning {
                    text: text.clone(),
                    signature: signature.clone(),
                    redacted: *redacted,
                }
            }
            Self::Image { mime_type, data } => {
                let (mime_type, data) = Self::decoded_image(mime_type, data, whose)?;
                Part::Image { mime_type, data }
            }
            Self::ToolCall {
                call_id,
                name,
                arguments,
            } => {
                Self::check_call_id(call_id, whose)?;
                Part::ToolCall {
                    call_id: call_id.clone(),
                    name: name.clone(),
                    arguments: arguments.clone(),
                }
            }
            Self::ToolResult {
                call_id,
                content,
                is_error,
            } => {
                Self::check_call_id(call_id, whose)?;
                Self::check_text(content, whose)?;
                Part::ToolResult {
                    call_id: call_id.clone(),
                    content: content.clone(),
                    is_error: *is_error,
                }
            }
        })
    }
}

impl From<&vela_store::ContentPart> for ContentPartDto {
    fn from(part: &vela_store::ContentPart) -> Self {
        use vela_store::ContentPart as Part;
        match part {
            Part::Text { text } => Self::Text { text: text.clone() },
            Part::Reasoning {
                text,
                signature,
                redacted,
            } => Self::Reasoning {
                text: text.clone(),
                signature: signature.clone(),
                redacted: *redacted,
            },
            Part::Image { mime_type, data } => Self::Image {
                mime_type: mime_type.clone(),
                data: vela_providers::base64_encode(data),
            },
            Part::ToolCall {
                call_id,
                name,
                arguments,
            } => Self::ToolCall {
                call_id: call_id.clone(),
                name: name.clone(),
                arguments: arguments.clone(),
            },
            Part::ToolResult {
                call_id,
                content,
                is_error,
            } => Self::ToolResult {
                call_id: call_id.clone(),
                content: content.clone(),
                is_error: *is_error,
            },
        }
    }
}

/// Validates a part list and converts it for the provider layer.
pub fn to_provider_parts(
    parts: &[ContentPartDto],
    whose: &str,
) -> IpcResult<Vec<vela_providers::ContentPart>> {
    check_count(parts, whose)?;
    parts
        .iter()
        .enumerate()
        .map(|(index, part)| part.to_provider_part(&format!("{whose}.parts[{index}]")))
        .collect()
}

/// Validates a part list and converts it for the system of record.
pub fn to_store_parts(
    parts: &[ContentPartDto],
    whose: &str,
) -> IpcResult<Vec<vela_store::ContentPart>> {
    check_count(parts, whose)?;
    parts
        .iter()
        .enumerate()
        .map(|(index, part)| part.to_store_part(&format!("{whose}.parts[{index}]")))
        .collect()
}

fn check_count(parts: &[ContentPartDto], whose: &str) -> IpcResult<()> {
    if parts.len() > MAX_PARTS {
        return Err(IpcError::invalid(format!(
            "invalid {whose}.parts: at most {MAX_PARTS} parts per message"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::IpcErrorCode;

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

    fn image() -> ContentPartDto {
        ContentPartDto::Image {
            mime_type: "image/png".into(),
            data: vela_providers::base64_encode(PNG),
        }
    }

    #[test]
    fn an_image_reaches_the_provider_layer_as_the_bytes_that_went_in() {
        let part = image().to_provider_part("m").unwrap();
        assert_eq!(
            part,
            vela_providers::ContentPart::Image {
                mime_type: "image/png".into(),
                data: PNG.to_vec(),
            }
        );
    }

    #[test]
    fn an_image_reaches_the_store_as_the_bytes_that_went_in() {
        let part = image().to_store_part("m").unwrap();
        assert_eq!(
            part,
            vela_store::ContentPart::Image {
                mime_type: "image/png".into(),
                data: PNG.to_vec(),
            }
        );
    }

    #[test]
    fn a_stored_image_round_trips_back_out_byte_for_byte() {
        let stored = vela_store::ContentPart::Image {
            mime_type: "image/jpeg".into(),
            data: (0u8..=255).collect(),
        };
        let dto = ContentPartDto::from(&stored);
        assert_eq!(dto.to_store_part("m").unwrap(), stored);
    }

    #[test]
    fn reasoning_survives_as_reasoning_and_never_becomes_answer_text() {
        // The distinction the schema exists to keep. If this ever collapses,
        // private thinking is quoted back to the user as an answer.
        let dto = ContentPartDto::Reasoning {
            text: "let me count".into(),
            signature: Some("sig".into()),
            redacted: false,
        };
        let stored = dto.to_store_part("m").unwrap();
        assert!(stored.is_reasoning());
        assert!(matches!(
            stored,
            vela_store::ContentPart::Reasoning {
                signature: Some(_),
                ..
            }
        ));
        assert!(dto.to_provider_part("m").unwrap().is_reasoning());
    }

    #[test]
    fn the_wire_form_is_camel_case_and_tagged_by_kind() {
        let json = serde_json::to_value(image()).unwrap();
        assert_eq!(json["kind"], "image");
        assert_eq!(json["mimeType"], "image/png");

        let json = serde_json::to_value(ContentPartDto::ToolResult {
            call_id: "c1".into(),
            content: "42".into(),
            is_error: false,
        })
        .unwrap();
        assert_eq!(json["kind"], "toolResult");
        assert_eq!(json["callId"], "c1");
        assert_eq!(json["isError"], false);
    }

    #[test]
    fn a_part_that_is_not_base64_is_an_invalid_payload_naming_its_coordinate() {
        let error = ContentPartDto::Image {
            mime_type: "image/png".into(),
            data: "not base64!!".into(),
        }
        .to_provider_part("messages[2].parts[0]")
        .unwrap_err();
        assert_eq!(error.code, IpcErrorCode::InvalidPayload);
        assert!(
            error.message.contains("messages[2].parts[0].data"),
            "{}",
            error.message
        );
    }

    #[test]
    fn an_image_with_no_mime_type_is_rejected() {
        let error = ContentPartDto::Image {
            mime_type: "  ".into(),
            data: vela_providers::base64_encode(PNG),
        }
        .to_store_part("m")
        .unwrap_err();
        assert!(error.message.contains("mimeType"), "{}", error.message);
    }

    #[test]
    fn an_oversized_image_is_refused_before_it_is_decoded() {
        // The encoded bound fires first: the point is that the host never
        // allocates the decoded gigabyte in order to reject it.
        let error = ContentPartDto::Image {
            mime_type: "image/png".into(),
            data: "A".repeat(MAX_IMAGE_BYTES * 2),
        }
        .to_provider_part("m")
        .unwrap_err();
        assert_eq!(error.code, IpcErrorCode::InvalidPayload);
        assert!(error.message.contains("exceeds"), "{}", error.message);
    }

    #[test]
    fn a_tool_result_with_no_call_id_cannot_be_correlated_and_is_refused() {
        for part in [
            ContentPartDto::ToolResult {
                call_id: " ".into(),
                content: "x".into(),
                is_error: false,
            },
            ContentPartDto::ToolCall {
                call_id: "".into(),
                name: "f".into(),
                arguments: serde_json::json!({}),
            },
        ] {
            let error = part.to_provider_part("m").unwrap_err();
            assert!(error.message.contains("callId"), "{}", error.message);
        }
    }

    #[test]
    fn too_many_parts_is_refused_as_a_list_and_not_part_by_part() {
        let parts = vec![ContentPartDto::text("x"); MAX_PARTS + 1];
        let error = to_provider_parts(&parts, "messages[0]").unwrap_err();
        assert!(error.message.contains("at most"), "{}", error.message);
        assert!(to_store_parts(&parts, "messages[0]").is_err());
    }

    #[test]
    fn an_empty_image_payload_is_refused_rather_than_stored_as_a_zero_byte_picture() {
        let error = ContentPartDto::Image {
            mime_type: "image/png".into(),
            data: String::new(),
        }
        .to_store_part("m")
        .unwrap_err();
        assert!(error.message.contains("must not be empty"));
    }
}
