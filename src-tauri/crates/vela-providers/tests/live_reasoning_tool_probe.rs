//! **Live endpoint. `#[ignore]`d, and it must stay that way.**
//!
//! The capability probe's tool step was reading a budget-truncated answer as
//! proof that an endpoint cannot call tools. Nothing in the mock matrix
//! reproduces it — no mock profile is a reasoning model that spends its whole
//! `max_tokens` on `reasoning_content` — so the only place the defect was
//! visible was a real reasoning model on real hardware.
//!
//! This test is that vantage point. It is not part of the default suite: it
//! needs a server, it costs real generation time, and a machine without one
//! must not go red. Run it deliberately:
//!
//! ```text
//! VELA_LIVE_BASE_URL=http://127.0.0.1:8033/v1 \
//! VELA_LIVE_MODEL_ID='unsloth/Qwen3.6-27B-GGUF:Q5_K_M' \
//!   cargo test -p vela-providers --test live_reasoning_tool_probe -- --ignored --nocapture
//! ```
//!
//! With `VELA_LIVE_BASE_URL` unset the body does nothing and says so, so
//! `--ignored` on a bare checkout is quiet rather than red.

use std::sync::Arc;

use vela_core::credential::Auth;
use vela_core::provider::{ProviderDescriptor, ProviderKind};
use vela_providers::capability::{Evidence, Support};
use vela_providers::http::ReqwestTransport;
use vela_providers::openai_compatible::OpenAiCompatibleProvider;
use vela_providers::{Capability, Provider, RequestContext, Timeouts};
use vela_secrets::MemoryStore;

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires a live OpenAI-compatible endpoint; set VELA_LIVE_BASE_URL"]
async fn a_live_reasoning_model_is_probed_as_tool_calling() {
    let Ok(base_url) = std::env::var("VELA_LIVE_BASE_URL") else {
        eprintln!("VELA_LIVE_BASE_URL unset — nothing was probed and nothing is claimed");
        return;
    };
    let model_id = std::env::var("VELA_LIVE_MODEL_ID")
        .expect("VELA_LIVE_MODEL_ID must name the model the endpoint serves");

    let provider = OpenAiCompatibleProvider::new(
        ProviderDescriptor::new("live", "Live", ProviderKind::Local).unwrap(),
        base_url,
        Auth::None,
        Arc::new(MemoryStore::new()),
        Arc::new(ReqwestTransport::new().unwrap()),
    );

    // `Timeouts::probing()` on purpose — it is what `ipc::models` gives the
    // real probe, so the deadlines the retry has to live inside are the user's
    // own and not a number chosen to make this test pass.
    let context = RequestContext::new().with_timeouts(Timeouts::probing());

    let capabilities = provider
        .probe_capabilities(&model_id, &context)
        .await
        .expect("the probe itself must not fail");

    println!(
        "{}",
        serde_json::to_string_pretty(&capabilities).expect("capabilities serialise")
    );

    assert_eq!(
        capabilities.tool_calling,
        Support::Supported,
        "this endpoint tool-calls; a truncated probe answer must never withdraw that"
    );
    let finding = capabilities
        .findings
        .iter()
        .rev()
        .find(|finding| finding.capability == Capability::ToolCalling)
        .expect("the tool step records a finding");
    assert_eq!(finding.evidence, Evidence::Probed);
}
