//! `x-telo-type` — the one annotation that says what the value at a slot IS,
//! and the Rust half of the vocabulary the Node SDK also reads.
//!
//! # Why this file exists at all
//!
//! The vocabulary is DATA (`sdk/value-types/*.json`), embedded here with
//! `include_str!` and copied into the Node package by the SDK's `prepare`. Both
//! runtimes read the identical bytes, which is the whole point: the Rust kernel
//! resolves an `!include-bytes` embed into a slot typed by these entries, in a
//! kernel with no CEL engine anywhere near it. A registry written as one
//! language's code would be a second registry, hand-copied, drifting silently —
//! the divergence the sibling migration-entry design exists to prevent.
//!
//! What is genuinely language-bound is small and separable: an `instance` entry
//! names a symbolic [`binding`](ValueType::binding), and each runtime maps that
//! key to its own identity. That mapping is [`BINDINGS`] and it is the only
//! per-language artifact here. A binding with **no row is a hard error**, never a
//! skipped assertion: a type that cannot be asserted would silently exempt every
//! slot that declares it.
//!
//! This file has no Node twin's name — `sdk/nodejs/src/value-type.ts` is the
//! twin, kebab-case becoming snake_case, as the layout rule requires.

use serde_json::Value;
use std::collections::HashMap;
use std::sync::OnceLock;

/// The annotation's key, so no caller spells it inline.
pub const X_TELO_TYPE: &str = "x-telo-type";

/// How a value is represented — the one thing an entry declares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Representation {
    /// An ordinary value its declared schema already validates. The name adds
    /// nominal identity for static wiring and has no runtime existence.
    Json,
    /// Not JSON at all. This is what makes a value unauthorable: no YAML literal
    /// is ever a byte buffer or a stream handle.
    Instance,
}

/// A named type parameter. Every parameter is optional and defaults to *any*.
#[derive(Debug, Clone)]
pub struct Parameter {
    pub name: String,
    /// This parameter's argument is what ITERATING a value of the type yields.
    /// Carried here because both runtimes read the identical entry bytes — a key
    /// only one half knew about would make the vocabulary language-bound, which
    /// is the divergence this design exists to prevent. Nothing in the Rust
    /// kernel consumes it yet; it has no CEL engine and does not type an
    /// iteration body.
    pub element: bool,
    pub description: Option<String>,
}

/// One value type, exactly as its entry file declares it.
#[derive(Debug, Clone)]
pub struct ValueType {
    /// `Telo.`-qualified. The closed vocabulary an author writes at the name slot.
    pub name: String,
    pub representation: Representation,
    /// `json` only — the JSON Schema type this name refines.
    pub base: Option<String>,
    /// `instance` only — the symbolic key [`BINDINGS`] maps.
    pub binding: Option<String>,
    /// An instance whose consumption has effects, so it is exempt from
    /// validation rather than asserted. Exemption is from VALIDATION, never from
    /// TYPING.
    pub live: bool,
    pub parameters: Vec<Parameter>,
    pub description: String,
}

/// What this runtime can say about an `instance` representation.
///
/// Kept deliberately thin. The Rust kernel today needs to know that a slot holds
/// bytes (so an `!include-bytes` embed can fill it) and that a live slot is
/// exempt; it has no CEL engine, so it carries no CEL type. A backend that grows
/// one adds a field here rather than a second table.
#[derive(Debug, Clone, Copy)]
pub struct Binding {
    /// A human-readable name for the host representation, used in diagnostics.
    pub rust_type: &'static str,
}

/// This runtime's binding table — the ONLY per-language artifact in the whole
/// mechanism. Keyed by an entry's symbolic `binding`, never by its name, so a
/// rename of a type touches no table.
fn bindings() -> &'static HashMap<&'static str, Binding> {
    static BINDINGS: OnceLock<HashMap<&'static str, Binding>> = OnceLock::new();
    BINDINGS.get_or_init(|| {
        HashMap::from([
            ("bytes", Binding { rust_type: "Vec<u8>" }),
            ("stream", Binding { rust_type: "Stream" }),
        ])
    })
}

