//! A forgiving JSON reader, used **only** for text a model wrote.
//!
//! # Why this exists, and where it must never be used
//!
//! Endpoints that have no native tool calling can still be given tools — by
//! putting the catalogue in the prompt and reading the call back out of the
//! answer (see [`crate::emulation`]). What comes back is written by a language
//! model, and small models routinely emit `{name: get_weather, arguments:
//! {city: berlin}}` — bare keys, bare values, single quotes, a trailing comma.
//! Strict `serde_json` rejects all of it, which would make tool emulation fail
//! for exactly the models that need it most.
//!
//! **This is never used on an endpoint's protocol JSON.** Response envelopes,
//! SSE frames and error bodies are parsed strictly: being generous there would
//! mean silently accepting a malformed protocol, which is how a client ends up
//! executing a tool call the server never made. Strict for machines, lenient
//! for prose — and only in that direction.

use serde_json::{Map, Value};

/// Parse text a model produced. Strict JSON is tried first and is always
/// preferred; the relaxed reader only sees text `serde_json` refused.
pub fn parse_relaxed(text: &str) -> Result<Value, String> {
    if let Ok(value) = serde_json::from_str::<Value>(text) {
        return Ok(value);
    }
    let mut parser = Parser {
        bytes: text.as_bytes(),
        pos: 0,
    };
    parser.skip_ws();
    // The relaxed path only ever reads a composite. A bare word is not a tool
    // call, and accepting one here would turn `not-json-at-all` — which the
    // `hostile` profile really sends — into the string "not-json-at-all"
    // masquerading as a parsed value.
    if !matches!(parser.peek(), Some(b'{') | Some(b'[')) {
        return Err("expected an object or array".to_owned());
    }
    let value = parser.value()?;
    parser.skip_ws();
    if parser.pos < parser.bytes.len() {
        return Err(format!("trailing input at byte {}", parser.pos));
    }
    Ok(value)
}

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(b) if b.is_ascii_whitespace()) {
            self.pos += 1;
        }
    }

    fn value(&mut self) -> Result<Value, String> {
        self.skip_ws();
        match self.peek() {
            Some(b'{') => self.object(),
            Some(b'[') => self.array(),
            Some(b'"') | Some(b'\'') => self.string().map(Value::String),
            None => Err("unexpected end of input".to_owned()),
            _ => self.bareword(),
        }
    }

    fn object(&mut self) -> Result<Value, String> {
        self.pos += 1; // '{'
        let mut map = Map::new();
        loop {
            self.skip_ws();
            match self.peek() {
                Some(b'}') => {
                    self.pos += 1;
                    return Ok(Value::Object(map));
                }
                Some(b',') => {
                    self.pos += 1; // tolerate a leading or doubled comma
                    continue;
                }
                None => return Err("unterminated object".to_owned()),
                _ => {}
            }
            let key = match self.peek() {
                Some(b'"') | Some(b'\'') => self.string()?,
                _ => self.raw_until(b":")?.trim().to_owned(),
            };
            self.skip_ws();
            if self.peek() != Some(b':') {
                return Err(format!("expected ':' after key `{key}`"));
            }
            self.pos += 1;
            let value = self.value()?;
            map.insert(key, value);
        }
    }

    fn array(&mut self) -> Result<Value, String> {
        self.pos += 1; // '['
        let mut items = Vec::new();
        loop {
            self.skip_ws();
            match self.peek() {
                Some(b']') => {
                    self.pos += 1;
                    return Ok(Value::Array(items));
                }
                Some(b',') => {
                    self.pos += 1;
                    continue;
                }
                None => return Err("unterminated array".to_owned()),
                _ => items.push(self.value()?),
            }
        }
    }

    fn string(&mut self) -> Result<String, String> {
        let quote = self.bytes[self.pos];
        self.pos += 1;
        let mut out = String::new();
        while let Some(byte) = self.peek() {
            self.pos += 1;
            match byte {
                b'\\' => {
                    let escaped = self.peek().ok_or("dangling escape")?;
                    self.pos += 1;
                    out.push(match escaped {
                        b'n' => '\n',
                        b't' => '\t',
                        b'r' => '\r',
                        b'u' => {
                            let hex = self
                                .bytes
                                .get(self.pos..self.pos + 4)
                                .ok_or("truncated \\u escape")?;
                            self.pos += 4;
                            let code = u32::from_str_radix(
                                std::str::from_utf8(hex).map_err(|_| "bad \\u escape")?,
                                16,
                            )
                            .map_err(|_| "bad \\u escape")?;
                            char::from_u32(code).ok_or("bad code point")?
                        }
                        other => other as char,
                    });
                }
                b if b == quote => return Ok(out),
                _ => {
                    // Copy the whole UTF-8 sequence, not the single byte.
                    let start = self.pos - 1;
                    let len = utf8_len(byte);
                    self.pos = start + len;
                    let slice = self
                        .bytes
                        .get(start..self.pos)
                        .ok_or("truncated utf-8 sequence")?;
                    out.push_str(std::str::from_utf8(slice).map_err(|_| "invalid utf-8")?);
                }
            }
        }
        Err("unterminated string".to_owned())
    }

    /// A value with no quotes: a number, a keyword, or a bare word.
    fn bareword(&mut self) -> Result<Value, String> {
        let raw = self.raw_until(b",}]")?;
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err("empty value".to_owned());
        }
        Ok(match trimmed {
            "true" => Value::Bool(true),
            "false" => Value::Bool(false),
            "null" => Value::Null,
            other => match serde_json::from_str::<Value>(other) {
                Ok(value @ Value::Number(_)) => value,
                _ => Value::String(other.to_owned()),
            },
        })
    }

    /// Raw text up to (not including) one of `stops`, at this nesting level.
    fn raw_until(&mut self, stops: &[u8]) -> Result<String, String> {
        let start = self.pos;
        while let Some(byte) = self.peek() {
            if stops.contains(&byte) {
                break;
            }
            self.pos += 1;
        }
        std::str::from_utf8(&self.bytes[start..self.pos])
            .map(str::to_owned)
            .map_err(|_| "invalid utf-8".to_owned())
    }
}

