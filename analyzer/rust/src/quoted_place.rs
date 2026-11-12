//! A diagnostic whose message quotes a place of its own declaration, the quote recorded in
//! `data.quotedPlace`. Mirrors the part of `../../nodejs/src/quoted-place.ts` a message
//! quoting one dotted path at or above its own `data.path` needs (`withQuotedPath` over
//! one string); the relocation half has no twin, since this analyzer moves no finding.
//! Node's `parseKeys` / `pathText` live in `template-expansion.ts`, which has no Rust twin.

use serde::Serialize;

use crate::types::AnalysisDiagnostic;

/// How a message quotes one place of its declaration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct QuotedPlace {
    /// The text between the previous quote (or the message start) and this one.
    pub before: String,
    /// The text after this quote: only the last quote of a message carries any.
    pub after: String,
    /// The quoted place, as a path in the coordinates of `data.path`.
    pub place: String,
    /// How many leading keys of `place` lie above the place the text is relative to.
    pub from: usize,
    /// The `data.path` the message was rendered for.
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub form: Option<QuotedForm>,
}

/// How a place is written in a message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum QuotedForm {
    Pointer,
    Dotted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Key {
    Name(String),
    Index(u64),
}

/// `a.b[0].c` → `a`, `b`, 0, `c`: each run of characters other than `.`, `[` and `]`, and
/// each `[<digits>]`.
fn parse_keys(path: &str) -> Vec<Key> {
    let chars: Vec<char> = path.chars().collect();
    let mut keys = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if !matches!(c, '.' | '[' | ']') {
            let start = i;
            while i < chars.len() && !matches!(chars[i], '.' | '[' | ']') {
                i += 1;
            }
            keys.push(Key::Name(chars[start..i].iter().collect()));
            continue;
        }
        if c == '[' {
            let mut j = i + 1;
            while j < chars.len() && chars[j].is_ascii_digit() {
                j += 1;
            }
            if j > i + 1 && j < chars.len() && chars[j] == ']' {
                if let Ok(index) = chars[i + 1..j].iter().collect::<String>().parse() {
                    keys.push(Key::Index(index));
                    i = j + 1;
                    continue;
                }
            }
        }
        i += 1;
    }
    keys
}

/// A key as text: an index and the name spelling it are one key.
fn key_text(key: &Key) -> String {
    match key {
        Key::Name(name) => name.clone(),
        Key::Index(index) => index.to_string(),
    }
}

fn path_text(keys: &[Key]) -> String {
    let mut out = String::new();
    for key in keys {
        match key {
            Key::Index(index) => out.push_str(&format!("[{index}]")),
            Key::Name(name) if out.is_empty() => out.push_str(name),
            Key::Name(name) => {
                out.push('.');
                out.push_str(name);
            }
        }
    }
    out
}

/// `d` with the quote its message makes of `quoted`, a dotted path written in single
/// quotes, at or above the diagnostic's `data.path`. A message not writing it so is left
/// as it is.
pub fn with_quoted_path(mut d: AnalysisDiagnostic, quoted: &str) -> AnalysisDiagnostic {
    let Some(path) = d.data.as_ref().and_then(|data| data.path.clone()) else { return d };
    let keys = parse_keys(quoted);
    if path_text(&keys) != quoted {
        return d;
    }
    let under = parse_keys(&path);
    if keys.len() > under.len() || keys.iter().zip(&under).any(|(key, at)| key_text(key) != key_text(at)) {
        return d;
    }
    let Some(at) = d.message.find(&format!("'{quoted}'")) else { return d };
    let before = d.message[..at + 1].to_string();
    let after = d.message[at + 1 + quoted.len()..].to_string();
    let quote = QuotedPlace {
        before,
        after,
        place: quoted.to_string(),
        from: 0,
        path,
        form: Some(QuotedForm::Dotted),
    };
    if let Some(data) = d.data.as_mut() {
        data.quoted_place = Some(vec![quote]);
    }
    d
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::DiagnosticData;

    fn diagnostic(message: &str, path: &str) -> AnalysisDiagnostic {
        AnalysisDiagnostic::error(
            "X",
            message,
            DiagnosticData { path: Some(path.to_string()), ..Default::default() },
        )
    }

    #[test]
    fn records_the_quote_of_the_diagnostic_s_own_path() {
        let d = with_quoted_path(diagnostic("K/n: thing at 'mounts[0].mount' is wrong", "mounts[0].mount"), "mounts[0].mount");
        let quotes = d.data.unwrap().quoted_place.unwrap();
        assert_eq!(
            quotes,
            vec![QuotedPlace {
                before: "K/n: thing at '".into(),
                after: "' is wrong".into(),
                place: "mounts[0].mount".into(),
                from: 0,
                path: "mounts[0].mount".into(),
                form: Some(QuotedForm::Dotted),
            }]
        );
    }

    #[test]
    fn leaves_a_place_beside_the_path_or_not_written_as_a_quote() {
        let d = with_quoted_path(diagnostic("K/n: at 'other' here", "mounts[0]"), "other");
        assert_eq!(d.data.unwrap().quoted_place, None);
        let d = with_quoted_path(diagnostic("K/n: at mounts here", "mounts"), "mounts");
        assert_eq!(d.data.unwrap().quoted_place, None);
    }
}
