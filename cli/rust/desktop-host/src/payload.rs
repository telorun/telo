//! A closed-object reader for message payloads: every refusal names the member by
//! its path, and an object with a member its table does not list is refused.
//!
//! No Node twin: this crate has none (see `lib.rs`).

use crate::envelope::{violation, ProtocolError};
use serde_json::{Map, Value};

pub struct Fields<'a> {
    members: &'a Map<String, Value>,
    path: String,
    seen: Vec<&'static str>,
}

impl<'a> Fields<'a> {
    pub fn new(value: &'a Value, path: &str) -> Result<Self, ProtocolError> {
        match value {
            Value::Object(members) => Ok(Fields { members, path: path.to_owned(), seen: Vec::new() }),
            _ => Err(violation(format!("{} is not an object", display(path)))),
        }
    }

    fn at(&self, key: &str) -> String {
        if self.path.is_empty() {
            key.to_owned()
        } else {
            format!("{}.{key}", self.path)
        }
    }

    fn take(&mut self, key: &'static str) -> Option<&'a Value> {
        self.seen.push(key);
        self.members.get(key)
    }

    pub fn string(&mut self, key: &'static str) -> Result<String, ProtocolError> {
        match self.take(key) {
            Some(Value::String(s)) => Ok(s.clone()),
            Some(_) => Err(violation(format!("'{}' is not a string", self.at(key)))),
            None => Err(violation(format!("'{}' is missing", self.at(key)))),
        }
    }

    pub fn non_empty_string(&mut self, key: &'static str) -> Result<String, ProtocolError> {
        let text = self.string(key)?;
        if text.is_empty() {
            return Err(violation(format!("'{}' is empty", self.at(key))));
        }
        Ok(text)
    }

    pub fn opt_string(&mut self, key: &'static str) -> Result<Option<String>, ProtocolError> {
        match self.take(key) {
            None => Ok(None),
            Some(Value::String(s)) => Ok(Some(s.clone())),
            Some(_) => Err(violation(format!("'{}' is not a string", self.at(key)))),
        }
    }

    pub fn boolean(&mut self, key: &'static str) -> Result<bool, ProtocolError> {
        match self.take(key) {
            Some(Value::Bool(b)) => Ok(*b),
            Some(_) => Err(violation(format!("'{}' is not a boolean", self.at(key)))),
            None => Err(violation(format!("'{}' is missing", self.at(key)))),
        }
    }

    /// A whole, non-negative number.
    pub fn index(&mut self, key: &'static str) -> Result<u32, ProtocolError> {
        match self.take(key) {
            Some(value) => whole_u32(value).ok_or_else(|| violation(format!("'{}' is not a whole, non-negative number", self.at(key)))),
            None => Err(violation(format!("'{}' is missing", self.at(key)))),
        }
    }

    /// A finite, positive number: a logical pixel extent.
    pub fn extent(&mut self, key: &'static str) -> Result<f64, ProtocolError> {
        match self.take(key) {
            Some(value) => value
                .as_number()
                .and_then(|n| n.as_f64())
                .filter(|f| f.is_finite() && *f > 0.0)
                .ok_or_else(|| violation(format!("'{}' is not a positive number", self.at(key)))),
            None => Err(violation(format!("'{}' is missing", self.at(key)))),
        }
    }

    /// A member that must be present and is read by `read` over a nested object.
    pub fn object<T>(
        &mut self,
        key: &'static str,
        read: impl FnOnce(&mut Fields<'a>) -> Result<T, ProtocolError>,
    ) -> Result<T, ProtocolError> {
        let path = self.at(key);
        match self.take(key) {
            Some(value) => {
                let mut nested = Fields::new(value, &path)?;
                let out = read(&mut nested)?;
                nested.finish()?;
                Ok(out)
            }
            None => Err(violation(format!("'{path}' is missing"))),
        }
    }

    pub fn opt_object<T>(
        &mut self,
        key: &'static str,
        read: impl FnOnce(&mut Fields<'a>) -> Result<T, ProtocolError>,
    ) -> Result<Option<T>, ProtocolError> {
        if self.members.contains_key(key) {
            self.object(key, read).map(Some)
        } else {
            self.seen.push(key);
            Ok(None)
        }
    }

    pub fn array(&mut self, key: &'static str) -> Result<(&'a [Value], String), ProtocolError> {
        let path = self.at(key);
        match self.take(key) {
            Some(Value::Array(items)) => Ok((items, path)),
            Some(_) => Err(violation(format!("'{path}' is not an array"))),
            None => Err(violation(format!("'{path}' is missing"))),
        }
    }

    /// Refuses a member no read named.
    pub fn finish(&self) -> Result<(), ProtocolError> {
        for key in self.members.keys() {
            if !self.seen.contains(&key.as_str()) {
                return Err(violation(format!("'{}' is not a member of {}", self.at(key), display(&self.path))));
            }
        }
        Ok(())
    }
}

fn display(path: &str) -> String {
    if path.is_empty() {
        "the payload".to_owned()
    } else {
        format!("'{path}'")
    }
}

fn whole_u32(value: &Value) -> Option<u32> {
    let number = value.as_number()?;
    if let Some(n) = number.as_u64() {
        return u32::try_from(n).ok();
    }
    let f = number.as_f64()?;
    (f >= 0.0 && f.fract() == 0.0 && f <= u32::MAX as f64).then_some(f as u32)
}
