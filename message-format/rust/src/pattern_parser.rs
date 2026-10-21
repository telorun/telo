//! The `message-pattern` profile: MessageFormat 2's `pattern` production limited to
//! literal text, variable placeholders `{$name}` and the escapes `\{`, `\}`, `\\`.
//! Inside braces MF2's optional whitespace and bidi marks are accepted; the canonical
//! form drops them. Ranges count UTF-16 code units, as the Node core's do.

use crate::message_model::{Pattern, PatternPart};
use crate::message_problem::{syntax_problem, MessageProblem, SourceRange};
use crate::placeholder_name::placeholder_name_refusal;

fn is_whitespace(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\r' | '\n' | '\u{3000}')
}

fn is_bidi(c: char) -> bool {
    matches!(c, '\u{061C}' | '\u{200E}' | '\u{200F}' | '\u{2066}'..='\u{2069}')
}

pub fn parse_pattern(source: &str) -> Result<Pattern, MessageProblem> {
    parse_pattern_at(source, &[])
}

pub(crate) fn parse_pattern_at(source: &str, path: &[String]) -> Result<Pattern, MessageProblem> {
    let chars: Vec<char> = source.chars().collect();
    let mut offsets = Vec::with_capacity(chars.len() + 1);
    let mut unit = 0;
    for c in &chars {
        offsets.push(unit);
        unit += c.len_utf16();
    }
    offsets.push(unit);
    let fail = |message: String, start: usize, end: usize| {
        Err(syntax_problem(message, path.to_vec(), Some(SourceRange { start: offsets[start], end: offsets[end] })))
    };

    let mut parts = Vec::new();
    let mut text = String::new();
    let mut at = 0;
    let skip_optional = |at: &mut usize| {
        while *at < chars.len() && (is_whitespace(chars[*at]) || is_bidi(chars[*at])) {
            *at += 1;
        }
    };

    while at < chars.len() {
        let c = chars[at];
        if c == '\\' {
            if at + 1 >= chars.len() {
                return fail("a \\ at the end of the text escapes nothing".into(), at, at + 1);
            }
            let next = chars[at + 1];
            if matches!(next, '\\' | '{' | '}') {
                text.push(next);
                at += 2;
                continue;
            }
            return fail(
                format!("\\{next} is not an escape: text escapes only \\{{, \\}} and \\\\"),
                at,
                at + 2,
            );
        }
        if c == '}' {
            return fail("a } in text is written \\}".into(), at, at + 1);
        }
        if c == '\0' {
            return fail("U+0000 cannot appear in a message".into(), at, at + 1);
        }
        if c != '{' {
            text.push(c);
            at += 1;
            continue;
        }

        let open = at;
        at += 1;
        skip_optional(&mut at);
        if at >= chars.len() {
            return fail("the placeholder is not closed".into(), open, chars.len());
        }
        if chars[at] != '$' {
            return fail("a placeholder is written {$name}".into(), open, at + 1);
        }
        let dollar = at;
        at += 1;
        if at < chars.len() && is_bidi(chars[at]) {
            at += 1;
        }
        let name_start = at;
        while at < chars.len() {
            let next = chars[at];
            if is_whitespace(next) || is_bidi(next) || next == '{' || next == '}' {
                break;
            }
            at += 1;
        }
        let name: String = chars[name_start..at].iter().collect();
        if name.is_empty() {
            return fail("$ must be followed by a placeholder name".into(), dollar, dollar + 1);
        }
        if let Some(refusal) = placeholder_name_refusal(&name) {
            return fail(refusal, name_start, at);
        }
        skip_optional(&mut at);
        if at >= chars.len() {
            return fail("the placeholder is not closed".into(), open, chars.len());
        }
        if chars[at] != '}' {
            return fail("a placeholder holds only its $name".into(), at, at + 1);
        }
        at += 1;
        if !text.is_empty() {
            parts.push(PatternPart::Text(std::mem::take(&mut text)));
        }
        parts.push(PatternPart::Placeholder(name));
    }
    if !text.is_empty() {
        parts.push(PatternPart::Text(text));
    }
    Ok(parts)
}
