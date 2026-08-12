//! A deliberately tolerant Server-Sent Events decoder.
//!
//! # THE LOAD-BEARING RULES OF THIS FILE (MEASURED-1 and MEASURED-2)
//!
//! 1. **End-of-body is the terminator.** This decoder has no opinion about
//!    `[DONE]`; it reports it as a flag on the frame and keeps going. The
//!    `hostile` profile never sends one, and a consumer that waited for it
//!    timed out at 5003 ms.
//! 2. **A frame that will not parse is skipped, not fatal.** The decoder's job
//!    ends at "here is the payload text"; JSON validity is the caller's problem
//!    and a caller that treats it as fatal loses everything that already
//!    arrived — the recorded loss was 318 of 349 characters.
//! 3. **Bytes arrive in arbitrary chunks.** Frames, lines, UTF-8 sequences and
//!    tags all split across TCP reads. The decoder buffers and never assumes a
//!    chunk boundary is a frame boundary.

/// One dispatched SSE frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseFrame {
    /// The `event:` field, when present.
    pub event: Option<String>,
    /// The joined `data:` lines. Multiple `data:` lines join with `\n`, per spec.
    pub data: String,
}

impl SseFrame {
    /// Is this the optional `data: [DONE]` sentinel?
    ///
    /// A *hint*, never a terminator. Named to make that read at the call site.
    pub fn is_done_hint(&self) -> bool {
        self.data.trim() == "[DONE]"
    }
}

/// Incremental SSE decoder. Feed it bytes; take frames out.
#[derive(Debug, Default)]
pub struct SseDecoder {
    /// Undispatched bytes: everything after the last frame terminator.
    buffer: String,
    /// Bytes that did not form a complete UTF-8 sequence in the last chunk.
    partial_utf8: Vec<u8>,
}

impl SseDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Push a chunk of body bytes and take every frame it completed.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<SseFrame> {
        self.partial_utf8.extend_from_slice(bytes);
        // Decode as much valid UTF-8 as we can and keep the tail for next time:
        // a multi-byte character split across a TCP read must not become a
        // replacement character in the middle of the user's answer.
        let (decoded, rest) = split_valid_utf8(&self.partial_utf8);
        self.buffer.push_str(&decoded);
        self.partial_utf8 = rest;

        let mut frames = Vec::new();
        while let Some(end) = find_frame_end(&self.buffer) {
            let (frame_text, terminator_len) = end;
            let raw: String = self.buffer.drain(..frame_text).collect();
            self.buffer.drain(..terminator_len);
            if let Some(frame) = parse_frame(&raw) {
                frames.push(frame);
            }
        }
        frames
    }

    /// End of body. Dispatches any trailing frame that never got its blank
    /// line — real servers truncate, and throwing the last frame away would be
    /// exactly the data loss MEASURED-2 is about.
    pub fn finish(&mut self) -> Vec<SseFrame> {
        // Undecodable trailing bytes are dropped deliberately: they are, by
        // definition, an incomplete character.
        self.partial_utf8.clear();
        let rest = std::mem::take(&mut self.buffer);
        parse_frame(&rest).into_iter().collect()
    }
}

/// Returns `(bytes_before_terminator, terminator_len)` for the first frame end.
fn find_frame_end(buffer: &str) -> Option<(usize, usize)> {
    let bytes = buffer.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\n' {
            if bytes.get(i + 1) == Some(&b'\n') {
                return Some((i, 2));
            }
            if bytes.get(i + 1) == Some(&b'\r') && bytes.get(i + 2) == Some(&b'\n') {
                return Some((i, 3));
            }
        }
        if bytes[i] == b'\r' && bytes.get(i + 1) == Some(&b'\n') {
            if bytes.get(i + 2) == Some(&b'\n') {
                return Some((i, 3));
            }
            if bytes.get(i + 2) == Some(&b'\r') && bytes.get(i + 3) == Some(&b'\n') {
                return Some((i, 4));
            }
        }
        i += 1;
    }
    None
}

