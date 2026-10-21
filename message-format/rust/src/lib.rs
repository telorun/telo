//! Telo's message core for Rust: the Rust half of `@telorun/message-format`, answering
//! as it answers. See `README.md`.

mod cldr_data;
mod cldr_locale;
mod cldr_tables;
mod decimal_pattern;
mod json_value;
mod language_lookup;
mod message_checks;
mod message_format;
mod message_identity;
mod message_model;
mod message_problem;
mod message_reader;
mod number_format;
mod pattern_parser;
mod pattern_serializer;
mod placeholder_name;
mod plural_operands;
mod plural_rule;

pub use cldr_data::CLDR_LICENSE;
pub use cldr_locale::{plural_categories, CLDR_VERSION};
pub use json_value::{parse_json, JsonError, JsonValue};
pub use language_lookup::{lookup_language, truncation_chain};
pub use message_checks::{invalid_plural_categories, unknown_variables};
pub use message_format::{format_message, MessageValue};
pub use message_identity::{message_identity, message_variables, text_identity, TextIdentity};
pub use message_model::{Message, Pattern, PatternPart, PluralCategory, PluralSelection, Text, PLURAL_CATEGORIES};
pub use message_problem::{MessageCode, MessageFormatError, MessageProblem, SourceRange};
pub use message_reader::{read_message, read_text};
pub use number_format::{format_number, plural_category, plural_category_of_decimal, NumberValue};
pub use pattern_parser::parse_pattern;
pub use pattern_serializer::serialize_pattern;
