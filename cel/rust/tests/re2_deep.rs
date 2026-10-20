//! A pattern as tall as RE2 accepts is read, compiled and searched on a stack of 256 KiB,
//! in a debug build: nothing recurses with a pattern's height.
//!
//! The pattern and its answers are Node's, executed (`@telorun/cel 0.120.1 at b4a2b6e9`):
//! 999 nested groups around `a` are accepted with 999 groups and match `xa`. That a stack
//! of this size suffices is this crate's own.

use telorun_cel::{cel_matches, re2_pattern, CelValue, Re2Flags};

/// The one stack size any test of this crate names.
const STACK_BYTES: usize = 256 * 1024;

#[test]
fn reads_compiles_and_searches_a_height_1000_pattern_on_a_small_stack() {
    let work = || {
        let pattern = format!("{}a{}", "(".repeat(999), ")".repeat(999));
        let program = re2_pattern(&pattern, Re2Flags::NONE).expect("a height of 1000 is accepted");
        assert_eq!(program.group_count(), 999);
        let search = program.search("xa", 0, 1000);
        let groups = search.groups.expect("it matches");
        assert!(groups.iter().all(|span| span.is_some_and(|span| (span.start, span.end) == (1, 2))));
        assert_eq!(cel_matches("xa", &pattern, None), CelValue::Bool(true));
        let folded = format!("(?i){}A{}", "(?:".repeat(999), ")*".repeat(999));
        assert!(re2_pattern(&folded, Re2Flags::NONE).expect("accepted").is_match("xa"));
    };
    let thread = std::thread::Builder::new().stack_size(STACK_BYTES).spawn(work).expect("the thread starts");
    thread.join().expect("the work ran to its end");
}
