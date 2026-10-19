//! A JSON value as a JavaScript host holds one — no Node twin.
//!
//! Node's schemas and its JSON reader hand over plain JavaScript values; this is that
//! value for an engine with no JavaScript underneath. A number is a double, as in
//! JavaScript, so `1.0` and `1e20` are integers in the sense of `Number.isInteger`. An
//! object keeps ECMAScript's own-property order. A node is shared by `Arc`, and its
//! identity is the `Arc`'s pointer, as an object's is its reference on Node.
//!
//! `Drop`, `Debug` and `==` run on heap work lists: a value of any depth is released,
//! printed and compared on a small stack. `==` is the value as data: an object's
//! entries in any order, a number by its bits.

use std::fmt;
use std::sync::Arc;

use telorun_cel_value::PropertyMap;

pub enum JsonValue {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Arc<JsonValue>>),
    Object(PropertyMap<Arc<JsonValue>>),
}

const _: () = {
    const fn shared_across_threads<T: Send + Sync>() {}
    shared_across_threads::<JsonValue>();
};

impl PartialEq for JsonValue {
    fn eq(&self, other: &Self) -> bool {
        let mut pending = vec![(self, other)];
        while let Some((left, right)) = pending.pop() {
            match (left, right) {
                (JsonValue::Null, JsonValue::Null) => {}
                (JsonValue::Bool(a), JsonValue::Bool(b)) if a == b => {}
                (JsonValue::Number(a), JsonValue::Number(b)) if a.to_bits() == b.to_bits() => {}
                (JsonValue::String(a), JsonValue::String(b)) if a == b => {}
                (JsonValue::Array(a), JsonValue::Array(b)) if a.len() == b.len() => {
                    pending.extend(a.iter().zip(b.iter()).map(|(a, b)| (&**a, &**b)));
                }
                (JsonValue::Object(a), JsonValue::Object(b)) if a.len() == b.len() => {
                    for (key, value) in a.iter() {
                        match b.get(key) {
                            Some(held) => pending.push((value, held)),
                            None => return false,
                        }
                    }
                }
                _ => return false,
            }
        }
        true
    }
}

enum Piece<'a> {
    Text(&'static str),
    Key(&'a str),
    Value(&'a JsonValue),
}

impl fmt::Debug for JsonValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut pending = vec![Piece::Value(self)];
        while let Some(piece) = pending.pop() {
            match piece {
                Piece::Text(text) => f.write_str(text)?,
                Piece::Key(key) => write!(f, "{key:?}: ")?,
                Piece::Value(JsonValue::Null) => f.write_str("Null")?,
                Piece::Value(JsonValue::Bool(value)) => write!(f, "Bool({value})")?,
                Piece::Value(JsonValue::Number(value)) => write!(f, "Number({value:?})")?,
                Piece::Value(JsonValue::String(value)) => write!(f, "String({value:?})")?,
                Piece::Value(JsonValue::Array(items)) => {
                    pending.push(Piece::Text("])"));
                    for (at, item) in items.iter().enumerate().rev() {
                        pending.push(Piece::Value(item));
                        if at > 0 {
                            pending.push(Piece::Text(", "));
                        }
                    }
                    pending.push(Piece::Text("Array(["));
                }
                Piece::Value(JsonValue::Object(entries)) => {
                    pending.push(Piece::Text("})"));
                    let held: Vec<(&str, &Arc<JsonValue>)> = entries.iter().collect();
                    for (at, (key, value)) in held.into_iter().enumerate().rev() {
                        pending.push(Piece::Value(value));
                        pending.push(Piece::Key(key));
                        if at > 0 {
                            pending.push(Piece::Text(", "));
                        }
                    }
                    pending.push(Piece::Text("Object({"));
                }
            }
        }
        Ok(())
    }
}

fn unlink_children(value: &mut JsonValue, pending: &mut Vec<Arc<JsonValue>>) {
    match value {
        JsonValue::Array(items) => pending.append(items),
        JsonValue::Object(entries) => pending.extend(std::mem::take(entries).into_iter().map(|(_, value)| value)),
        _ => {}
    }
}

impl Drop for JsonValue {
    /// Unlinks every descendant this value alone owns onto a list, so releasing a deep
    /// value costs no stack.
    fn drop(&mut self) {
        let mut pending = Vec::new();
        unlink_children(self, &mut pending);
        while let Some(child) = pending.pop() {
            if let Some(mut held) = Arc::into_inner(child) {
                unlink_children(&mut held, &mut pending);
            }
        }
    }
}