// The entries, embedded. Listed explicitly because Rust has no glob include —
// the Node half generates its barrel from the same directory listing, and a file
// missing from either is a type that is simply not in the vocabulary.
const ENTRY_FILES: &[(&str, &str)] = &[
    ("telo-bytes.json", include_str!("../../value-types/telo-bytes.json")),
    ("telo-stream.json", include_str!("../../value-types/telo-stream.json")),
    ("telo-tcp-port.json", include_str!("../../value-types/telo-tcp-port.json")),
    ("telo-udp-port.json", include_str!("../../value-types/telo-udp-port.json")),
];

fn read_entry(file: &str, raw: &Value) -> ValueType {
    let obj = raw
        .as_object()
        .unwrap_or_else(|| panic!("Invalid value-type entry '{file}': an entry must be a mapping"));
    let string = |key: &str| -> Option<String> {
        obj.get(key).and_then(Value::as_str).map(str::to_owned)
    };
    let name = string("name")
        .unwrap_or_else(|| panic!("Invalid value-type entry '{file}': 'name' must be a string"));
    let representation = match string("representation").as_deref() {
        Some("json") => Representation::Json,
        Some("instance") => Representation::Instance,
        other => panic!(
            "Invalid value-type entry '{file}': 'representation' must be 'json' or 'instance', got {other:?}"
        ),
    };
    let binding = string("binding");
    // A binding with no row in THIS host's table is a hard error, never a
    // skipped assertion — see the module header.
    if let Some(key) = binding.as_deref() {
        assert!(
            bindings().contains_key(key),
            "Invalid value-type entry '{file}': binding '{key}' has no row in this runtime's \
             table — a value type whose assertion cannot be produced would silently exempt \
             every slot that declares it"
        );
    }
    let parameters: Vec<Parameter> = obj
        .get("parameters")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    // Same closed vocabulary as the Node reader: an unknown key is
                    // an authoring mistake whose only other outcome is a parameter
                    // that quietly does not mean what it says.
                    if let Some(map) = item.as_object() {
                        for key in map.keys() {
                            assert!(
                                matches!(key.as_str(), "name" | "description" | "element"),
                                "Invalid value-type entry '{file}': a parameter has no key '{key}'"
                            );
                        }
                    }
                    Parameter {
                    name: item
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_else(|| {
                            panic!("Invalid value-type entry '{file}': a parameter needs a 'name'")
                        })
                        .to_owned(),
                    element: item
                        .get("element")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    description: item
                        .get("description")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    // Mirrors the Node reader's arity check. The entries are shared DATA read by
    // both runtimes, so an entry that is a hard startup error on one and loads
    // silently on the other reintroduces exactly the divergence a data-only
    // vocabulary exists to prevent — and two element parameters make "the element
    // of this value" ambiguous, which every consumer would resolve by taking the
    // first.
    if parameters.iter().filter(|p: &&Parameter| p.element).count() > 1 {
        panic!("Invalid value-type entry '{file}': at most one parameter may declare 'element'");
    }

    ValueType {
        name,
        representation,
        base: string("base"),
        binding,
        live: obj.get("live").and_then(Value::as_bool).unwrap_or(false),
        parameters,
        description: string("description").unwrap_or_default(),
    }
}

/// Every declared value type, keyed by its `Telo.`-qualified name.
pub fn value_types() -> &'static HashMap<String, ValueType> {
    static TYPES: OnceLock<HashMap<String, ValueType>> = OnceLock::new();
    TYPES.get_or_init(|| {
        let mut out = HashMap::new();
        for (file, text) in ENTRY_FILES {
            let raw: Value = serde_json::from_str(text)
                .unwrap_or_else(|e| panic!("Invalid value-type entry '{file}': {e}"));
            let entry = read_entry(file, &raw);
            assert!(
                !out.contains_key(&entry.name),
                "Invalid value-type entry '{file}': '{}' is already declared",
                entry.name
            );
            out.insert(entry.name.clone(), entry);
        }
        out
    })
}

