// GATE M Part 1, round 3 — executor's structural probe 03.
//
// CLAIM UNDER TEST: the raw stream a `BodyStream` seals cannot be reached
// through the struct. A decorator that could touch it would simply take the
// unscrubbed door and "next_chunk is the one exit" would be prose.
//
// NOTE ON THIS PROBE'S OWN HISTORY: probes 03/04/05 were one file until the
// controls run, where unsealing the field left the bundle still failing on the
// other two hatches — so the probe reported "rejected" against a tree that had
// the hole. One hatch per file, one verdict per hatch.
//
// EXPECTED: does not compile, E0616.
use vela_providers::http::{ByteStream, HttpResponse};

async fn reach_around(response: HttpResponse) -> Option<Vec<u8>> {
    let mut body = response.body;
    let raw: &mut Box<dyn ByteStream> = &mut body.inner;
    raw.next_chunk().await.ok().flatten()
}

fn main() {
    let _ = reach_around;
}
