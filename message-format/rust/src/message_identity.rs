//! What identifies a source text — its all-`other` pattern in canonical serialization,
//! with its context — and which names a message reads.

use std::collections::BTreeSet;

use crate::message_model::{Message, PatternPart, Text};
use crate::pattern_serializer::serialize_pattern;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct TextIdentity {
    pub source: String,
    pub context: Option<String>,
}

pub fn message_identity(message: &Message) -> String {
    let mut at = message;
    loop {
        match at {
            Message::Pattern(pattern) => return serialize_pattern(pattern),
            Message::Selection(selection) => at = selection.other(),
        }
    }
}

pub fn text_identity(text: &Text) -> TextIdentity {
    TextIdentity { source: message_identity(&text.message), context: text.context.clone() }
}

/// Every name the message reads — its placeholders and its selectors — sorted, each once.
pub fn message_variables(message: &Message) -> Vec<String> {
    let mut names = BTreeSet::new();
    let mut pending = vec![message];
    while let Some(at) = pending.pop() {
        match at {
            Message::Pattern(pattern) => {
                for part in pattern {
                    if let PatternPart::Placeholder(name) = part {
                        names.insert(name.clone());
                    }
                }
            }
            Message::Selection(selection) => {
                names.insert(selection.plural.clone());
                pending.extend(selection.cases.iter().map(|(_, case)| case));
            }
        }
    }
    names.into_iter().collect()
}
