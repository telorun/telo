//! Rewrites every `!ref <name>` sentinel in a manifest tree to `{kind, name}`
//! (local) or `{kind, name, alias}` (cross-module), in place.
//! Mirrors `../../nodejs/src/resolve-ref-sentinels.ts`.
//!
//! The walk is value-tree-driven, not field-map-driven: a `!ref` tag is an
//! explicit reference marker, so any sentinel found anywhere is unambiguously a
//! reference. The source string is split on its FIRST dot, which is what makes
//! the "resource names contain no dot" rule load-bearing:
//!
//!   `!ref writeLine`          → local resource `writeLine`
//!   `!ref Self.writeLine`     → local resource `writeLine`
//!   `!ref Console.writeLine`  → instance `writeLine` exported by the import
//!                               aliased `Console`
//!
//! An unresolved sentinel is left in place rather than replaced with a
//! placeholder, exactly as the Node pass does — but for a different reason and
//! with a different follow-up. Node leaves it because a scope-local name is
//! resolved on demand at runtime, so a surviving sentinel can still be
//! legitimate. This kernel has no scopes, so nothing may survive: the caller
//! sweeps for leftovers with [`find_unresolved_sentinels`] and fails, naming the
//! path and the unknown name. Without that sweep a typo'd reference reaches a
//! controller as raw `{__tagged, …}` JSON wherever the kind's schema leaves the
//! slot open.

use std::collections::HashMap;

use serde_json::{json, Value};
use telo_templating::ref_sentinel_source;

/// Names a reference may resolve to, and the kind each carries.
#[derive(Default)]
pub struct RefTargets {
    local: HashMap<String, String>,
    foreign: HashMap<(String, String), String>,
}

impl RefTargets {
    /// Register a resource declared in the module being resolved.
    pub fn add_local(&mut self, name: impl Into<String>, kind: impl Into<String>) {
        self.local.insert(name.into(), kind.into());
    }

    /// Register an instance an import exports, under the alias the importing
    /// module gave that import.
    pub fn add_foreign(
        &mut self,
        alias: impl Into<String>,
        name: impl Into<String>,
        kind: impl Into<String>,
    ) {
        self.foreign.insert((alias.into(), name.into()), kind.into());
    }

    fn resolve(&self, source: &str) -> Option<Value> {
        match source.split_once('.') {
            None => self
                .local
                .get(source)
                .map(|kind| json!({ RESOLVED_REF_MARKER: true, "kind": kind, "name": source })),
            Some(("Self", name)) => self
                .local
                .get(name)
                .map(|kind| json!({ RESOLVED_REF_MARKER: true, "kind": kind, "name": name })),
            Some((alias, name)) => self.foreign.get(&(alias.to_string(), name.to_string())).map(
                |kind| json!({ RESOLVED_REF_MARKER: true, "kind": kind, "name": name, "alias": alias }),
            ),
        }
    }
}

/// Resolve every sentinel in `value` against `targets`.
pub fn resolve_ref_sentinels(value: &mut Value, targets: &RefTargets) {
    if let Some(source) = ref_sentinel_source(value) {
        if let Some(resolved) = targets.resolve(source) {
            *value = resolved;
        }
        return;
    }
    match value {
        Value::Array(items) => {
            for item in items {
                resolve_ref_sentinels(item, targets);
            }
        }
        Value::Object(map) => {
            for (_, item) in map.iter_mut() {
                resolve_ref_sentinels(item, targets);
            }
        }
        _ => {}
    }
}

/// Marks the object this pass writes, so a resolved reference is distinguishable
/// from an author-typed `{kind, name}` mapping.
///
/// Without it the two are identical, and the object form — which the Node
/// analyzer rejects statically as `INVALID_REFERENCE_FORM` — would be accepted
/// and dispatched here. Two kernels disagreeing about what a valid manifest is
/// is worse than either rule alone, so the marker is what lets
/// [`find_invalid_reference_forms`] reject it.
pub const RESOLVED_REF_MARKER: &str = "__ref";

/// A resolved reference: the shape every downstream consumer sees, regardless of
/// where the reference was written.
pub struct ResolvedRef<'a> {
    pub kind: &'a str,
    pub name: &'a str,
    pub alias: Option<&'a str>,
}

/// Read a resolved reference back out of a value, or `None` if this is not one.
pub fn as_resolved_ref(value: &Value) -> Option<ResolvedRef<'_>> {
    if value.get(RESOLVED_REF_MARKER).and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let kind = value.get("kind")?.as_str()?;
    let name = value.get("name")?.as_str()?;
    Some(ResolvedRef {
        kind,
        name,
        alias: value.get("alias").and_then(Value::as_str),
    })
}

/// One leftover sentinel, located for the error message.
pub struct UnresolvedRef {
    /// Slash-joined path from the document root, e.g. `targets/0/invoke`.
    pub path: String,
    /// The `!ref` source text that did not resolve.
    pub source: String,
}

/// Collect every `!ref` this pass could not resolve.
pub fn find_unresolved_sentinels(value: &Value) -> Vec<UnresolvedRef> {
    let mut found = Vec::new();
    walk_paths(value, &mut String::new(), &mut |path, node| {
        if let Some(source) = ref_sentinel_source(node) {
            found.push(UnresolvedRef {
                path: path.to_string(),
                source: source.to_string(),
            });
        }
    });
    found
}

