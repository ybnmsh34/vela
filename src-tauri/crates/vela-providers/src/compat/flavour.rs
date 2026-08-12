//! Which server family is answering — established by what it serves, never by
//! what the user called it.
//!
//! Each family is identified by an endpoint or a field that only it has. That
//! matters more than it looks: a user who points Vela at "Ollama" and is
//! actually running llama.cpp behind a reverse proxy must still get correct
//! behaviour, and a user who mislabels their endpoint must not get a *worse*
//! one. Detection is evidence; the label is decoration.

use serde_json::Value;

/// The server families this adapter knows how to interrogate.
///
/// This is a **diagnostic**, not a capability. Nothing user-visible branches on
/// it, and it never reaches the renderer: see the `to_descriptor` rule in
/// [`crate::capability`] and `conventions.md` §0.3.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ServerFlavour {
    /// Speaks `/v1/chat/completions` and nothing else we recognise. Hosted APIs
    /// land here, and so does any runtime we have not met.
    #[default]
    Generic,
    /// Serves `/props` at the origin, with the loaded slot's `n_ctx`.
    LlamaCpp,
    /// Serves the native `/api/tags` and `/api/show` alongside its OpenAI shim.
    Ollama,
    /// Serves `/api/v0/models`, which carries per-model context lengths and the
    /// currently loaded window.
    LmStudio,
    /// Reports `max_model_len` on each `/v1/models` entry.
    VLlm,
}

impl ServerFlavour {
    /// A stable identifier for logs and test assertions. Never rendered.
    pub const fn code(self) -> &'static str {
        match self {
            ServerFlavour::Generic => "generic",
            ServerFlavour::LlamaCpp => "llama.cpp",
            ServerFlavour::Ollama => "ollama",
            ServerFlavour::LmStudio => "lm-studio",
            ServerFlavour::VLlm => "vllm",
        }
    }

    pub const fn is_known(self) -> bool {
        !matches!(self, ServerFlavour::Generic)
    }
}

impl std::fmt::Display for ServerFlavour {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}

/// Does this body look like llama.cpp's `/props`?
///
/// Keyed on three fields rather than one because a reverse proxy that answers
/// `{}` to everything must not be mistaken for a model server.
pub fn is_llama_cpp_props(value: &Value) -> bool {
    value.get("default_generation_settings").is_some()
        || (value.get("total_slots").is_some() && value.get("model_path").is_some())
        || (value.get("chat_template").is_some() && value.get("build_info").is_some())
}

/// Does this body look like Ollama's native `/api/tags`?
pub fn is_ollama_tags(value: &Value) -> bool {
    value
        .get("models")
        .and_then(Value::as_array)
        .is_some_and(|models| {
            models.is_empty()
                || models
                    .iter()
                    .any(|entry| entry.get("name").is_some() || entry.get("model").is_some())
        })
}

/// Does this body look like LM Studio's `/api/v0/models`?
///
/// Its entries carry loading state and quantisation, which no other server
/// reports on a model list.
pub fn is_lm_studio_models(value: &Value) -> bool {
    value
        .get("data")
        .and_then(Value::as_array)
        .is_some_and(|entries| {
            entries.iter().any(|entry| {
                entry.get("max_context_length").is_some()
                    || entry.get("loaded_context_length").is_some()
                    || (entry.get("quantization").is_some() && entry.get("publisher").is_some())
            })
        })
}

/// A hint drawn from a plain `/v1/models` body.
///
/// `max_model_len` is vLLM's; `owned_by` is a weak signal, so it only ever
/// produces a hint that reorders the remaining probes — never a conclusion.
pub fn hint_from_models(value: &Value) -> Option<ServerFlavour> {
    let entries = value.get("data").and_then(Value::as_array)?;
    for entry in entries {
        if entry.get("max_model_len").is_some() {
            return Some(ServerFlavour::VLlm);
        }
        let owner = entry
            .get("owned_by")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        match owner.as_str() {
            "vllm" => return Some(ServerFlavour::VLlm),
            // Ollama's shim stamps every model with this.
            "library" => return Some(ServerFlavour::Ollama),
            "organization_owner" => return Some(ServerFlavour::LmStudio),
            _ => {}
        }
        if owner.contains("llamacpp") || owner.contains("llama.cpp") {
            return Some(ServerFlavour::LlamaCpp);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_proxy_that_answers_an_empty_object_is_not_mistaken_for_a_model_server() {
        assert!(!is_llama_cpp_props(&json!({})));
        assert!(!is_ollama_tags(&json!({})));
        assert!(!is_lm_studio_models(&json!({})));
        assert_eq!(hint_from_models(&json!({})), None);
    }

    #[test]
    fn the_matrix_props_body_identifies_a_llama_cpp_shaped_server() {
        // Verbatim shape from tests/harness/mock-provider/src/server.ts.
        let props = json!({
            "default_generation_settings": {"n_ctx": 8192, "model": "m", "seed": 4294967295u32},
            "total_slots": 4,
            "model_path": "/models/m.gguf",
            "chat_template": "{}",
            "build_info": "vela-mock-provider"
        });
        assert!(is_llama_cpp_props(&props));
    }

    #[test]
    fn each_family_is_identified_by_a_field_only_it_reports() {
        assert!(is_ollama_tags(
            &json!({"models": [{"name": "llama3.1:8b", "model": "llama3.1:8b"}]})
        ));
        assert!(is_lm_studio_models(&json!({
            "data": [{"id": "qwen", "max_context_length": 32768, "loaded_context_length": 4096}]
        })));
        assert_eq!(
            hint_from_models(&json!({"data": [{"id": "m", "max_model_len": 8192}]})),
            Some(ServerFlavour::VLlm)
        );
        // A llama.cpp-shaped listing is not an Ollama-shaped one and vice versa.
        assert!(!is_lm_studio_models(
            &json!({"data": [{"id": "m", "object": "model", "owned_by": "x"}]})
        ));
    }

    #[test]
    fn an_unrecognised_server_stays_generic_rather_than_being_guessed() {
        assert_eq!(
            hint_from_models(&json!({"data": [{"id": "gpt-4o", "owned_by": "system"}]})),
            None
        );
        assert!(!ServerFlavour::Generic.is_known());
    }
}
