//! The expansion refusals the loader makes, mirroring
//! `../../nodejs/src/loader-expansion-refusals.ts`: an expansion construct at a
//! value the loader itself reads before anything is expanded — a module doc's
//! `metadata` (and `metadata.name`), `imports:` (the block, an entry, an entry's
//! `source`) and `include:` (the block, an entry). `!if` / `!switch` there are
//! `BRANCH_POSITION_INVALID`, `!for-each` and a `...` splice
//! `REPEAT_OUTSIDE_TEMPLATE`. A tag on a scalar or a sequence is refused while
//! the document is converted (`telo_templating::yaml_to_json`).

use serde_json::Value;
use telo_templating::{expansion_tag_of, SPLICE_KEY};

use crate::types::{kind_of, ResourceManifest};

/// One loader refusal: its code, and where and why.
pub struct LoaderRefusal {
    pub code: &'static str,
    pub path: String,
    pub message: String,
}

const MODULE_KINDS: &[&str] = &["Telo.Application", "Telo.Library"];

/// Every loader refusal of one document.
pub fn loader_expansion_refusals(manifest: &ResourceManifest) -> Vec<LoaderRefusal> {
    let mut refusals = Refusals { out: Vec::new(), kind: "" };
    if expansion_tag_of(manifest).is_some() {
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
                refusals.tag(entry.get("source"), &format!("{path}.source"), "every import's source");
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