const fn utf8_len(first: u8) -> usize {
    match first {
        0x00..=0x7f => 1,
        0xc0..=0xdf => 2,
        0xe0..=0xef => 3,
        _ => 4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strict_json_is_parsed_strictly_and_unchanged() {
        let value = parse_relaxed(r#"{"city":"berlin","days":3,"ok":true}"#).unwrap();
        assert_eq!(value, json!({"city": "berlin", "days": 3, "ok": true}));
    }

    #[test]
    fn bare_keys_and_bare_values_are_recovered() {
        // The shape a small local model actually emits — and the shape the mock
        // harness produces after it strips quotes out of an echoed prompt.
        let value = parse_relaxed("{name: get_weather, arguments: {city: berlin}}").unwrap();
        assert_eq!(
            value,
            json!({"name": "get_weather", "arguments": {"city": "berlin"}})
        );
    }

    #[test]
    fn single_quotes_and_trailing_commas_are_tolerated() {
        let value = parse_relaxed("{'a': 'one', 'b': [1, 2,], }").unwrap();
        assert_eq!(value, json!({"a": "one", "b": [1, 2]}));
    }

    #[test]
    fn numbers_and_keywords_keep_their_types() {
        let value = parse_relaxed("{n: 42, f: 1.5, t: true, z: null}").unwrap();
        assert_eq!(value, json!({"n": 42, "f": 1.5, "t": true, "z": null}));
    }

    #[test]
    fn truncated_input_is_an_error_not_a_guess() {
        // MEASURED-4's first hostile call is truncated exactly like this. It
        // must fail: a half-read argument object executed against a real tool
        // is worse than no call at all.
        assert!(parse_relaxed("{\"city\":\"berlin\",\"un").is_err());
        assert!(parse_relaxed("not-json-at-all").is_err());
    }

    #[test]
    fn multibyte_text_survives_the_relaxed_path() {
        let value = parse_relaxed("{city: 'Köln ▒', ok: yes}").unwrap();
        assert_eq!(value, json!({"city": "Köln ▒", "ok": "yes"}));
    }
}
