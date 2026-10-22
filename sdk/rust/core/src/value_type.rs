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

use crate::plain_encoding::PLAIN_ENCODINGS;

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
    /// The member this parameter's argument constrains — a schema the member's value
    /// must satisfy. Only on an entry declaring `members`.
    pub member: Option<String>,
    /// This parameter's argument is a token from [`HOST_ENTRY_KINDS`] saying what
    /// a host path names when something is there — only on a `fromHost` entry, at
    /// most one per entry. Found by this flag, never by the parameter's name.
    pub host_entry: bool,
    pub description: Option<String>,
}

/// The closed vocabulary of a host-entry argument: `directory` names a directory,
/// `file` anything that is not one, links followed. Each runtime maps a token to
/// its own filesystem query.
pub const HOST_ENTRY_KINDS: &[&str] = &["file", "directory"];

/// One value type, exactly as its entry file declares it.
#[derive(Debug, Clone)]
pub struct ValueType {
    /// `Telo.`-qualified. The closed vocabulary an author writes at the name slot.
    pub name: String,
    pub representation: Representation,
    /// `json` only — the JSON Schema type this name refines.
    pub base: Option<String>,
    /// `json` only — the CEL type a value carries when JSON Schema cannot name
    /// it (`uint` over `integer`). Absent means a nominal brand over `base`.
    pub cel_type: Option<String>,
    /// `instance` only — the symbolic key [`BINDINGS`] maps.
    pub binding: Option<String>,
    /// Non-live `instance` only — the symbolic name of the one canonical plain
    /// JSON form.
    pub encoding: Option<String>,
    /// `json` over `string` only — the anchor ([`HOST_ANCHORS`]) a host-supplied
    /// value is resolved against. Its presence makes the type a host path.
    pub from_host: Option<String>,
    /// An instance whose consumption has effects, so it is exempt from
    /// validation rather than asserted. Exemption is from VALIDATION, never from
    /// TYPING.
    pub live: bool,
    /// Non-live `instance` only — the members a value holds, each a JSON Schema: its
    /// fields, its object authoring form and, through `x-telo-sensitive`, what of it
    /// is redacted. Its encoding builds a value from them.
    pub members: Option<serde_json::Map<String, Value>>,
    /// Non-live `instance` with an encoding only — the code a text that does not read
    /// is refused under (`ERR_`-prefixed at runtime).
    pub accepts_text: Option<String>,
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
            ("bytes", Binding { rust_type: "Bytes" }),
            ("duration", Binding { rust_type: "Duration" }),
            ("stream", Binding { rust_type: "Stream" }),
            ("timestamp", Binding { rust_type: "Timestamp" }),
            ("url", Binding { rust_type: "plain_encoding::url_text::Url" }),
        ])
    })
}

/// The closed vocabulary of `fromHost` anchors, mirroring the Node reader's
/// `HOST_ANCHORS`: an anchor one runtime cannot map is a hard error there.
pub const HOST_ANCHORS: &[&str] = &["working-directory"];

/// The CEL types a `json` base carries beyond its own, which only `celType` states.
fn cel_types_beyond_base(base: &str) -> &'static [&'static str] {
    match base {
        "integer" => &["uint"],
        _ => &[],
    }
}

// The entries, embedded. Listed explicitly because Rust has no glob include —
// the Node half generates its barrel from the same directory listing, and a file
// missing from either is a type that is simply not in the vocabulary.
const ENTRY_FILES: &[(&str, &str)] = &[
    ("telo-bytes.json", include_str!("../../../value-types/telo-bytes.json")),
    ("telo-duration.json", include_str!("../../../value-types/telo-duration.json")),
    ("telo-host-path.json", include_str!("../../../value-types/telo-host-path.json")),
    ("telo-stream.json", include_str!("../../../value-types/telo-stream.json")),
    ("telo-tcp-port.json", include_str!("../../../value-types/telo-tcp-port.json")),
    ("telo-timestamp.json", include_str!("../../../value-types/telo-timestamp.json")),
    ("telo-udp-port.json", include_str!("../../../value-types/telo-udp-port.json")),
    ("telo-uint64.json", include_str!("../../../value-types/telo-uint64.json")),
    ("telo-url.json", include_str!("../../../value-types/telo-url.json")),
];

/// The closed key vocabulary an entry is written in. Mirrors the Node reader's
/// `ENTRY_KEYS`: an unrecognized key is an authoring mistake whose only other
/// outcome is a datum that quietly means nothing, and an entry refused on one
/// runtime must be refused on the other.
const ENTRY_KEYS: &[&str] = &[
    "name",
    "representation",
    "base",
    "celType",
    "binding",
    "encoding",
    "fromHost",
    "live",
    "members",
    "acceptsText",
    "parameters",
    "description",
    "$comment",
];

