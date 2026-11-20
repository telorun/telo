//! The `cpe` Telo format: a CPE 2.3 formatted string (NISTIR 7695 §6.2). Mirrors
//! `../../nodejs/src/cpe-format.ts` and runs the same conformance set,
//! `sdk/formats/cpe.json`.

use crate::telo_format::{fail, text, FormatFailure};

const CPE_FIELDS: usize = 13;
const CPE_ATTRIBUTES: [&str; 11] = [
    "part", "vendor", "product", "version", "update", "edition", "language", "sw_edition",
    "target_sw", "target_hw", "other",
];

fn is_cpe_plain(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-' | '*' | '?')
}

fn is_cpe_escapable(c: char) -> bool {
    c.is_ascii_punctuation()
}

/// Split on colons a backslash does not escape, keeping each field's offset.
fn cpe_fields(chars: &[char]) -> Vec<(Vec<char>, usize)> {
    let mut fields = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\\' {
            i += 1;
        } else if chars[i] == ':' {
            fields.push((chars[start..i].to_vec(), start));
            start = i + 1;
        }
        i += 1;
    }
    fields.push((chars[start.min(chars.len())..].to_vec(), start));
    fields
}

pub(crate) fn check(value: &str) -> Option<FormatFailure> {
    let chars: Vec<char> = value.chars().collect();
    if !value.starts_with("cpe:") {
        return fail("a CPE 2.3 formatted string starts with cpe:2.3:", 0);
    }
    let fields = cpe_fields(&chars);
    if fields.get(1).map(|(text, _)| text.iter().collect::<String>()).as_deref() != Some("2.3") {
        return fail(
            "only CPE 2.3 formatted strings are accepted, so the second field must be 2.3",
            fields.get(1).map_or(chars.len(), |(_, offset)| *offset),
        );
    }
    if fields.len() != CPE_FIELDS {
        return fail(
            format!("a CPE 2.3 formatted string has {CPE_FIELDS} colon-separated fields, this one has {}", fields.len()),
            chars.len(),
        );
    }
    for i in 2..CPE_FIELDS {
        let (field, offset) = &fields[i];
        let name = CPE_ATTRIBUTES[i - 2];
        if field.is_empty() {
            return fail(format!("the {name} field is empty: write * for any value"), *offset);
        }
        if i == 2 && !matches!(text(field).as_str(), "a" | "o" | "h") {
            return fail("the part must be a (application), o (operating system) or h (hardware)", *offset);
        }
        let mut j = 0;
        while j < field.len() {
            let ch = field[j];
            if ch == '\\' {
                match field.get(j + 1) {
                    Some(next) if is_cpe_escapable(*next) => j += 1,
                    _ => {
                        return fail(
                            format!("the {name} field has a backslash that escapes no punctuation"),
                            offset + j,
                        )
                    }
                }
            } else if !is_cpe_plain(ch) {
                return fail(format!("the {name} field has '{ch}', which must be written \\{ch}"), offset + j);
            }
            j += 1;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telo_format::assert_conformance;

    #[test]
    fn agrees_with_the_shared_conformance_set() {
        assert_conformance("cpe", include_str!("../../../sdk/formats/cpe.json"));
    }

    #[test]
    fn words_a_cpe_with_too_few_fields() {
        let failure = check("cpe:2.3:a:sqlite:sqlite:3.51.3").unwrap();
        assert!(failure.reason.contains("13 colon-separated fields, this one has 6"));
    }
}
