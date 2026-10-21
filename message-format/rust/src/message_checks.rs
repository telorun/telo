//! The two checks that relate a read Message to something outside it: its source text
//! and its language.

use std::collections::BTreeSet;

use crate::cldr_locale::plural_categories;
use crate::message_identity::message_variables;
use crate::message_model::{Message, PatternPart, PluralCategory};
use crate::message_problem::{MessageCode, MessageProblem};

/// Visits a message depth-first in written order: each selection before its cases.
fn walk<'a>(message: &'a Message, mut visit: impl FnMut(&'a Message, &[String])) {
    let mut pending: Vec<(&Message, Vec<String>)> = vec![(message, Vec::new())];
    while let Some((at, path)) = pending.pop() {
        visit(at, &path);
        if let Message::Selection(selection) = at {
            for (key, child) in selection.cases.iter().rev() {
                let mut child_path = path.clone();
                child_path.push("cases".into());
                child_path.push(key.clone());
                pending.push((child, child_path));
            }
        }
    }
}

/// `MESSAGE_PLACEHOLDER_UNKNOWN` for each name the translation reads and its source does not.
pub fn unknown_variables(translation: &Message, source: &Message) -> Vec<MessageProblem> {
    let known: BTreeSet<String> = message_variables(source).into_iter().collect();
    let mut problems = Vec::new();
    let unknown = |name: &str, path: Vec<String>| MessageProblem {
        code: MessageCode::PlaceholderUnknown,
        message: format!("{name} is not a placeholder of the source text"),
        path,
        range: None,
    };
    walk(translation, |at, path| match at {
        Message::Pattern(pattern) => {
            let mut reported = BTreeSet::new();
            for part in pattern {
                if let PatternPart::Placeholder(name) = part {
                    if !known.contains(name) && reported.insert(name.clone()) {
                        problems.push(unknown(name, path.to_vec()));
                    }
                }
            }
        }
        Message::Selection(selection) => {
            if !known.contains(&selection.plural) {
                let mut plural_path = path.to_vec();
                plural_path.push("plural".into());
                problems.push(unknown(&selection.plural, plural_path));
            }
        }
    });
    problems
}

/// `MESSAGE_PLURAL_CATEGORY_INVALID` for each case naming a category `lang` lacks.
pub fn invalid_plural_categories(message: &Message, lang: &str) -> Vec<MessageProblem> {
    let categories = plural_categories(lang);
    let listed = categories.iter().map(|category| category.as_str()).collect::<Vec<_>>().join(", ");
    let mut problems = Vec::new();
    walk(message, |at, path| {
        let Message::Selection(selection) = at else { return };
        for (key, _) in &selection.cases {
            let Some(category) = PluralCategory::from_key(key) else { continue };
            if categories.contains(&category) {
                continue;
            }
            let mut case_path = path.to_vec();
            case_path.push("cases".into());
            case_path.push(key.clone());
            problems.push(MessageProblem {
                code: MessageCode::PluralCategoryInvalid,
                message: format!("{key} is not a plural category of {lang}: its categories are {listed}"),
                path: case_path,
                range: None,
            });
        }
    });
    problems
}
