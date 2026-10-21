//! Which CLDR data a language tag reads: case-insensitively, extensions set aside, by
//! CLDR inheritance — number data through the main component (an explicit parent, else
//! the root for `lang-Script` with a script other than the likely one, else truncation),
//! plural rules through the plurals component's own parents, else truncation. Every
//! chain ends at the root.

use std::collections::HashMap;
use std::sync::OnceLock;

use crate::cldr_tables::{read_tables, CldrNumberEntry, CldrTables, PluralRuleSet};
use crate::message_model::PluralCategory;

/// The CLDR release the data is; equal to the `cldrVersion` every data file records.
pub const CLDR_VERSION: &str = "48.2.0";

const ROOT: &str = "root";

pub(crate) fn cldr() -> &'static CldrTables {
    static TABLES: OnceLock<CldrTables> = OnceLock::new();
    TABLES.get_or_init(read_tables)
}

/// The tag a lookup starts from: lowercase, without its extensions.
fn lookup_start(tag: &str) -> String {
    let lowered = tag.to_ascii_lowercase();
    let subtags: Vec<&str> = lowered.split('-').collect();
    let end = subtags
        .iter()
        .enumerate()
        .position(|(index, subtag)| index > 0 && subtag.encode_utf16().count() == 1)
        .unwrap_or(subtags.len());
    let start = subtags[..end].join("-");
    if start.is_empty() {
        ROOT.to_string()
    } else {
        start
    }
}

fn truncate(tag: &str) -> String {
    match tag.rfind('-') {
        Some(cut) => tag[..cut].to_string(),
        None => ROOT.to_string(),
    }
}

fn main_parent(tag: &str) -> Option<String> {
    if tag == ROOT {
        return None;
    }
    let tables = cldr();
    if let Some(explicit) = tables.main_parents.get(tag) {
        return Some(explicit.clone());
    }
    let subtags: Vec<&str> = tag.split('-').collect();
    if subtags.len() == 2
        && subtags[1].len() == 4
        && subtags[1].bytes().all(|b| b.is_ascii_lowercase())
        && tables.likely_scripts.get(subtags[0]).map(String::as_str) != Some(subtags[1])
    {
        return Some(ROOT.to_string());
    }
    Some(truncate(tag))
}

fn plural_parent(tag: &str) -> Option<String> {
    if tag == ROOT {
        return None;
    }
    Some(cldr().plural_parents.get(tag).cloned().unwrap_or_else(|| truncate(tag)))
}

fn resolve<'a, T>(table: &'a HashMap<String, T>, tag: &str, parent: fn(&str) -> Option<String>) -> &'a T {
    let mut at = Some(lookup_start(tag));
    while let Some(tag) = at {
        if let Some(found) = table.get(&tag) {
            return found;
        }
        at = parent(&tag);
    }
    panic!("the CLDR data has no root locale")
}

pub(crate) fn number_entry_for(tag: &str) -> &'static CldrNumberEntry {
    resolve(&cldr().numbers, tag, main_parent)
}

pub(crate) fn plural_rule_set_for(tag: &str) -> &'static PluralRuleSet {
    resolve(&cldr().plurals, tag, plural_parent)
}

/// The plural categories `lang` has, in CLDR's order (`other` last).
pub fn plural_categories(lang: &str) -> Vec<PluralCategory> {
    plural_rule_set_for(lang).categories.clone()
}
