//! RFC 4647 lookup (§3.4): a requested tag is truncated one subtag at a time, a
//! singleton (or run of them) left at the end going with the subtag after it, and the
//! first tag available wins. Tags compare case-insensitively (ASCII); the answer is the
//! available tag as it was written.

use std::collections::HashMap;

pub fn truncation_chain(tag: &str) -> Vec<String> {
    if tag.is_empty() {
        return Vec::new();
    }
    let mut chain = vec![tag.to_string()];
    let mut subtags: Vec<&str> = tag.split('-').collect();
    while subtags.len() > 1 {
        subtags.pop();
        while subtags.len() > 1 && subtags.last().is_some_and(|last| last.encode_utf16().count() == 1) {
            subtags.pop();
        }
        chain.push(subtags.join("-"));
    }
    chain
}

pub fn lookup_language<'a, I, S>(requested: &str, available: I) -> Option<&'a str>
where
    I: IntoIterator<Item = &'a S>,
    S: AsRef<str> + ?Sized + 'a,
{
    let mut by_key: HashMap<String, &'a str> = HashMap::new();
    for tag in available {
        let tag = tag.as_ref();
        by_key.entry(tag.to_ascii_lowercase()).or_insert(tag);
    }
    truncation_chain(requested).into_iter().find_map(|candidate| by_key.get(&candidate.to_ascii_lowercase()).copied())
}
