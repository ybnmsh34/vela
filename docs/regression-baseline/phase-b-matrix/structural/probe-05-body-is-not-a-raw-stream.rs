// GATE M Part 1, round 3 — executor's structural probe 05.
//
// CLAIM UNDER TEST: a `BodyStream` is not itself a `ByteStream`, so it cannot
// be passed into a position that reads raw bytes. If it were, laundering would
// be trivial: hand the sealed body to anything taking `impl ByteStream` and
// read it there, or re-wrap it with an origin that claims no credential and
// have the outer read bypass the inner one.
//
// EXPECTED: does not compile, E0277.
use vela_providers::http::{ByteStream, HttpResponse, TransportError};

async fn read_raw(mut stream: impl ByteStream) -> Result<Option<Vec<u8>>, TransportError> {
    stream.next_chunk().await
}

async fn launder(response: HttpResponse) -> Result<Option<Vec<u8>>, TransportError> {
    read_raw(response.body).await
}

fn main() {
    let _ = launder;
}
