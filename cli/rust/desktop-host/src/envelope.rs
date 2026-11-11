//! The typed-frame JSON envelope every frame's meta carries
//! (`kernel/specs/desktop-host.md` §1): exactly `id`, `type` and `payload`, written
//! in the typed frame's canonical form (RFC 8785: members ordered by key).
//!
//! The canonical writer here covers what this link writes — integers, strings,
//! booleans, null, arrays and objects. A message never carries a fractional number
//! out of the helper, so no ECMAScript number formatting is needed on this side.
//!
//! No Node twin: this crate has none (see `lib.rs`).

use serde_json::{Map, Value};
use std::fmt;

/// A refusal that ends the link: a frame, envelope or payload the protocol rejects.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolError(pub String);

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ProtocolError {}

pub fn violation(message: impl Into<String>) -> ProtocolError {
    ProtocolError(message.into())
}

#[derive(Debug, Clone, PartialEq)]
pub struct Envelope {
    pub id: u64,
    pub kind: String,
    pub payload: Value,
}

/// The largest whole number a JSON number carries exactly in a double.
const MAX_SAFE_ID: f64 = 9_007_199_254_740_991.0;

pub fn parse_envelope(meta: &str) -> Result<Envelope, ProtocolError> {
    let value: Value = serde_json::from_str(meta).map_err(|e| violation(format!("meta is not JSON: {e}")))?;
    let Value::Object(mut members) = value else {
        return Err(violation("meta is not an object"));
    };
    for key in members.keys() {
        if !matches!(key.as_str(), "id" | "type" | "payload") {
            return Err(violation(format!("envelope has an unexpected member '{key}'")));
        }
    }
    let id = members.remove("id").ok_or_else(|| violation("envelope has no 'id'"))?;
    let kind = members.remove("type").ok_or_else(|| violation("envelope has no 'type'"))?;
    let payload = members.remove("payload").ok_or_else(|| violation("envelope has no 'payload'"))?;
    let id = whole_id(&id).ok_or_else(|| violation("envelope 'id' is not a whole, non-negative number"))?;
    let Value::String(kind) = kind else {
        return Err(violation("envelope 'type' is not a string"));
    };
    Ok(Envelope { id, kind, payload })
}

fn whole_id(value: &Value) -> Option<u64> {
    let number = value.as_number()?;
    if let Some(n) = number.as_u64() {
        return (n as f64 <= MAX_SAFE_ID).then_some(n);
    }
    let f = number.as_f64()?;
    (f >= 0.0 && f.fract() == 0.0 && f <= MAX_SAFE_ID).then_some(f as u64)
}

/// The canonical meta text of an envelope.
pub fn write_envelope(envelope: &Envelope) -> String {
    let mut out = String::new();
    out.push_str("{\"id\":");
    out.push_str(&envelope.id.to_string());
    out.push_str(",\"payload\":");
    write_canonical(&envelope.payload, &mut out);
    out.push_str(",\"type\":");
    write_string(&envelope.kind, &mut out);
    out.push('}');
    out
}

/// A response payload: `{ "ok": <body> }`.
pub fn ok_payload(body: Value) -> Value {
    let mut members = Map::new();
    members.insert("ok".into(), body);
    Value::Object(members)
}

/// A response payload: `{ "error": { "code", "message" } }`.
pub fn error_payload(code: &str, message: &str) -> Value {
    let mut error = Map::new();
    error.insert("code".into(), Value::String(code.into()));
    error.insert("message".into(), Value::String(message.into()));
    let mut members = Map::new();
    members.insert("error".into(), Value::Object(error));
    Value::Object(members)
}

fn write_string(text: &str, out: &mut String) {
    // serde_json escapes exactly as `JSON.stringify` does: `\b \f \n \r \t`, other
    // controls as lowercase `\u00xx`, no escaping of U+2028.
    out.push_str(&serde_json::to_string(text).expect("a string is always serializable"));
}

fn write_canonical(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&n.to_string()),
        Value::String(s) => write_string(s, out),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        Value::Object(members) => {
            // Member order must not depend on serde_json's `preserve_order` feature,
            // which another crate of the workspace may switch on.
            let mut keys: Vec<&String> = members.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (i, key) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(key, out);
                out.push(':');
                write_canonical(&members[key], out);
            }
            out.push('}');
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn writes_members_in_canonical_order() {
        let text = write_envelope(&Envelope { id: 4, kind: "Window.Closed".into(), payload: json!({ "z": 1, "a": { "y": [true, null], "b": "x" } }) });
        assert_eq!(text, r#"{"id":4,"payload":{"a":{"b":"x","y":[true,null]},"z":1},"type":"Window.Closed"}"#);
    }

    #[test]
    fn parses_any_member_order_and_a_double_id() {
        let envelope = parse_envelope(r#"{"type":"Helper.Quit","payload":{},"id":3.0}"#).unwrap();
        assert_eq!(envelope, Envelope { id: 3, kind: "Helper.Quit".into(), payload: json!({}) });
    }

    #[test]
    fn refuses_what_is_not_an_envelope_of_exactly_three_members() {
        for meta in [
            "not json",
            "[]",
            r#"{"id":1,"type":"A"}"#,
            r#"{"id":1,"type":"A","payload":{},"session":"s"}"#,
            r#"{"id":-1,"type":"A","payload":{}}"#,
            r#"{"id":1.5,"type":"A","payload":{}}"#,
            r#"{"id":"1","type":"A","payload":{}}"#,
            r#"{"id":1,"type":7,"payload":{}}"#,
            r#"{"id":1e300,"type":"A","payload":{}}"#,
        ] {
            assert!(parse_envelope(meta).is_err(), "{meta}");
        }
    }

    #[test]
    fn response_payloads_have_the_documented_shape() {
        assert_eq!(ok_payload(json!({})), json!({ "ok": {} }));
        assert_eq!(error_payload("E", "m"), json!({ "error": { "code": "E", "message": "m" } }));
    }
}
