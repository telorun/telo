//! A search is linear in its text. Asked for the whole match's span, a search runs one of
//! the backtracker, OnePass and the Machine, each visiting each instruction at most once
//! per position, so a text of n code points costs at most (|program| + 1) × (n + 1)
//! visits; asked for no span, the DFA may scan first and decline, so at most three times
//! that. Doubling the text no more than doubles the count, give or take one ramp of threads
//! up to the program's length — for the patterns a backtracking engine takes exponential
//! time on, for a class repeated a thousand times, and for the audit's four: an email-style
//! pattern over text with and without its `@`, a 200-word alternation, and 30,000
//! alternatives of a class and a literal. The Machine forced alone is held to the same bound
//! inside the crate (`re2_program.rs`).
//!
//! No Node test file is the twin of this one, and the counts are this crate's own: re2js
//! counts nothing. None of the texts matches, so every position is searched.

use telorun_cel::{re2_pattern, Re2Flags};

/// `(pattern, the text unit repeated to length, the longest text)`: an ASCII unit, so a byte
/// is a code point.
fn cases() -> Vec<(String, String, usize)> {
    let mut seed: u64 = 12345;
    let mut letter = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        char::from(b'a' + (seed % 26) as u8)
    };
    let words: Vec<String> = (0..200).map(|_| (0..8).map(|_| letter()).collect()).collect();
    let letters: String = (0..4096).map(|_| letter()).collect();
    let email = "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}";
    let alternatives: Vec<String> = (0..30000).map(|i| format!("[a-{}]x", char::from(b'b' + (i % 20) as u8))).collect();
    vec![
        ("(a*)*b".to_owned(), "a".to_owned(), 64 * 1024),
        ("(a|aa)*c".to_owned(), "a".to_owned(), 64 * 1024),
        ("(x+x+)+y".to_owned(), "x".to_owned(), 64 * 1024),
        ("\\pL{1000}".to_owned(), format!("{}1", "a".repeat(999)), 64 * 1024),
        (email.to_owned(), "ab@cd".to_owned(), 64 * 1024),
        (email.to_owned(), "abcde".to_owned(), 64 * 1024),
        (format!("(?:{})", words.join("|")), letters, 8 * 1024),
        (alternatives.join("|"), "z".to_owned(), 64 * 1024),
    ]
}

#[test]
fn visits_at_most_each_instruction_once_per_position() {
    for (pattern, unit, longest) in cases() {
        let program = re2_pattern(&pattern, Re2Flags::NONE).expect("accepted");
        let size = program.instruction_count() as u64 + 1;
        let bound = |n: u64| size * (n + 1);
        let mut previous: [Option<u64>; 2] = [None; 2];
        let mut length: usize = 1;
        while length <= longest {
            let repeats = length.div_ceil(unit.len());
            let text = &unit.repeat(repeats)[..length];
            let points = length as u64;
            for (slot, groups, times) in [(0, 1, 1), (1, 0, 3)] {
                let search = program.search(text, 0, groups);
                assert_eq!(search.groups, None, "{pattern:.40} over {length} bytes");
                assert!(
                    search.visits <= times * bound(points),
                    "{pattern:.40} over {length} bytes, {groups} groups: {} visits",
                    search.visits
                );
                // Doubling the text at most doubles the count, less what one ramp of threads
                // up to the program's length can cost: (|program| + 1)² visits per engine.
                if let Some(previous) = previous[slot] {
                    let ramp = times * size.pow(2);
                    assert!(
                        search.visits <= 2 * previous + ramp,
                        "{pattern:.40}, {groups} groups: {previous} visits at {} bytes, {} at {length}",
                        length / 2,
                        search.visits
                    );
                }
                previous[slot] = Some(search.visits);
            }
            length *= 2;
        }
    }
}