/// One author-written `{kind, name}` mapping in a slot that wants a reference.
pub struct InvalidReferenceForm {
    pub path: String,
    pub kind: String,
    pub name: String,
}

/// Collect every object that looks like a hand-written reference.
///
/// A resource *declaration* also carries `kind`, so the discriminator is
/// `metadata.name` versus a bare top-level `name`: an inline definition names
/// itself under `metadata`, a reference-shaped object does not.
pub fn find_invalid_reference_forms(value: &Value) -> Vec<InvalidReferenceForm> {
    let mut found = Vec::new();
    walk_paths(value, &mut String::new(), &mut |path, node| {
        if node.get(RESOLVED_REF_MARKER).is_some() {
            return;
        }
        let (Some(kind), Some(name)) = (
            node.get("kind").and_then(Value::as_str),
            node.get("name").and_then(Value::as_str),
        ) else {
            return;
        };
        found.push(InvalidReferenceForm {
            path: path.to_string(),
            kind: kind.to_string(),
            name: name.to_string(),
        });
    });
    found
}

/// Depth-first walk handing each node its slash-joined path. Descends into
/// resolved references too — they are ordinary objects once rewritten, and
/// stopping early would hide anything nested beside them.
fn walk_paths(value: &Value, path: &mut String, visit: &mut impl FnMut(&str, &Value)) {
    visit(path, value);
    match value {
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                let restore = path.len();
                push_segment(path, &index.to_string());
                walk_paths(item, path, visit);
                path.truncate(restore);
            }
        }
        Value::Object(map) => {
            for (key, item) in map {
                let restore = path.len();
                push_segment(path, key);
                walk_paths(item, path, visit);
                path.truncate(restore);
            }
        }
        _ => {}
    }
}

fn push_segment(path: &mut String, segment: &str) {
    if !path.is_empty() {
        path.push('/');
    }
    path.push_str(segment);
}

#[cfg(test)]
mod tests {
    use super::*;
    use telo_templating::make_tagged_sentinel;

    fn targets() -> RefTargets {
        let mut targets = RefTargets::default();
        targets.add_local("localThing", "demo.Thing");
        targets.add_foreign("Console", "writeLine", "console.WriteLine");
        targets
    }

    #[test]
    fn resolves_local_bare_and_self_qualified_names() {
        let mut value = json!({
            "bare": make_tagged_sentinel("ref", "localThing"),
            "qualified": make_tagged_sentinel("ref", "Self.localThing"),
        });
        resolve_ref_sentinels(&mut value, &targets());
        let expected = json!({ "__ref": true, "kind": "demo.Thing", "name": "localThing" });
        assert_eq!(value["bare"], expected);
        assert_eq!(value["qualified"], expected);
    }

    #[test]
    fn resolves_cross_module_names_through_the_import_alias() {
        let mut value = json!([{ "invoke": make_tagged_sentinel("ref", "Console.writeLine") }]);
        resolve_ref_sentinels(&mut value, &targets());
        assert_eq!(
            value[0]["invoke"],
            json!({ "__ref": true, "kind": "console.WriteLine", "name": "writeLine", "alias": "Console" })
        );
        assert!(as_resolved_ref(&value[0]["invoke"]).is_some());
    }

    #[test]
    fn leaves_an_unknown_name_as_a_sentinel_and_reports_where() {
        let sentinel = make_tagged_sentinel("ref", "Console.nope");
        let mut value = json!({ "steps": [{ "invoke": sentinel.clone() }] });
        resolve_ref_sentinels(&mut value, &targets());
        assert_eq!(value["steps"][0]["invoke"], sentinel);

        let unresolved = find_unresolved_sentinels(&value);
        assert_eq!(unresolved.len(), 1);
        assert_eq!(unresolved[0].path, "steps/0/invoke");
        assert_eq!(unresolved[0].source, "Console.nope");
    }

    /// An unresolved sentinel anywhere — not only in a slot someone happens to
    /// read — must be findable, or it reaches a controller as raw JSON.
    #[test]
    fn finds_a_sentinel_buried_in_arbitrary_config() {
        let mut value = json!({ "config": { "nested": [{ "handler": make_tagged_sentinel("ref", "typo") }] } });
        resolve_ref_sentinels(&mut value, &targets());
        let unresolved = find_unresolved_sentinels(&value);
        assert_eq!(unresolved.len(), 1);
        assert_eq!(unresolved[0].path, "config/nested/0/handler");
    }

    #[test]
    fn a_resolved_reference_is_not_reported_as_a_hand_written_one() {
        let mut value = json!({ "invoke": make_tagged_sentinel("ref", "localThing") });
        resolve_ref_sentinels(&mut value, &targets());
        assert!(find_invalid_reference_forms(&value).is_empty());
    }

    #[test]
    fn a_hand_written_object_reference_is_reported() {
        let value = json!({ "invoke": { "kind": "demo.Thing", "name": "localThing" } });
        let invalid = find_invalid_reference_forms(&value);
        assert_eq!(invalid.len(), 1);
        assert_eq!(invalid[0].path, "invoke");
    }

    /// An inline resource declaration also carries `kind`; it names itself under
    /// `metadata`, so it must not be mistaken for a reference.
    #[test]
    fn an_inline_declaration_is_not_a_reference_form() {
        let value = json!({ "with": [{ "kind": "demo.Thing", "metadata": { "name": "scoped" } }] });
        assert!(find_invalid_reference_forms(&value).is_empty());
    }
}
