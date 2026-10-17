//! The built-in vocabulary — every kind that needs no import — read from the
//! entries of `sdk/builtins/`, the files the Node analyzer derives its registry
//! from. Mirrors `../../nodejs/src/builtins.ts`.
//!
//! This analyzer has no schema validator, so it reads each entry's identity
//! (`kind`, `metadata.name`) and the capability roster's fields and nothing
//! else; the roster itself is `capability_roster.rs`. The `$roster` markers a
//! `Telo.Definition` entry carries are the Node renderer's to derive and are
//! never read here.

use std::sync::OnceLock;

use serde_json::Value;

/// The entries, embedded. Listed explicitly because Rust has no glob include —
/// the Node half derives its barrel from the same directory listing, and the
/// test below holds the two to one set.
const ENTRY_FILES: &[(&str, &str)] = &[
    ("Abstract.json", include_str!("../../../sdk/builtins/Abstract.json")),
    ("Application.json", include_str!("../../../sdk/builtins/Application.json")),
    ("Callable.json", include_str!("../../../sdk/builtins/Callable.json")),
    ("ConsoleSink.json", include_str!("../../../sdk/builtins/ConsoleSink.json")),
    ("Definition.json", include_str!("../../../sdk/builtins/Definition.json")),
    ("Executable.json", include_str!("../../../sdk/builtins/Executable.json")),
    ("FileSink.json", include_str!("../../../sdk/builtins/FileSink.json")),
    ("Function.json", include_str!("../../../sdk/builtins/Function.json")),
    ("Import.json", include_str!("../../../sdk/builtins/Import.json")),
    ("Invocable.json", include_str!("../../../sdk/builtins/Invocable.json")),
    ("JsonSchema.json", include_str!("../../../sdk/builtins/JsonSchema.json")),
    ("Library.json", include_str!("../../../sdk/builtins/Library.json")),
    ("LogSink.json", include_str!("../../../sdk/builtins/LogSink.json")),
    ("LogTraceSink.json", include_str!("../../../sdk/builtins/LogTraceSink.json")),
    ("Mount.json", include_str!("../../../sdk/builtins/Mount.json")),
    ("NeedType.json", include_str!("../../../sdk/builtins/NeedType.json")),
    ("Provider.json", include_str!("../../../sdk/builtins/Provider.json")),
    ("PublicHostPattern.json", include_str!("../../../sdk/builtins/PublicHostPattern.json")),
    ("PublicUrl.json", include_str!("../../../sdk/builtins/PublicUrl.json")),
    ("Runnable.json", include_str!("../../../sdk/builtins/Runnable.json")),
    ("Service.json", include_str!("../../../sdk/builtins/Service.json")),
    ("Sink.json", include_str!("../../../sdk/builtins/Sink.json")),
    ("Template.json", include_str!("../../../sdk/builtins/Template.json")),
    ("TraceSink.json", include_str!("../../../sdk/builtins/TraceSink.json")),
    ("Type.json", include_str!("../../../sdk/builtins/Type.json")),
];

/// One built-in document, as written.
#[derive(Debug)]
pub struct BuiltinEntry {
    /// The entry's file name, `<metadata.name>.json`.
    pub file: &'static str,
    pub kind: String,
    /// `Telo.<metadata.name>`.
    pub name: String,
    pub capability: Option<String>,
    pub declarable: Option<bool>,
    pub throws_allowed: Option<bool>,
    pub description: String,
}

/// Every built-in document, parsed once. A malformed entry is a build defect in
/// the vocabulary itself, so it panics with the file it came from.
pub fn builtin_entries() -> &'static [BuiltinEntry] {
    static ENTRIES: OnceLock<Vec<BuiltinEntry>> = OnceLock::new();
    ENTRIES.get_or_init(|| {
        ENTRY_FILES
            .iter()
            .map(|(file, text)| {
                let data: Value = serde_json::from_str(text)
                    .unwrap_or_else(|err| panic!("sdk/builtins/{file} is not JSON: {err}"));
                let text_at = |pointer: &str| data.pointer(pointer).and_then(Value::as_str).map(str::to_string);
                let name = text_at("/metadata/name")
                    .unwrap_or_else(|| panic!("sdk/builtins/{file} declares no metadata.name"));
                BuiltinEntry {
                    file,
                    kind: text_at("/kind")
                        .unwrap_or_else(|| panic!("sdk/builtins/{file} declares no kind")),
                    name: format!("Telo.{name}"),
                    capability: text_at("/capability"),
                    declarable: data.get("declarable").and_then(Value::as_bool),
                    throws_allowed: data.get("throwsAllowed").and_then(Value::as_bool),
                    description: text_at("/metadata/description").unwrap_or_default(),
                }
            })
            .collect()
    })
}

/// Capabilities the Rust kernel can host today — what THIS host implements,
/// which no entry states. A definition declaring any other role loads fine and
/// fails with a precise message if a resource of that kind is declared — the
/// lifecycle it asks for does not exist here yet, and pretending otherwise would
/// run it as something it is not.
pub const SUPPORTED_CAPABILITIES: &[&str] = &["Telo.Invocable"];

pub fn is_supported_capability(name: &str) -> bool {
    SUPPORTED_CAPABILITIES.contains(&name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capability_roster::is_capability_role;

    /// Every file of `sdk/builtins/` is embedded, and nothing else.
    #[test]
    fn embeds_every_entry_of_the_directory() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../sdk/builtins");
        let mut on_disk: Vec<String> = std::fs::read_dir(&dir)
            .expect("sdk/builtins is readable")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".json"))
            .collect();
        on_disk.sort();
        let embedded: Vec<String> = ENTRY_FILES.iter().map(|(file, _)| file.to_string()).collect();
        assert_eq!(embedded, on_disk);
    }

    #[test]
    fn names_every_entry_after_its_file() {
        for entry in builtin_entries() {
            assert_eq!(format!("Telo.{}", entry.file.trim_end_matches(".json")), entry.name);
        }
    }

    #[test]
    fn hosts_only_roster_roles() {
        for name in SUPPORTED_CAPABILITIES {
            assert!(is_capability_role(name), "'{name}' is not a roster role");
        }
    }
}