fn read_entry(file: &str, raw: &Value) -> ValueType {
    let obj = raw
        .as_object()
        .unwrap_or_else(|| panic!("Invalid value-type entry '{file}': an entry must be a mapping"));
    for key in obj.keys() {
        assert!(
            ENTRY_KEYS.contains(&key.as_str()),
            "Invalid value-type entry '{file}': an entry has no key '{key}'. Known keys: {ENTRY_KEYS:?}."
        );
    }
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
    let base = string("base");
    let cel_type = string("celType");
    let encoding = string("encoding");
    let from_host = string("fromHost");
    let live = obj.get("live").and_then(Value::as_bool).unwrap_or(false);
    // The same representation rules the Node reader enforces, so an entry never
    // loads on one runtime and fails on the other.
    match representation {
        Representation::Json => {
            assert!(
                binding.is_none() && encoding.is_none(),
                "Invalid value-type entry '{file}': a 'json' representation takes no 'binding' or 'encoding'"
            );
            if let Some(cel) = cel_type.as_deref() {
                let beyond = cel_types_beyond_base(base.as_deref().unwrap_or_default());
                assert!(
                    beyond.contains(&cel),
                    "Invalid value-type entry '{file}': 'celType' '{cel}' is not a CEL type its base carries beyond its own"
                );
            }
            if let Some(anchor) = from_host.as_deref() {
                assert!(
                    base.as_deref() == Some("string"),
                    "Invalid value-type entry '{file}': 'fromHost' needs a 'string' base"
                );
                assert!(
                    HOST_ANCHORS.contains(&anchor),
                    "Invalid value-type entry '{file}': fromHost '{anchor}' is not an anchor this runtime knows ({HOST_ANCHORS:?})"
                );
            }
        }
        Representation::Instance => {
            assert!(
                base.is_none() && cel_type.is_none(),
                "Invalid value-type entry '{file}': an 'instance' representation takes no 'base' or 'celType'"
            );
            assert!(
                from_host.is_none(),
                "Invalid value-type entry '{file}': an 'instance' representation takes no 'fromHost'"
            );
            if live {
                assert!(
                    encoding.is_none(),
                    "Invalid value-type entry '{file}': a 'live' representation takes no 'encoding'"
                );
            } else {
                let name = encoding.as_deref().unwrap_or_else(|| {
                    panic!("Invalid value-type entry '{file}': a non-live 'instance' representation needs an 'encoding'")
                });
                let known: Vec<&str> = PLAIN_ENCODINGS.iter().map(|encoding| encoding.name).collect();
                assert!(
                    known.contains(&name),
                    "Invalid value-type entry '{file}': encoding '{name}' has no codec in this runtime ({known:?})"
                );
            }
        }
    }
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
                                matches!(key.as_str(), "name" | "description" | "element" | "member" | "hostEntry"),
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
                    member: item.get("member").and_then(Value::as_str).map(str::to_owned),
                    host_entry: match item.get("hostEntry") {
                        None => false,
                        Some(Value::Bool(flag)) => *flag,
                        Some(_) => panic!(
                            "Invalid value-type entry '{file}': a parameter's 'hostEntry' must be a boolean when present"
                        ),
                    },
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
    // A host-entry token says what a host path names, so it belongs to a host
    // path alone, and two would make "what this path names" ambiguous.
    if parameters.iter().any(|p| p.host_entry) && from_host.is_none() {
        panic!("Invalid value-type entry '{file}': 'hostEntry' belongs to a parameter of a type declaring 'fromHost'");
    }
    if parameters.iter().filter(|p: &&Parameter| p.host_entry).count() > 1 {
        panic!("Invalid value-type entry '{file}': at most one parameter may declare 'hostEntry'");
    }

    // `members` and `acceptsText`, by the Node reader's rules: an entry refused on one
    // runtime is refused on the other.
    let members = obj.get("members").map(|raw| {
        assert!(
            representation == Representation::Instance && !live,
            "Invalid value-type entry '{file}': 'members' belongs to a non-live 'instance' representation"
        );
        let members = raw
            .as_object()
            .filter(|members| !members.is_empty())
            .unwrap_or_else(|| panic!("Invalid value-type entry '{file}': 'members' must be a non-empty mapping of member names to schemas"));
        for (member, schema) in members {
            let mut chars = member.chars();
            assert!(
                matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
                    && chars.all(|c| c.is_ascii_alphanumeric() || c == '_'),
                "Invalid value-type entry '{file}': member '{member}' is not spelled as a name, which a CEL field must be"
            );
            assert!(schema.is_object(), "Invalid value-type entry '{file}': member '{member}' must be a schema");
        }
        if let Some(name) = encoding.as_deref() {
            assert!(
                PLAIN_ENCODINGS.iter().any(|encoding| encoding.name == name && encoding.composes),
                "Invalid value-type entry '{file}': encoding '{name}' builds no value from members, so 'members' could not be authored"
            );
        }
        members.clone()
    });
    let accepts_text = obj.get("acceptsText").map(|raw| {
        assert!(
            representation == Representation::Instance && !live && encoding.is_some(),
            "Invalid value-type entry '{file}': 'acceptsText' belongs to a non-live 'instance' with an 'encoding'"
        );
        let object = raw
            .as_object()
            .filter(|object| object.keys().all(|key| key == "code"))
            .unwrap_or_else(|| panic!("Invalid value-type entry '{file}': 'acceptsText' is a mapping holding exactly 'code'"));
        let code = object.get("code").and_then(Value::as_str).unwrap_or_default();
        let mut chars = code.chars();
        assert!(
            matches!(chars.next(), Some(c) if c.is_ascii_uppercase())
                && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'),
            "Invalid value-type entry '{file}': 'acceptsText.code' '{code}' is not spelled as a diagnostic code"
        );
        code.to_owned()
    });
    for parameter in &parameters {
        if let Some(member) = &parameter.member {
            assert!(
                members.as_ref().is_some_and(|members| members.contains_key(member)),
                "Invalid value-type entry '{file}': parameter '{}' binds 'member: {member}', which is not one of its 'members'",
                parameter.name
            );
        }
    }

    ValueType {
        name,
        representation,
        base,
        cel_type,
        binding,
        encoding,
        from_host,
        live,
        members,
        accepts_text,
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

/// What a host-path slot says its path names — a token of [`HOST_ENTRY_KINDS`] —
/// or `None` when it says nothing, or something outside the vocabulary (which the
/// analyzer reports).
pub fn host_entry_of(schema: &Value) -> Option<&'static str> {
    let entry = value_type_of(schema)?;
    let parameter = entry.parameters.iter().find(|p| p.host_entry)?;
    let token = schema.get(X_TELO_TYPE)?.as_object()?.get(&parameter.name)?.as_str()?;
    HOST_ENTRY_KINDS.iter().copied().find(|kind| *kind == token)
}

/// The `fromHost` anchor ([`HOST_ANCHORS`]) of the type a schema node declares,
/// or `None`. Its presence makes the node a host path.
pub fn host_anchor_of(schema: &Value) -> Option<&'static str> {
    value_type_of(schema)?.from_host.as_deref()
}

