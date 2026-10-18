//! THE CAPABILITY ROSTER — the closed set of lifecycle roles a kind may declare
//! in `capability:`, and the one reader of what a `capability:` value means.
//! Mirrors `../../nodejs/src/capability-roster.ts`, word for word in what it
//! refuses with, so a manifest is refused identically by either kernel.
//!
//! The roster is the built-in `Telo.Abstract` entries carrying `declarable`
//! (`builtins.rs`), read from those entries alone. An entry is a ROLE when its
//! own `capability:` names itself; `Telo.Template` is a role reserved for the
//! built-in document kinds and `Telo.Executable` is a slot constraint, and both
//! carry `declarable: false`.

use serde_json::Value;

use crate::builtins::builtin_entries;
use crate::nearest_name::nearest_name;

/// The built-in module's prefix: `Telo.<Name>`.
const BUILTIN_PREFIX: &str = "Telo.";

/// One roster entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RosterEntry {
    /// `Telo.<Name>`.
    pub name: String,
    /// The entry's own `capability:` names itself.
    pub role: bool,
    pub declarable: bool,
    pub description: String,
}

/// The roster, in entry-file order.
pub fn capability_roster() -> Vec<RosterEntry> {
    builtin_entries()
        .iter()
        .filter(|entry| entry.kind == "Telo.Abstract" && entry.declarable.is_some())
        .map(|entry| RosterEntry {
            name: entry.name.clone(),
            role: entry.capability.as_deref() == Some(entry.name.as_str()),
            declarable: entry.declarable == Some(true),
            description: entry.description.clone(),
        })
        .collect()
}

/// The names an authored `capability:` may hold, lexically sorted.
pub fn declarable_capabilities() -> Vec<String> {
    let mut names: Vec<String> = capability_roster()
        .into_iter()
        .filter(|entry| entry.role && entry.declarable)
        .map(|entry| entry.name)
        .collect();
    names.sort();
    names
}

/// True when `name` is a lifecycle role of the roster, declarable or not.
pub fn is_capability_role(name: &str) -> bool {
    capability_roster().iter().any(|entry| entry.role && entry.name == name)
}

/// A refusal of a `capability:` value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityProblem {
    /// `CAPABILITY_UNKNOWN` or `CAPABILITY_NOT_DECLARABLE`.
    pub code: &'static str,
    pub message: String,
}

/// `<Alias>.<Kind>` — the legacy spelling that named a module's kind.
fn is_alias_qualified(value: &str) -> bool {
    let identifier = |segment: &str| {
        let mut chars = segment.chars();
        chars
            .next()
            .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
    };
    value
        .split_once('.')
        .is_some_and(|(alias, kind)| identifier(alias) && identifier(kind))
}

/// What is wrong with a `capability:` value, or none when it names a declarable
/// role (or is absent). `declares_extends` says whether the same document
/// declares `extends:` — a definition has one parent, so a kind named in
/// `capability:` then has nowhere to go.
pub fn capability_problem(value: Option<&Value>, declares_extends: bool) -> Option<CapabilityProblem> {
    let value = value?;
    let declarable = declarable_capabilities();
    let roles = declarable.join(", ");
    let unknown = |message: String| Some(CapabilityProblem { code: "CAPABILITY_UNKNOWN", message });
    let Some(value) = value.as_str() else {
        return unknown(format!("capability must name a lifecycle role — one of: {roles}."));
    };
    let roster = capability_roster();
    if let Some(entry) = roster.iter().find(|entry| entry.name == value) {
        if entry.role && entry.declarable {
            return None;
        }
        return Some(CapabilityProblem {
            code: "CAPABILITY_NOT_DECLARABLE",
            message: format!(
                "'{value}' cannot be declared as a capability: {} Declare one of: {roles}.",
                entry.description
            ),
        });
    }
    if builtin_entries().iter().any(|entry| entry.name == value) {
        return unknown(format!(
            "'{value}' is a built-in kind, not a lifecycle role. To specialize it, write 'extends: {value}'; capability names a role — one of: {roles}."
        ));
    }
    if value.starts_with(BUILTIN_PREFIX) {
        let suggestion = nearest_name(value, declarable.iter().map(String::as_str))
            .map(|name| format!(" Did you mean '{name}'?"))
            .unwrap_or_default();
        return unknown(format!(
            "'{value}' is not a capability.{suggestion} A capability names a lifecycle role — one of: {roles}."
        ));
    }
    if is_alias_qualified(value) {
        return unknown(if declares_extends {
            format!(
                "'{value}' names a kind, not a lifecycle role, and this definition already declares 'extends:' — a definition has one parent, declared in 'extends:'. Remove 'capability: {value}', or declare it in 'extends:' in place of the other. A capability names a role — one of: {roles}."
            )
        } else {
            format!(
                "'{value}' names a kind, not a lifecycle role. A kind this one specializes is declared in 'extends: {value}'; capability names a role — one of: {roles}."
            )
        });
    }
    let short_names: Vec<&str> = declarable
        .iter()
        .map(|name| name.strip_prefix(BUILTIN_PREFIX).unwrap_or(name))
        .collect();
    let suggestion = nearest_name(value, short_names)
        .map(|name| format!(" Did you mean '{BUILTIN_PREFIX}{name}'?"))
        .unwrap_or_default();
    unknown(format!(
        "'{value}' is not a capability: a lifecycle role is written '{BUILTIN_PREFIX}<Role>'.{suggestion} One of: {roles}."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn names_the_declarable_roles() {
        assert_eq!(
            declarable_capabilities(),
            [
                "Telo.Callable",
                "Telo.Invocable",
                "Telo.Mount",
                "Telo.Provider",
                "Telo.Runnable",
                "Telo.Service",
                "Telo.Sink",
                "Telo.Type"
            ]
        );
    }

    /// The vectors every runtime judging a `capability:` answers identically —
    /// `analyzer/capability-conformance/README.md`.
    const VECTORS: &str = include_str!("../../capability-conformance/vectors.json");

    #[test]
    fn answers_every_capability_conformance_vector() {
        let vectors: Value = serde_json::from_str(VECTORS).expect("vectors parse");
        for row in vectors["rows"].as_array().expect("rows") {
            let id = row["id"].as_str().expect("id");
            let declares_extends = row["extends"].as_bool().expect("extends");
            let answer = capability_problem(row.get("capability"), declares_extends);
            match row["code"].as_str() {
                None => assert_eq!(answer, None, "{id}"),
                Some(code) => {
                    let answer = answer.unwrap_or_else(|| panic!("{id}: accepted"));
                    assert_eq!(answer.code, code, "{id}");
                    assert_eq!(answer.message, row["message"].as_str().expect("message"), "{id}");
                }
            }
        }
    }

    #[test]
    fn accepts_every_declarable_role() {
        for role in declarable_capabilities() {
            assert_eq!(capability_problem(Some(&json!(role)), false), None);
        }
    }
}
