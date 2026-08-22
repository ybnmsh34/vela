// GATE M Part 1, round 3 — executor's structural probe 02.
//
// CLAIM UNDER TEST: the method whose omission disabled redaction cannot even be
// declared, so "forgot to forward `scrubber()`" — the literal round-2 recorder
// bug — is not a thing a body can do.
//
// EXPECTED: does not compile, E0407.
use vela_providers::http::{ByteStream, TransportError};
use vela_providers::redact::Scrubber;

struct Forgetful;

#[async_trait::async_trait]
impl ByteStream for Forgetful {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, TransportError> {
        Ok(None)
    }

    fn scrubber(&self) -> Scrubber {
        Scrubber::none()
    }
}

fn main() {
    let _ = Forgetful;
}
