//! The expansion refusals the loader makes, mirroring
//! `../../nodejs/src/loader-expansion-refusals.ts`: an expansion construct at a
//! value the loader itself reads before anything is expanded — a module doc's
//! `metadata` (and `metadata.name`), `imports:` (the block, an entry) and
//! `include:` (the block, an entry), and an import's own alias, kind, source and
//! integrity — an `imports:` entry's `source` / `integrity` and a top-level
//! `Telo.Import`'s `kind` / `metadata` / `source` / `integrity`, and a splice at either's
//! top level. `!if` /
//! `!switch` there are `BRANCH_POSITION_INVALID`, `!for-each` and a `...` splice
//! `REPEAT_OUTSIDE_TEMPLATE`. A tag on a scalar or a sequence is refused while the
//! document is converted (`telo_templating::yaml_to_json`). A scope member's
//! import is the Node loader's scoped-import walk, which this loader has no twin of.

use serde_json::Value;
use telo_templating::{expansion_tag_of, SPLICE_KEY};

use crate::types::{kind_of, ResourceManifest};

/// One loader refusal: its code, and where and why. `data_path` is set for a
/// refusal at an import's own field, which carries its document path.
pub struct LoaderRefusal {
    pub code: &'static str,
    pub path: String,
    pub message: String,
    pub data_path: Option<String>,
}

const MODULE_KINDS: &[&str] = &["Telo.Application", "Telo.Library"];
const IMPORT: &str = "Telo.Import";
const IMPORT_FIELDS: [&str; 4] = ["kind", "metadata", "source", "integrity"];

/// Every loader refusal of one document.
pub fn loader_expansion_refusals(manifest: &ResourceManifest) -> Vec<LoaderRefusal> {
    let mut refusals = Refusals { out: Vec::new(), kind: "" };
    if expansion_tag_of(manifest).is_some() {
        return refusals.out;
    }
    if is_import_document(manifest) {
        for refusal in import_field_refusals(manifest, import_alias_of(manifest).as_deref(), &IMPORT_FIELDS) {
            refusals.out.push(LoaderRefusal {
                code: refusal.code,
                data_path: Some(refusal.place.clone()),
                path: refusal.place,
                message: refusal.message,
            });
        }
        return refusals.out;
    }
    let Some(kind) = kind_of(manifest).filter(|kind| MODULE_KINDS.contains(kind)) else {
        return refusals.out;
    };
    refusals.kind = kind;

    let metadata = manifest.get("metadata");
    refusals.tag(metadata, "metadata", "the module's name");
    refusals.splice(metadata, "metadata", "the module's name");
    if metadata.and_then(expansion_tag_of).is_none() {
        refusals.tag(metadata.and_then(|m| m.get("name")), "metadata.name", "the module's name");
    }

    let imports = manifest.get("imports");
    refusals.tag(imports, "imports", "every import");
    refusals.splice(imports, "imports", "every import");
    if let Some(entries) = imports.filter(|i| expansion_tag_of(i).is_none()).and_then(Value::as_object) {
        for (alias, entry) in entries {
            if alias == SPLICE_KEY {
                continue;
            }
            let path = format!("imports.{alias}");
            refusals.tag(Some(entry), &path, "every import");
            if entry.is_object() && expansion_tag_of(entry).is_none() {
                for refusal in import_field_refusals(entry, Some(alias), &["source", "integrity"]) {
                    let at = format!("{path}.{}", refusal.place);
                    refusals.out.push(LoaderRefusal {
                        code: refusal.code,
                        data_path: Some(at.clone()),
                        path: at,
                        message: refusal.message,
                    });
                }
            }
        }
    }

    let include = manifest.get("include");
    refusals.tag(include, "include", "the files it includes");
    if let Some(entries) = include.and_then(Value::as_array) {
        for (index, entry) in entries.iter().enumerate() {
            refusals.tag(Some(entry), &format!("include[{index}]"), "the files it includes");
        }
    }
    refusals.out
}

/// One expansion construct at an import's own field, or a splice at its top level: its
/// code, its place inside the import (`...`, `source`, `integrity`, `kind`, `metadata`,
/// `metadata.name`, `metadata....`) and the sentence.
pub struct ImportFieldRefusal {
    pub code: &'static str,
    pub place: String,
    pub message: String,
}

