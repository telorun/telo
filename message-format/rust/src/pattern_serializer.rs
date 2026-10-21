use crate::message_model::PatternPart;

/// A pattern in its one canonical spelling: `\`, `{` and `}` escaped, every
/// placeholder written `{$name}`. Reading it back answers the same pattern.
pub fn serialize_pattern(pattern: &[PatternPart]) -> String {
    let mut text = String::new();
    for part in pattern {
        match part {
            PatternPart::Text(literal) => {
                for c in literal.chars() {
                    if matches!(c, '\\' | '{' | '}') {
                        text.push('\\');
                    }
                    text.push(c);
                }
            }
            PatternPart::Placeholder(name) => {
                text.push_str("{$");
                text.push_str(name);
                text.push('}');
            }
        }
    }
    text
}
