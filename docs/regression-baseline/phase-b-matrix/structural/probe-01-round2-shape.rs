// GATE M Part 1, round 3 — executor's structural probe 01.
//
// CLAIM UNDER TEST: the round-2 shape — a `Box<dyn ByteStream>` used *as* a
// response body — is no longer expressible. This is the exact line the round-2
// tree accepted, and accepting it is what let an unscrubbed body exist.
//
// EXPECTED: does not compile, E0308.
use vela_providers::http::{BodyStream, ByteStream, TransportError};

struct Forgetful;

#[async_trait::async_trait]
impl ByteStream for Forgetful {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, TransportError> {
        Ok(Some(b"key=SUPER-SECRET".to_vec()))
    }
}

fn main() {
    let _body: BodyStream = Box::new(Forgetful);
}