/// The name a schema node declares, in either spelling: a bare name, or the
/// object form carrying type arguments.
///
/// Returns the name even when it is not a declared type — reading an unknown one
/// as "no value type" is the silent degrade this annotation replaced. Judging it
/// is the analyzer's job, which is where a name can be reported against the
/// manifest that wrote it.
pub fn declared_name(schema: &Value) -> Option<&str> {
    match schema.get(X_TELO_TYPE)? {
        Value::String(name) => Some(name.as_str()),
        Value::Object(map) => map.get("name").and_then(Value::as_str),
        _ => None,
    }
}

/// The entry a schema node declares, or `None`.
pub fn value_type_of(schema: &Value) -> Option<&'static ValueType> {
    value_types().get(declared_name(schema)?)
}

/// True when the node declares a type represented as a runtime instance — the
/// values no manifest literal can ever be.
pub fn is_instance_slot(schema: &Value) -> bool {
    value_type_of(schema).is_some_and(|e| e.representation == Representation::Instance)
}

/// True when the node declares a `live` type, so its value is exempt from
/// validation — never traversed, never asserted. Typing is unaffected.
pub fn is_live_slot(schema: &Value) -> bool {
    value_type_of(schema).is_some_and(|e| e.live)
}

/// True when the node's declared type is the one an `!include-bytes` embed
/// produces. The Rust kernel's whole use of this registry today.
pub fn is_bytes_slot(schema: &Value) -> bool {
    value_type_of(schema).is_some_and(|e| e.binding.as_deref() == Some("bytes"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_the_same_vocabulary_the_node_half_does() {
        let types = value_types();
        for name in ["Telo.Bytes", "Telo.Stream", "Telo.TcpPort", "Telo.UdpPort"] {
            assert!(types.contains_key(name), "{name} missing from the vocabulary");
        }
    }

    #[test]
    fn a_live_type_is_exempt_and_an_asserted_one_is_not() {
        assert!(is_live_slot(&json!({ "x-telo-type": "Telo.Stream" })));
        assert!(!is_live_slot(&json!({ "x-telo-type": "Telo.Bytes" })));
        assert!(is_instance_slot(&json!({ "x-telo-type": "Telo.Bytes" })));
        // A `json` representation is ordinary data its own schema validates.
        assert!(!is_instance_slot(&json!({ "x-telo-type": "Telo.TcpPort" })));
    }

    #[test]
    fn both_spellings_name_the_same_type() {
        let bare = json!({ "x-telo-type": "Telo.Stream" });
        let parameterized = json!({ "x-telo-type": { "name": "Telo.Stream", "of": "Telo.Bytes" } });
        assert_eq!(declared_name(&bare), Some("Telo.Stream"));
        assert_eq!(declared_name(&parameterized), Some("Telo.Stream"));
        assert!(is_live_slot(&parameterized));
    }

    #[test]
    fn an_unknown_name_is_reported_not_swallowed() {
        // Readable as a name, but not a declared type — so a caller can say so
        // instead of quietly reading the slot as untyped.
        let typo = json!({ "x-telo-type": "Telo.Strem" });
        assert_eq!(declared_name(&typo), Some("Telo.Strem"));
        assert!(value_type_of(&typo).is_none());
    }

    #[test]
    fn an_include_bytes_slot_is_recognised() {
        assert!(is_bytes_slot(&json!({ "x-telo-type": "Telo.Bytes" })));
        assert!(!is_bytes_slot(&json!({ "x-telo-type": "Telo.Stream" })));
        assert!(!is_bytes_slot(&json!({ "type": "string" })));
    }
}
