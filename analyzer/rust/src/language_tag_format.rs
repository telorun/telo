//! The `language-tag` Telo format: RFC 5646 §2.1's `Language-Tag` production —
//! well-formed, compared case-insensitively; whether a subtag is registered is not asked.
//! Mirrors `../../nodejs/src/language-tag-format.ts` and runs the same conformance set,
//! `sdk/formats/language-tag.json`. Offsets count UTF-16 code units of the lower-cased
//! text, as the Node checker counts them.

use telorun_cel::es_to_lower_case;

use crate::telo_format::{fail, FormatFailure};

/// RFC 5646's `grandfathered` production, irregular and regular.
const GRANDFATHERED: [&str; 26] = [
    "en-gb-oed", "i-ami", "i-bnn", "i-default", "i-enochian", "i-hak", "i-klingon", "i-lux", "i-mingo", "i-navajo",
    "i-pwn", "i-tao", "i-tay", "i-tsu", "sgn-be-fr", "sgn-be-nl", "sgn-ch-de", "art-lojban", "cel-gaulish", "no-bok",
    "no-nyn", "zh-guoyu", "zh-hakka", "zh-min", "zh-min-nan", "zh-xiang",
];

struct Subtag {
    text: String,
    offset: usize,
}

fn is_alpha(subtag: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&subtag.len()) && subtag.bytes().all(|b| b.is_ascii_lowercase())
}

fn is_alphanum(subtag: &str) -> bool {
    !subtag.is_empty() && subtag.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

fn is_variant(subtag: &str) -> bool {
    ((5..=8).contains(&subtag.len()) && is_alphanum(subtag))
        || (subtag.len() == 4 && subtag.as_bytes()[0].is_ascii_digit() && is_alphanum(subtag))
}

fn is_region(subtag: &str) -> bool {
    is_alpha(subtag, 2, 2) || (subtag.len() == 3 && subtag.bytes().all(|b| b.is_ascii_digit()))
}

fn is_singleton(subtag: &str) -> bool {
    subtag.len() == 1 && is_alphanum(subtag) && subtag != "x"
}

pub fn check(value: &str) -> Option<FormatFailure> {
    if value.is_empty() {
        return fail("a language tag is not empty", 0);
    }
    let lower = es_to_lower_case(value);
    if GRANDFATHERED.contains(&lower.as_str()) {
        return None;
    }
    let mut subtags: Vec<Subtag> = Vec::new();
    let mut offset = 0;
    for text in lower.split('-') {
        let length = text.encode_utf16().count();
        if text.is_empty() || length > 8 || !is_alphanum(text) {
            return fail("a subtag is 1 to 8 letters or digits, separated by -", offset);
        }
        subtags.push(Subtag { text: text.to_string(), offset });
        offset += length + 1;
    }
    let next = |at: usize| subtags.get(at).map(|s| s.text.as_str());
    let private_use = |at: usize| -> Option<FormatFailure> {
        if at + 1 >= subtags.len() {
            return fail("x introduces a private-use part and must be followed by a subtag", subtags[at].offset);
        }
        None
    };
    let first = &subtags[0];
    if first.text == "x" {
        return private_use(0);
    }
    if !is_alpha(&first.text, 2, 8) {
        return fail("a language tag starts with a language subtag of 2 to 8 letters", first.offset);
    }
    let mut at = 1;
    if first.text.len() <= 3 {
        let mut count = 0;
        while count < 3 && next(at).is_some_and(|s| is_alpha(s, 3, 3)) {
            at += 1;
            count += 1;
        }
    }
    if next(at).is_some_and(|s| is_alpha(s, 4, 4)) {
        at += 1;
    }
    if next(at).is_some_and(is_region) {
        at += 1;
    }
    while next(at).is_some_and(is_variant) {
        at += 1;
    }
    while next(at).is_some_and(is_singleton) {
        let singleton = at;
        at += 1;
        let start = at;
        while next(at).is_some_and(|s| s.len() >= 2) {
            at += 1;
        }
        if at == start {
            return fail(
                format!("extension {} must be followed by a subtag of 2 to 8 letters or digits", subtags[singleton].text),
                subtags[singleton].offset,
            );
        }
    }
    if next(at) == Some("x") {
        return private_use(at);
    }
    if let Some(stray) = subtags.get(at) {
        return fail(
            format!(
                "{} is not a subtag that can appear here: expected a script, region, variant, extension or private-use part",
                stray.text
            ),
            stray.offset,
        );
    }
    None
}

#[cfg(test)]
mod tests {
    #[test]
    fn holds_the_entry_s_conformance_set() {
        crate::telo_format::assert_conformance("language-tag", include_str!("../../../sdk/formats/language-tag.json"));
    }
}