/// Every expansion construct at the fields of an import the loader reads before anything
/// is expanded, among `fields`, and a `...` splice at its top level, which may write any
/// of them; `alias` labels each message where it is written plainly.
pub fn import_field_refusals(record: &Value, alias: Option<&str>, fields: &[&str]) -> Vec<ImportFieldRefusal> {
    let mut out = Vec::new();
    let label = alias.map_or(String::new(), |alias| format!("{IMPORT}/{alias}: "));
    let mut refuse = |place: String, construct: String, code: &'static str| {
        out.push(ImportFieldRefusal {
            message: format!(
                "{label}{construct} at '{place}' of the {IMPORT}: the loader reads an import's alias and source before anything is expanded, so they cannot be chosen or repeated. Write them plainly."
            ),
            code,
            place,
        });
    };
    let code_of = |tag: &str| if tag == "for-each" { "REPEAT_OUTSIDE_TEMPLATE" } else { "BRANCH_POSITION_INVALID" };
    // A splice at the import's own top level may write any field the loader reads.
    if record.get(SPLICE_KEY).is_some() {
        refuse(SPLICE_KEY.to_string(), format!("A '{SPLICE_KEY}' splice"), "REPEAT_OUTSIDE_TEMPLATE");
    }
    for field in fields {
        let value = record.get(*field);
        if let Some(tag) = value.and_then(expansion_tag_of) {
            refuse(field.to_string(), format!("'!{tag}'"), code_of(tag));
        }
        if *field != "metadata" {
            continue;
        }
        let Some(metadata) = value.and_then(Value::as_object).filter(|_| value.and_then(expansion_tag_of).is_none()) else {
            continue;
        };
        if metadata.contains_key(SPLICE_KEY) {
            refuse(format!("metadata.{SPLICE_KEY}"), format!("A '{SPLICE_KEY}' splice"), "REPEAT_OUTSIDE_TEMPLATE");
        }
        if let Some(tag) = metadata.get("name").and_then(expansion_tag_of) {
            refuse("metadata.name".to_string(), format!("'!{tag}'"), code_of(tag));
        }
    }
    out
}

/// True for an import: `kind: Telo.Import`, or a `kind:` written behind a tag one of whose
/// options, at any depth, names `Telo.Import`.
pub fn is_import_document(record: &Value) -> bool {
    match record.get("kind") {
        Some(Value::String(kind)) => kind == IMPORT,
        Some(kind) if expansion_tag_of(kind).is_some() => option_names_import(kind),
        _ => false,
    }
}

fn option_names_import(sentinel: &Value) -> bool {
    let options: Vec<&Value> = match expansion_tag_of(sentinel) {
        Some("if") => ["then", "else"].iter().filter_map(|key| sentinel.get(*key)).collect(),
        Some("switch") => {
            let mut options: Vec<&Value> =
                sentinel.get("cases").and_then(Value::as_object).map(|cases| cases.values().collect()).unwrap_or_default();
            options.extend(sentinel.get("default"));
            options
        }
        _ => sentinel.get("emit").into_iter().collect(),
    };
    options.into_iter().any(|option| match option {
        Value::String(kind) => kind == IMPORT,
        Value::Array(items) => items.iter().any(|item| expansion_tag_of(item).is_some() && option_names_import(item)),
        other => expansion_tag_of(other).is_some() && option_names_import(other),
    })
}

/// The alias an import names where it is written plainly.
fn import_alias_of(record: &Value) -> Option<String> {
    let metadata = record.get("metadata").filter(|m| expansion_tag_of(m).is_none())?;
    metadata.get("name").and_then(Value::as_str).map(str::to_string)
}

/// True for an import the loader refuses at one of its own fields: it is read no further.
pub fn is_refused_import(record: &Value) -> bool {
    is_import_document(record) && !import_field_refusals(record, None, &IMPORT_FIELDS).is_empty()
}

struct Refusals<'a> {
    out: Vec<LoaderRefusal>,
    kind: &'a str,
}

impl Refusals<'_> {
    fn refuse(&mut self, path: String, construct: String, code: &'static str, reads: &str) {
        self.out.push(LoaderRefusal {
            message: format!(
                "{construct} at '{path}' of the {} document: the loader reads {reads} before anything is expanded, so it cannot be chosen or repeated. Write it plainly.",
                self.kind
            ),
            code,
            path,
            data_path: None,
        });
    }

    fn tag(&mut self, value: Option<&Value>, path: &str, reads: &str) {
        if let Some(tag) = value.and_then(expansion_tag_of) {
            let code = if tag == "for-each" { "REPEAT_OUTSIDE_TEMPLATE" } else { "BRANCH_POSITION_INVALID" };
            self.refuse(path.to_string(), format!("'!{tag}'"), code, reads);
        }
    }

    fn splice(&mut self, value: Option<&Value>, path: &str, reads: &str) {
        if value.and_then(Value::as_object).is_some_and(|object| object.contains_key(SPLICE_KEY)) {
            self.refuse(
                format!("{path}.{SPLICE_KEY}"),
                format!("A '{SPLICE_KEY}' splice"),
                "REPEAT_OUTSIDE_TEMPLATE",
                reads,
            );
        }
    }
}
