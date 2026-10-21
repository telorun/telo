//! Formats a Message in a language with values for the names it reads. Every name must
//! be bound, on every branch; a placeholder takes a string or a number, a selector a
//! number. A selection matches its `=N` cases first, numerically against the number as
//! rounded for display, then the language's plural category, then `other`.

use std::collections::HashMap;

use crate::cldr_locale::number_entry_for;
use crate::message_model::{Message, PatternPart};
use crate::message_problem::{MessageCode, MessageFormatError};
use crate::number_format::{
    category_of_operands, decimal_equals, decimal_operands, localized_decimal, number_refusal, rounded_decimal,
    NumberValue,
};

#[derive(Clone, Debug, PartialEq)]
pub enum MessageValue {
    String(String),
    Int(i64),
    Uint(u64),
    Double(f64),
}

impl MessageValue {
    fn number(&self) -> Option<NumberValue> {
        match self {
            MessageValue::String(_) => None,
            MessageValue::Int(value) => Some(NumberValue::Int(*value)),
            MessageValue::Uint(value) => Some(NumberValue::Uint(*value)),
            MessageValue::Double(value) => Some(NumberValue::Double(*value)),
        }
    }
}

/// Refuses the first name, in written order, that is unbound or bound to a value it cannot take.
fn check_values(message: &Message, values: &HashMap<String, MessageValue>) -> Result<(), MessageFormatError> {
    let check = |name: &str, selector: bool| -> Result<(), MessageFormatError> {
        let Some(value) = values.get(name) else {
            return Err(MessageFormatError {
                code: MessageCode::PlaceholderUnbound,
                message: format!("no value is given for {name}, which the message reads"),
            });
        };
        let subject = format!("the value given for {name}");
        let refusal = match value.number() {
            None if selector => Some(format!("{subject} is not a number, and {name} selects a plural case")),
            None => None,
            Some(number) => number_refusal(number, &subject),
        };
        match refusal {
            Some(message) => Err(MessageFormatError { code: MessageCode::PlaceholderValueUnsupported, message }),
            None => Ok(()),
        }
    };
    let mut pending = vec![message];
    while let Some(at) = pending.pop() {
        match at {
            Message::Pattern(pattern) => {
                for part in pattern {
                    if let PatternPart::Placeholder(name) = part {
                        check(name, false)?;
                    }
                }
            }
            Message::Selection(selection) => {
                check(&selection.plural, true)?;
                pending.extend(selection.cases.iter().rev().map(|(_, case)| case));
            }
        }
    }
    Ok(())
}

pub fn format_message(
    message: &Message,
    lang: &str,
    values: &HashMap<String, MessageValue>,
) -> Result<String, MessageFormatError> {
    check_values(message, values)?;
    let entry = number_entry_for(lang);
    let mut at = message;
    let pattern = loop {
        match at {
            Message::Pattern(pattern) => break pattern,
            Message::Selection(selection) => {
                let number = values[&selection.plural].number().expect("a checked selector is a number");
                let decimal = rounded_decimal(number, &entry.pattern);
                let exact = selection
                    .cases
                    .iter()
                    .find(|(key, _)| key.strip_prefix('=').is_some_and(|integer| decimal_equals(&decimal, integer)))
                    .map(|(_, case)| case);
                at = exact
                    .or_else(|| selection.case(category_of_operands(&decimal_operands(&decimal), lang).as_str()))
                    .unwrap_or_else(|| selection.other());
            }
        }
    };
    let mut text = String::new();
    for part in pattern {
        match part {
            PatternPart::Text(literal) => text.push_str(literal),
            PatternPart::Placeholder(name) => match &values[name] {
                MessageValue::String(value) => text.push_str(value),
                value => {
                    let number = value.number().expect("a value that is not a string is a number");
                    text.push_str(&localized_decimal(&rounded_decimal(number, &entry.pattern), entry));
                }
            },
        }
    }
    Ok(text)
}
