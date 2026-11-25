//! The `message-pattern` Telo format: the message core's own pattern parser, so a slot of
//! this format accepts exactly the patterns a Message holds. Mirrors
//! `../../nodejs/src/message-pattern-format.ts` and runs the same conformance set,
//! `sdk/formats/message-pattern.json`.

use crate::telo_format::{fail, FormatFailure};

pub fn check(value: &str) -> Option<FormatFailure> {
    match telorun_message_format::parse_pattern(value) {
        Ok(_) => None,
        Err(problem) => fail(problem.message, problem.range.map_or(0, |range| range.start as usize)),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn holds_the_entry_s_conformance_set() {
        crate::telo_format::assert_conformance("message-pattern", include_str!("../../../sdk/formats/message-pattern.json"));
    }
}