/// True when `text` is an absolute path on SOME host: POSIX `/…`, a drive letter
/// (`C:\…`, `C:/…`) or a UNC share (`\\server\…`). Host-neutral on purpose, so a
/// manifest is judged alike wherever it is checked or run.
pub fn is_absolute_host_path(text: &str) -> bool {
    let bytes = text.as_bytes();
    match bytes {
        [b'/', ..] | [b'\\', b'\\', ..] => true,
        [drive, b':', b'\\' | b'/', ..] => drive.is_ascii_alphabetic(),
        _ => false,
    }
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

/// True when a value holds a member its type's entry marks `x-telo-sensitive` (a URL
/// holding a password) — what an observability writer asks before writing a value.
/// Read from the entry, never from a type name; the Node SDK's `holdsSensitiveMember`.
pub fn holds_sensitive_member(value: &telorun_cel_value::CelValue) -> bool {
    let telorun_cel_value::CelValue::Host(host) = value else {
        return false;
    };
    let Some(entry) = host.type_name().and_then(|name| value_types().get(name)) else {
        return false;
    };
    let (Some(members), Some(encoding)) = (&entry.members, &entry.encoding) else {
        return false;
    };
    let Some(held) = crate::plain_encoding::host_members(encoding, host) else {
        return false;
    };
    members.iter().any(|(name, schema)| {
        schema.get("x-telo-sensitive") == Some(&Value::Bool(true))
            && held.get(name).and_then(Value::as_str).is_some_and(|text| !text.is_empty())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_the_same_vocabulary_the_node_half_does() {
        let types = value_types();
        for name in [
            "Telo.Bytes",
            "Telo.Duration",
            "Telo.HostPath",
            "Telo.Stream",
            "Telo.TcpPort",
            "Telo.Timestamp",
            "Telo.UdpPort",
            "Telo.Uint64",
            "Telo.Url",
        ] {
            assert!(types.contains_key(name), "{name} missing from the vocabulary");
        }
        let url = &types["Telo.Url"];
        assert_eq!(url.encoding.as_deref(), Some("url-text"));
        assert_eq!(url.accepts_text.as_deref(), Some("URL_INVALID"));
        assert_eq!(url.parameters[0].member.as_deref(), Some("scheme"));
        assert_eq!(url.members.as_ref().unwrap()["password"]["x-telo-sensitive"], serde_json::json!(true));
        assert_eq!(types["Telo.Timestamp"].encoding.as_deref(), Some("rfc3339"));
        assert_eq!(types["Telo.Uint64"].cel_type.as_deref(), Some("uint"));
        assert!(types["Telo.Stream"].encoding.is_none());
        assert_eq!(types["Telo.HostPath"].from_host.as_deref(), Some("working-directory"));
        assert!(types["Telo.HostPath"].cel_type.is_none());
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
    fn answers_from_the_entry_whether_a_value_holds_a_sensitive_member() {
        let url = |text: &str| {
            telorun_cel_value::CelValue::Host(
                telorun_cel_value::CelHostValue::named(
                    "Telo.Url",
                    std::sync::Arc::new(crate::plain_encoding::url_text::read(text).unwrap()),
                )
                .unwrap(),
            )
        };
        assert!(holds_sensitive_member(&url("postgres://app:p%40ss@db/orders")));
        assert!(!holds_sensitive_member(&url("postgres://app@db/orders")));
        assert!(!holds_sensitive_member(&telorun_cel_value::CelValue::String(
            "postgres://app:p@db".into()
        )));
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
    #[should_panic(expected = "has no key 'celTyp'")]
    fn an_unknown_top_level_key_is_refused() {
        read_entry(
            "typo.json",
            &json!({
                "name": "Telo.Typo",
                "representation": "json",
                "base": "integer",
                "celTyp": "uint",
                "description": "x"
            }),
        );
    }

    #[test]
    #[should_panic(expected = "is not a CEL type its base carries beyond its own")]
    fn a_cel_type_its_base_cannot_carry_is_refused() {
        read_entry(
            "wrong-base.json",
            &json!({
                "name": "Telo.Wrong",
                "representation": "json",
                "base": "number",
                "celType": "uint",
                "description": "x"
            }),
        );
    }

    #[test]
    #[should_panic(expected = "takes no 'base' or 'celType'")]
    fn a_cel_type_on_an_instance_is_refused() {
        read_entry(
            "instance-cel.json",
            &json!({
                "name": "Telo.WrongInstance",
                "representation": "instance",
                "binding": "bytes",
                "encoding": "base64url",
                "celType": "uint",
                "description": "x"
            }),
        );
    }

    #[test]
    fn an_include_bytes_slot_is_recognised() {
        assert!(is_bytes_slot(&json!({ "x-telo-type": "Telo.Bytes" })));
        assert!(!is_bytes_slot(&json!({ "x-telo-type": "Telo.Stream" })));
        assert!(!is_bytes_slot(&json!({ "type": "string" })));
    }

    #[test]
    #[should_panic(expected = "'hostEntry' must be a boolean when present")]
    fn a_host_entry_flag_that_is_not_a_boolean_is_refused() {
        read_entry(
            "host-entry-text.json",
            &json!({
                "name": "Telo.WrongPath",
                "representation": "json",
                "base": "string",
                "fromHost": "working-directory",
                "parameters": [{ "name": "entry", "hostEntry": "yes" }],
                "description": "x"
            }),
        );
    }

    #[test]
    fn a_host_path_node_names_its_anchor() {
        assert_eq!(host_anchor_of(&json!({ "x-telo-type": "Telo.HostPath" })), Some("working-directory"));
        assert_eq!(
            host_anchor_of(&json!({ "x-telo-type": { "name": "Telo.HostPath", "entry": "file" } })),
            Some("working-directory")
        );
        assert_eq!(host_anchor_of(&json!({ "x-telo-type": "Telo.Url" })), None);
    }

    #[test]
    fn an_absolute_path_is_absolute_on_some_host() {
        for text in ["/srv/data", "C:\\data", "c:/data", "\\\\server\\share"] {
            assert!(is_absolute_host_path(text), "{text}");
        }
        for text in ["data", "./data", "../data", "C:data", "", ":memory:"] {
            assert!(!is_absolute_host_path(text), "{text}");
        }
    }
}
