//! YAML tag handling — the single place tag configuration lives, mirroring
//! `../../nodejs/src/yaml-tags.ts`.
//!
//! The Node implementation hands the `yaml` parser a `customTags` array built
//! from the engine registry. Rust's YAML parser surfaces tags as
//! `serde_yaml::Value::Tagged` instead, so the equivalent configuration is this
//! conversion: it decides which tags are recognised on the way to plain JSON,
//! and rewrites each into a [`crate::sentinel`] marker object.

use serde_json::{Map, Value as Json};
use serde_yaml::Value as Yaml;

use crate::engines::include::{INCLUDE_BYTES_ENGINE, INCLUDE_TEXT_ENGINE};
use crate::sentinel::{make_tagged_sentinel, REF_ENGINE};

/// Engines this kernel recognises. `!cel` is deliberately absent: the Rust
/// kernel has no expression engine yet, and reading a CEL expression as an
/// opaque value would evaluate it as a literal.
///
/// The two `!include-*` tags ARE here, because the tag set is part of what a
/// manifest means and a kernel that silently skipped them would read an embedded
/// file as an unresolved marker. `kernel/rust` resolves them at resource
/// creation; `!include-bytes` fails there with an explicit message, since this
/// kernel's manifest tree is `serde_json::Value` and has no bytes variant to
/// carry the result.
const KNOWN_ENGINES: &[&str] = &[REF_ENGINE, INCLUDE_TEXT_ENGINE, INCLUDE_BYTES_ENGINE];

#[derive(Debug)]
pub struct TagError {
    pub message: String,
}

impl std::fmt::Display for TagError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for TagError {}

impl TagError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

/// Convert a parsed YAML document to the plain-JSON manifest tree the kernel
/// works with, rewriting recognised tags to sentinels.
pub fn yaml_to_json(value: Yaml) -> Result<Json, TagError> {
    match value {
        Yaml::Null => Ok(Json::Null),
        Yaml::Bool(b) => Ok(Json::Bool(b)),
        Yaml::Number(n) => number_to_json(n),
        Yaml::String(s) => {
            // The legacy inline expression form. Passing it through as a literal
            // would be the one failure mode worse than rejecting it: the value
            // reaches a controller looking like an expression that was never
            // evaluated. Rejected on the same grounds as `!cel`.
            if s.contains("${{") {
                return Err(TagError::new(format!(
                    "inline `${{{{ … }}}}` expression in {s:?}: this kernel has no expression engine, and reading it as a literal string would silently produce the wrong value"
                )));
            }
            Ok(Json::String(s))
        }
        Yaml::Sequence(items) => items
            .into_iter()
            .map(yaml_to_json)
            .collect::<Result<Vec<_>, _>>()
            .map(Json::Array),
        Yaml::Mapping(mapping) => {
            let mut out = Map::with_capacity(mapping.len());
            for (key, value) in mapping {
                let key = match key {
                    Yaml::String(key) => key,
                    Yaml::Number(n) => n.to_string(),
                    Yaml::Bool(b) => b.to_string(),
                    other => {
                        return Err(TagError::new(format!(
                            "manifest mapping keys must be scalars, got {}",
                            describe(&other)
                        )))
                    }
                };
                out.insert(key, yaml_to_json(value)?);
            }
            Ok(Json::Object(out))
        }
        Yaml::Tagged(tagged) => {
            let engine = tagged.tag.to_string();
            let engine = engine.trim_start_matches('!').to_string();
            if !KNOWN_ENGINES.contains(&engine.as_str()) {
                return Err(TagError::new(format!(
                    "unsupported YAML tag `!{engine}`; this kernel recognises: {}",
                    KNOWN_ENGINES
                        .iter()
                        .map(|e| format!("!{e}"))
                        .collect::<Vec<_>>()
                        .join(", ")
                )));
            }
            let source = match tagged.value {
                Yaml::String(source) => source,
                other => {
                    return Err(TagError::new(format!(
                        "`!{engine}` expects a scalar string, got {}",
                        describe(&other)
                    )))
                }
            };
            Ok(make_tagged_sentinel(&engine, &source))
        }
    }
}

/// Name a YAML node the way an author would recognise it. The `Debug` form
/// prints serde_yaml's internal enum, which says nothing to someone reading
/// their own manifest.
fn describe(value: &Yaml) -> String {
    match value {
        Yaml::Null => "a null".to_string(),
        Yaml::Bool(b) => format!("the boolean `{b}`"),
        Yaml::Number(n) => format!("the number `{n}`"),
        Yaml::String(s) => format!("the string `{s}`"),
        Yaml::Sequence(_) => "a list".to_string(),
        Yaml::Mapping(_) => "a mapping".to_string(),
        Yaml::Tagged(tagged) => format!("a `{}`-tagged value", tagged.tag),
    }
}

fn number_to_json(n: serde_yaml::Number) -> Result<Json, TagError> {
    if let Some(i) = n.as_i64() {
        return Ok(Json::from(i));
    }
    if let Some(u) = n.as_u64() {
        return Ok(Json::from(u));
    }
    if let Some(f) = n.as_f64() {
        return serde_json::Number::from_f64(f)
            .map(Json::Number)
            .ok_or_else(|| TagError::new(format!("number {f} has no JSON representation")));
    }
    Err(TagError::new(format!("unrepresentable YAML number: {n}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Result<Json, TagError> {
        let value: Yaml = serde_yaml::from_str(text).expect("valid yaml");
        yaml_to_json(value)
    }

    #[test]
    fn ref_tags_become_sentinels() {
        let json = parse("invoke: !ref Console.writeLine").unwrap();
        assert_eq!(
            json["invoke"],
            serde_json::json!({ "__tagged": true, "engine": "ref", "source": "Console.writeLine" })
        );
    }

    #[test]
    fn unknown_tags_are_rejected_rather_than_read_as_literals() {
        let err = parse("value: !cel \"1 + 1\"").unwrap_err();
        assert!(err.message.contains("!cel"), "{}", err.message);
    }

    #[test]
    fn inline_expressions_are_rejected_rather_than_read_as_literals() {
        let err = parse("value: \"port ${{ variables.port }}\"").unwrap_err();
        assert!(err.message.contains("expression"), "{}", err.message);
    }

    #[test]
    fn ordinary_braces_are_left_alone() {
        // Console markup is `{style content}` — single-brace, no `$` — and must
        // not be mistaken for an expression.
        let json = parse("value: \"hello {green world}\"").unwrap();
        assert_eq!(json["value"], serde_json::json!("hello {green world}"));
    }
}
