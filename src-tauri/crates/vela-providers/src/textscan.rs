//! Scanning a text stream for markers that may be split across chunk
//! boundaries.
//!
//! Two functions, shared by the reasoning splitter and the emulated-tool-call
//! stripper because both face the identical problem MEASURED-3 recorded: the
//! marker they are looking for is not guaranteed to arrive inside one frame.
//! [`held_back`] is the whole trick — emit everything that *cannot* be the
//! start of a marker, and keep the few bytes that still could be.

/// First occurrence of any needle: `(byte offset, needle index, needle len)`.
pub(crate) fn first_match(haystack: &str, needles: &[&str]) -> Option<(usize, usize, usize)> {
    let mut best: Option<(usize, usize, usize)> = None;
    for (index, needle) in needles.iter().enumerate() {
        if let Some(at) = haystack.find(needle) {
            if best.is_none_or(|(current, _, _)| at < current) {
                best = Some((at, index, needle.len()));
            }
        }
    }
    best
}

/// How many trailing bytes of `buffer` must be held back because they could
/// still turn into one of `candidates`.
///
/// `</thi` is held; `nk>` completes it on the next frame; nothing leaks in
/// between.
pub(crate) fn held_back(buffer: &str, candidates: &[&str]) -> usize {
    let mut hold = 0;
    for candidate in candidates {
        // Longest *proper* prefix of `candidate` that is a suffix of `buffer`.
        // Proper: a complete marker would already have been found by `find`.
        let max = candidate.len().saturating_sub(1).min(buffer.len());
        for len in (1..=max).rev() {
            if len > hold && buffer.is_char_boundary(buffer.len() - len) {
                let tail = &buffer[buffer.len() - len..];
                if candidate.starts_with(tail) {
                    hold = len;
                    break;
                }
            }
        }
    }
    hold
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_partial_marker_at_the_end_is_held_back_whole() {
        assert_eq!(held_back("answer </thi", &["</think>"]), 5);
        assert_eq!(held_back("answer <", &["<think>", "</think>"]), 1);
    }

    #[test]
    fn text_that_cannot_become_a_marker_is_never_held() {
        assert_eq!(held_back("3 < 4 and 5 > 2", &["<think>"]), 0);
        assert_eq!(held_back("", &["<think>"]), 0);
    }

    #[test]
    fn the_earliest_needle_wins_regardless_of_declaration_order() {
        assert_eq!(
            first_match("aa</think>bb<think>", &["<think>", "</think>"]),
            Some((2, 1, 8))
        );
    }
}
