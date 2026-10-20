//! A search is linear in its text: the machine visits each instruction at most once per
//! position, so a text of n code points costs at most (|program| + 1) × (n + 1) visits,
//! and doubling the text no more than doubles them, give or take one ramp of threads up to
//! the program's length — for the patterns a backtracking engine
//! takes exponential time on, and for a class repeated a thousand times.
//!
//! No Node test file is the twin of this one, and the counts are this crate's own: re2js
//! counts nothing. Each search asks for the whole match's span, so threads carry capture
//! slots, and none of the texts matches, so every position is searched.

use telorun_cel::{re2_pattern, Re2Flags};

/// `(pattern, the text unit repeated to length)`: an ASCII unit, so a byte is a code point.
fn cases() -> [(&'static str, String); 4] {
    [
        ("(a*)*b", "a".to_owned()),
        ("(a|aa)*c", "a".to_owned()),
        ("(x+x+)+y", "x".to_owned()),
        ("\\pL{1000}", format!("{}1", "a".repeat(999))),
    ]
}

#[test]
fn visits_at_most_each_instruction_once_per_position() {
    for (pattern, unit) in cases() {
        let program = re2_pattern(pattern, Re2Flags::NONE).expect("accepted");
        let bound = |n: u64| (program.instruction_count() as u64 + 1) * (n + 1);
        let mut previous: Option<u64> = None;
        let mut length: usize = 1;
        while length <= 64 * 1024 {
            let repeats = length.div_ceil(unit.len());
            let text = &unit.repeat(repeats)[..length];
            let points = length as u64;
            let search = program.search(text, 0, 1);
            assert_eq!(search.groups, None, "{pattern} over {length} bytes");
            assert!(search.visits <= bound(points), "{pattern} over {length} bytes: {} visits", search.visits);
            // Doubling the text at most doubles the count, less what one ramp of threads up to
            // the program's length can cost: (|program| + 1)² visits.
            if let Some(previous) = previous {
                let ramp = (program.instruction_count() as u64 + 1).pow(2);
                assert!(
                    search.visits <= 2 * previous + ramp,
                    "{pattern}: {previous} visits at {} bytes, {} at {length}",
                    length / 2,
                    search.visits
                );
            }
            previous = Some(search.visits);
            length *= 2;
        }
    }
}