fn parse_frame(raw: &str) -> Option<SseFrame> {
    let mut data_lines: Vec<&str> = Vec::new();
    let mut event = None;
    for line in raw.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() {
            continue;
        }
        // A line starting with ':' is a comment — keepalives arrive this way,
        // and `hostile` sends one mid-stream.
        if line.starts_with(':') {
            continue;
        }
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line, ""),
        };
        match field {
            "data" => data_lines.push(value),
            "event" => event = Some(value.to_owned()),
            // `id`, `retry` and anything unknown are ignored, per spec.
            _ => {}
        }
    }
    if data_lines.is_empty() {
        return None;
    }
    Some(SseFrame {
        event,
        data: data_lines.join("\n"),
    })
}

/// Splits a byte buffer into (valid UTF-8 prefix, undecodable tail).
fn split_valid_utf8(bytes: &[u8]) -> (String, Vec<u8>) {
    match std::str::from_utf8(bytes) {
        Ok(text) => (text.to_owned(), Vec::new()),
        Err(error) => {
            let valid_up_to = error.valid_up_to();
            let text = String::from_utf8_lossy(&bytes[..valid_up_to]).into_owned();
            match error.error_len() {
                // Truly invalid bytes: drop them rather than stall forever
                // waiting for a continuation that will never be valid.
                Some(len) => {
                    let (_, tail) = split_valid_utf8(&bytes[valid_up_to + len..]);
                    (text, tail)
                }
                // Incomplete sequence at the end: keep it for the next chunk.
                None => (text, bytes[valid_up_to..].to_vec()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data_of(frames: &[SseFrame]) -> Vec<&str> {
        frames.iter().map(|frame| frame.data.as_str()).collect()
    }

    #[test]
    fn frames_split_across_arbitrary_byte_boundaries_are_reassembled() {
        let body = "data: {\"a\":1}\n\ndata: {\"b\":2}\n\n";
        let mut decoder = SseDecoder::new();
        let mut frames = Vec::new();
        // One byte at a time — the worst boundary a socket can hand us.
        for byte in body.as_bytes() {
            frames.extend(decoder.push(&[*byte]));
        }
        frames.extend(decoder.finish());
        assert_eq!(data_of(&frames), vec!["{\"a\":1}", "{\"b\":2}"]);
    }

    #[test]
    fn a_multi_byte_character_split_across_chunks_is_not_corrupted() {
        // "▒" is three bytes; the split lands in the middle of it.
        let body = "data: ▒▒ ok\n\n".as_bytes().to_vec();
        let mut decoder = SseDecoder::new();
        let mut frames = decoder.push(&body[..8]);
        frames.extend(decoder.push(&body[8..]));
        frames.extend(decoder.finish());
        assert_eq!(data_of(&frames), vec!["▒▒ ok"]);
    }

    #[test]
    fn comments_and_keepalives_are_dropped_without_dropping_the_stream() {
        let mut decoder = SseDecoder::new();
        let frames = decoder.push(b": keepalive\n\ndata: real\n\n");
        assert_eq!(data_of(&frames), vec!["real"]);
    }

    #[test]
    fn the_done_sentinel_is_a_flag_not_a_terminator() {
        let mut decoder = SseDecoder::new();
        let frames = decoder.push(b"data: [DONE]\n\ndata: after\n\n");
        assert!(frames[0].is_done_hint());
        assert_eq!(
            frames.len(),
            2,
            "a decoder that stops at [DONE] would drop what follows it"
        );
    }

    #[test]
    fn a_trailing_frame_with_no_blank_line_is_still_delivered() {
        let mut decoder = SseDecoder::new();
        assert!(decoder.push(b"data: truncated").is_empty());
        let frames = decoder.finish();
        assert_eq!(
            data_of(&frames),
            vec!["truncated"],
            "MEASURED-2: what arrived is never thrown away"
        );
    }

    #[test]
    fn crlf_terminators_are_understood() {
        let mut decoder = SseDecoder::new();
        let frames = decoder.push(b"data: a\r\n\r\ndata: b\r\n\r\n");
        assert_eq!(data_of(&frames), vec!["a", "b"]);
    }

    #[test]
    fn multiple_data_lines_in_one_frame_join_with_newlines() {
        let mut decoder = SseDecoder::new();
        let frames = decoder.push(b"data: one\ndata: two\n\n");
        assert_eq!(data_of(&frames), vec!["one\ntwo"]);
    }
}
