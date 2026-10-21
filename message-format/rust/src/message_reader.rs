//! Reads a Message, or a Text, from JSON data. A value that is not a well-formed
//! Message or Text is refused as `MESSAGE_SYNTAX_INVALID`, every fault reported where
//! it sits, in the order the Node core reports them.

use crate::json_value::JsonValue;
use crate::message_model::{Message, PluralCategory, PluralSelection, Text};
use crate::message_problem::{syntax_problem, MessageProblem};
use crate::pattern_parser::parse_pattern_at;
use crate::placeholder_name::placeholder_name_refusal;

pub fn read_message(data: &JsonValue) -> Result<Message, Vec<MessageProblem>> {
    let mut problems = Vec::new();
    match read_message_at(data, &[], &mut problems) {
        Some(message) if problems.is_empty() => Ok(message),
        _ => Err(problems),
    }
}

pub fn read_text(data: &JsonValue) -> Result<Text, Vec<MessageProblem>> {
    let mut problems = Vec::new();
    let entries = match data.as_object() {
        Some(entries) if entries.iter().any(|(key, _)| key == "text" || key == "context") => entries,
        _ => {
            return match read_message_at(data, &[], &mut problems) {
                Some(message) if problems.is_empty() => Ok(Text { message, context: None }),
                _ => Err(problems),
            };
        }
    };
    for (key, _) in entries {
        if key != "text" && key != "context" {
            problems.push(syntax_problem(format!("{key} is not a key of a text: it holds text and context"), vec![key.clone()], None));
        }
    }
    let message = match data.get("text") {
        Some(text) => read_message_at(text, &["text".to_string()], &mut problems),
        None => {
            problems.push(syntax_problem("a text written as an object holds its message in text".into(), vec![], None));
            None
        }
    };
    let context = match data.get("context") {
        None => {
            problems.push(syntax_problem(
                "a text written as an object names its context; write the message alone for no context".into(),
                vec![],
                None,
            ));
            None
        }
        Some(JsonValue::String(context)) if context.is_empty() => {
            problems.push(syntax_problem(
                "context cannot be empty: write the message alone for no context".into(),
                vec!["context".into()],
                None,
            ));
            None
        }
        Some(JsonValue::String(context)) => Some(context.clone()),
        Some(_) => {
            problems.push(syntax_problem("context is a string".into(), vec!["context".into()], None));
            None
        }
    };
    match (message, context) {
        (Some(message), Some(context)) if problems.is_empty() => Ok(Text { message, context: Some(context) }),
        _ => Err(problems),
    }
}

/// Why `key` is not a case of a selection, or `None` when it is one.
fn case_key_refusal(key: &str) -> Option<String> {
    if PluralCategory::from_key(key).is_some() {
        return None;
    }
    let Some(integer) = key.strip_prefix('=') else {
        return Some(format!("{key} is not a case: a case is zero, one, two, few, many, other or =N"));
    };
    let digits = integer.strip_prefix('-').unwrap_or(integer);
    let canonical = !digits.is_empty()
        && digits.bytes().all(|b| b.is_ascii_digit())
        && (digits == "0" || !digits.starts_with('0'))
        && integer != "-0";
    if !canonical {
        return Some(format!(
            "{key} is not a case: an exact case is = and an integer written with no leading zero, no + and no -0"
        ));
    }
    let in_range = digits.len() <= 20
        && integer.parse::<i128>().is_ok_and(|value| value >= i64::MIN as i128 && value <= u64::MAX as i128);
    if !in_range {
        return Some(format!("{key} is outside the 64-bit integer range of an exact case"));
    }
    None
}

fn with(path: &[String], keys: &[&str]) -> Vec<String> {
    let mut out = path.to_vec();
    out.extend(keys.iter().map(|key| key.to_string()));
    out
}

fn read_message_at(data: &JsonValue, path: &[String], problems: &mut Vec<MessageProblem>) -> Option<Message> {
    let entries = match data {
        JsonValue::String(source) => {
            return match parse_pattern_at(source, path) {
                Ok(pattern) => Some(Message::Pattern(pattern)),
                Err(problem) => {
                    problems.push(problem);
                    None
                }
            };
        }
        JsonValue::Object(entries) => entries,
        _ => {
            problems.push(syntax_problem("a message is text or a plural selection".into(), path.to_vec(), None));
            return None;
        }
    };
    let before = problems.len();
    for (key, _) in entries {
        if key != "plural" && key != "cases" {
            problems.push(syntax_problem(
                format!("{key} is not a key of a plural selection: it holds plural and cases"),
                with(path, &[key]),
                None,
            ));
        }
    }
    let plural = match data.get("plural") {
        None => {
            problems.push(syntax_problem("a plural selection names its selector in plural".into(), path.to_vec(), None));
            None
        }
        Some(JsonValue::String(name)) => match placeholder_name_refusal(name) {
            None => Some(name.clone()),
            Some(refusal) => {
                problems.push(syntax_problem(refusal, with(path, &["plural"]), None));
                None
            }
        },
        Some(_) => {
            problems.push(syntax_problem(
                "plural holds the bare name of the number it selects on".into(),
                with(path, &["plural"]),
                None,
            ));
            None
        }
    };
    let mut cases = Vec::new();
    match data.get("cases") {
        None => problems.push(syntax_problem("a plural selection lists its cases in cases".into(), path.to_vec(), None)),
        Some(JsonValue::Object(written)) => {
            for (key, value) in written {
                let case_path = with(path, &["cases", key]);
                if let Some(refusal) = case_key_refusal(key) {
                    problems.push(syntax_problem(refusal, case_path, None));
                    continue;
                }
                if let Some(message) = read_message_at(value, &case_path, problems) {
                    cases.push((key.clone(), message));
                }
            }
            if !written.iter().any(|(key, _)| key == "other") {
                problems.push(syntax_problem("a plural selection needs an other case".into(), with(path, &["cases"]), None));
            }
        }
        Some(_) => problems.push(syntax_problem(
            "cases maps each plural category or =N to a message".into(),
            with(path, &["cases"]),
            None,
        )),
    }
    match plural {
        Some(plural) if problems.len() == before => Some(Message::Selection(PluralSelection { plural, cases })),
        _ => None,
    }
}
