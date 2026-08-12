//! # The OpenAI-compatible adapter
//!
//! One wire protocol, five server families that implement it differently:
//! llama.cpp, Ollama, LM Studio, vLLM, and everything else that answers
//! `POST /v1/chat/completions`. This is how most people will run Vela, so the
//! divergences between those servers are handled here rather than being left
//! for the user to discover.
//!
//! ## What this module adds on top of the core backend
//!
//! [`OpenAiCompatibleProvider`](crate::openai_compatible::OpenAiCompatibleProvider)
//! already speaks the protocol and owns every normalisation rule the mock
//! matrix forced on us. This adapter wraps it and supplies the four things that
//! differ *between servers* rather than between requests:
//!
//! | Divergence | What this module does |
//! |---|---|
//! | `/v1/models` has at least four shapes | one parser that reads all of them, and a listing that falls back to a server's native endpoint when the OpenAI one is absent |
//! | Only llama.cpp serves `/props`; only Ollama serves `/api/tags`; only LM Studio serves `/api/v0/models` | discovery probes each one and *identifies the server by what it answers*, never by a name the user typed |
//! | Error bodies are not the OpenAI shape on three of the five | [`normalise_error_body`] rewrites them into it before the core's mapper sees them, so a recoverable failure stays recoverable |
//! | A server may declare nothing at all | conservative defaults: a capability is left [`Unknown`](crate::capability::Support::Unknown), and an unknown capability is not offerable |
//!
//! ## The two rules this module is built on
//!
//! 1. **A declaration may withdraw an affordance; it may never grant one.**
//!    Ollama's `/api/show` will happily tell you a model has `tools`. That is a
//!    claim about a *model file*, not about the server's ability to emit a
//!    well-formed `tool_calls` array, and MEASURED-5 is the standing proof that
//!    an endpoint's claims about itself are not evidence. So a declaration can
//!    only ever move a capability to [`Unsupported`](crate::capability::Support::Unsupported)
//!    — which withdraws an affordance, or switches tool calling to prompt
//!    emulation. Raising a capability requires a behavioural probe.
//!    `structured_output` is excluded from declarations entirely: its failure is
//!    silent, so nothing but a validated answer may raise or lower it.
//! 2. **The flavour is a diagnostic, never a branch the user can feel.** It
//!    selects which *detail endpoint* to ask; it never selects a capability, a
//!    degradation, or anything that reaches the renderer. `conventions.md` §0.3
//!    is enforced here by [`provider::tests::no_server_identity_reaches_the_ui`].
//!
//! ## Honesty
//!
//! Everything in this module has been exercised against the four mock-matrix
//! profiles and against scripted byte sequences. Per `conventions.md` §10 that
//! makes every result **VERIFIED-BY-FAKE**. No real llama.cpp, Ollama, vLLM or
//! LM Studio server was reached from this container; the shapes this module
//! parses come from those projects' documented responses, and the *only*
//! shapes proven end-to-end are the mock matrix's.

mod discovery;
mod error_shapes;
mod flavour;
mod provider;

pub use discovery::{DeclaredFacts, ServerFacts};
pub use error_shapes::{normalise_error_body, NormalisingTransport};
pub use flavour::ServerFlavour;
pub use provider::{CompatOptions, CompatProvider};
