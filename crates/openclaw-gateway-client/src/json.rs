use serde_json::Value;
use std::{fmt::Write as _, io};

/// Measure compact Gateway JSON without allocating an encoded payload.
/// Returns `None` once the serialized value exceeds `maximum` bytes.
#[must_use]
pub fn json_encoded_len(value: &Value, maximum: usize) -> Option<usize> {
    let mut writer = LimitWriter {
        written: 0,
        maximum,
    };
    serde_json::to_writer(&mut writer, value).ok()?;
    Some(writer.written)
}

/// Encode immutable JSON into one exactly sized allocation.
/// A media string followed by its closing quote otherwise doubles the buffer.
#[must_use]
pub fn encode_json(value: &Value) -> String {
    // Value has no user-defined serializer: both passes see the same compact bytes.
    let length = json_encoded_len(value, usize::MAX).expect("JSON value length overflow");
    let mut encoded = String::with_capacity(length);
    write!(&mut encoded, "{value}").expect("writing JSON to a String cannot fail");
    encoded
}

struct LimitWriter {
    written: usize,
    maximum: usize,
}

impl io::Write for LimitWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let next = self
            .written
            .checked_add(bytes.len())
            .filter(|&size| size <= self.maximum)
            .ok_or_else(|| io::Error::other("serialized JSON exceeds byte limit"))?;
        self.written = next;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn measured_json_matches_wire_bytes_and_exact_limits() {
        for value in [
            json!(null),
            json!(true),
            json!(18446744073709551615_u64),
            json!(-1.25),
            json!({"nested": ["\"\\\n\t\u{0000}é🦀", {"media": "x".repeat(3 * 1024)}]}),
        ] {
            let expected = value.to_string();
            let encoded = encode_json(&value);
            assert_eq!(encoded, expected);
            assert_eq!(encoded.capacity(), encoded.len());
            assert_eq!(
                json_encoded_len(&value, expected.len()),
                Some(expected.len())
            );
            assert_eq!(json_encoded_len(&value, expected.len() - 1), None);
        }
    }
}
