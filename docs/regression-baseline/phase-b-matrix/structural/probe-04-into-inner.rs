// GATE M Part 1, round 3 — executor's structural probe 04.
//
// CLAIM UNDER TEST: there is no consuming accessor that hands back the sealed
// stream. A single `into_inner()` would undo the whole design without touching
// a field's visibility.
//
// EXPECTED: does not compile, E0599.
use vela_providers::http::{ByteStream, HttpResponse};

fn unseal(response: HttpResponse) -> Box<dyn ByteStream> {
    response.body.into_inner()
}

fn main() {
    let _ = unseal;
}
