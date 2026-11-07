//! Walks a manifest value for its tagged scalars — `walk.ts`.
//!
//! Emits each tagged scalar with its dotted path (e.g. `routes[0].handler.body`) and the
//! engine that owns it — including engines that produce no diagnostics (`literal`), so routing
//! through the registry stays generic and a new engine needs no change here. A plain string is
//! never a value's expression, and a precompiled object (`__compiled`) is skipped so it is not
//! re-walked.
//!
//! Node walks by recursion; a manifest value can be arbitrarily deep, so this keeps a work
//! list and visits in the same order. Node's plain-object test, which keeps the walk out of a
//! live instance's cyclic graph, has no twin: a `serde_json::Value` holds no instance.

use serde_json::Value;

use crate::sentinel::tagged_sentinel_parts;

/// Calls `callback(source, path, engine)` for each tagged scalar in `value`, in document
/// order. `path` is where the walk starts (`""` for a whole value).
pub fn walk_cel_expressions(value: &Value, path: &str, callback: &mut dyn FnMut(&str, &str, &str)) {
    let mut work: Vec<(&Value, String)> = vec![(value, path.to_string())];
    while let Some((value, path)) = work.pop() {
        if let Some((engine, source)) = tagged_sentinel_parts(value) {
            callback(source, &path, engine);
            continue;
        }
        match value {
            Value::Array(items) => {
                for (index, item) in items.iter().enumerate().rev() {
                    work.push((item, format!("{path}[{index}]")));
                }
            }
            Value::Object(members) if !is_compiled(members) => {
                let entries: Vec<_> = members.iter().collect();
                for (key, member) in entries.into_iter().rev() {
                    let at = if path.is_empty() { key.clone() } else { format!("{path}.{key}") };
                    work.push((member, at));
                }
            }
            _ => {}
        }
    }
}

/// Whether the object carries a truthy `__compiled`, as JavaScript reads it.
fn is_compiled(members: &serde_json::Map<String, Value>) -> bool {
    match members.get("__compiled") {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Number(number)) => number.as_f64().is_some_and(|held| held != 0.0 && !held.is_nan()),
        Some(_) => true,
    }
}
