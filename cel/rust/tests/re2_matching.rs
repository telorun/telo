//! What a compiled pattern matches, and where: the whole match and every group, as byte
//! offsets, for leftmost-first and non-greedy order, captures, case folding over the fold
//! orbit and its casing fallback, the Unicode, Perl and POSIX classes, the anchors with and
//! without `(?m)`, `\b` and `\B`, `.` with and without `(?s)`, and a search begun inside the
//! text, whose context is the text before it.
//!
//! No Node test file asserts a match's place. Every row is Node's answer, executed
//! (`@telorun/cel 0.120.1 at b4a2b6e9`: `re2Pattern(pattern, flags)`, then the matcher's
//! `find(start)` and each group's `start` and `end`, over re2js 2.8.3), its UTF-16 offsets
//! written as the byte offsets of the same positions.

use telorun_cel::{re2_pattern, Re2Flags, Re2Span};

type Spans = Option<&'static [Option<(usize, usize)>]>;

/// `(pattern, re2js flags, text, start byte, Node's spans)`.
const ROWS: [(&str, u32, &str, usize, Spans); 61] = [
    ("a|ab", 0, "ab", 0, Some(&[Some((0, 1))])),
    ("ab|a", 0, "ab", 0, Some(&[Some((0, 2))])),
    ("a+", 0, "baaa", 0, Some(&[Some((1, 4))])),
    ("a+?", 0, "baaa", 0, Some(&[Some((1, 2))])),
    ("(?U)a+", 0, "baaa", 0, Some(&[Some((1, 2))])),
    ("(?U)a+?", 0, "baaa", 0, Some(&[Some((1, 4))])),
    ("(a(b)?)+", 0, "aba", 0, Some(&[Some((0, 3)), Some((2, 3)), Some((1, 2))])),
    ("(a)|(b)", 0, "b", 0, Some(&[Some((0, 1)), None, Some((0, 1))])),
    ("(?P<first>\\w+) (?<last>\\w+)", 0, "John Smith", 0, Some(&[Some((0, 10)), Some((0, 4)), Some((5, 10))])),
    ("a*", 0, "baa", 0, Some(&[Some((0, 0))])),
    ("x*", 0, "", 0, Some(&[Some((0, 0))])),
    ("(a*)*b", 0, "aaab", 0, Some(&[Some((0, 4)), Some((0, 3))])),
    ("(a|aa)*c", 0, "aaac", 0, Some(&[Some((0, 4)), Some((2, 3))])),
    ("(?i)k", 0, "\u{212a}", 0, Some(&[Some((0, 3))])),
    ("k", 1, "K", 0, Some(&[Some((0, 1))])),
    ("(?i)σ", 0, "ς", 0, Some(&[Some((0, 2))])),
    ("(?i)Σ", 0, "xσ", 0, Some(&[Some((1, 3))])),
    ("(?i)ǅ", 0, "ǆǄ", 0, Some(&[Some((0, 2))])),
    ("(?i)ß", 0, "SS", 0, None),
    ("(?i)ß", 0, "\u{1e9e}", 0, Some(&[Some((0, 3))])),
    ("(?i)\\x{130}", 0, "iIİ", 0, Some(&[Some((2, 4))])),
    ("(?i)ı", 0, "Iiı", 0, Some(&[Some((2, 4))])),
    ("(?i)[k]", 0, "\u{212a}", 0, Some(&[Some((0, 3))])),
    ("(?i)[a-c]+", 0, "xBcA", 0, Some(&[Some((1, 4))])),
    ("(?i)\\p{Lu}+", 0, "abc", 0, Some(&[Some((0, 3))])),
    ("\\pL+", 0, "1aé😀b", 0, Some(&[Some((1, 4))])),
    ("\\p{Greek}+", 0, "aαβγ", 0, Some(&[Some((1, 7))])),
    ("\\P{L}+", 0, "ab12é", 0, Some(&[Some((2, 4))])),
    ("\\p{^L}", 0, "a1", 0, Some(&[Some((1, 2))])),
    ("\\p{Han}", 0, "a中", 0, Some(&[Some((1, 4))])),
    ("\\p{Emoji}", 0, "x😀", 0, Some(&[Some((1, 5))])),
    ("[[:alpha:]]+", 0, "1abé", 0, Some(&[Some((1, 3))])),
    ("[^[:digit:]]+", 0, "12x3", 0, Some(&[Some((2, 3))])),
    ("\\d+", 0, "\u{663} 42", 0, Some(&[Some((3, 5))])),
    ("\\w+", 0, "é_x1", 0, Some(&[Some((2, 5))])),
    ("\\s+", 0, "a\u{000b} \t\nb", 0, Some(&[Some((2, 5))])),
    ("[^a]", 0, "a😀", 0, Some(&[Some((1, 5))])),
    ("\\bfoo\\b", 0, "éfoo foo", 0, Some(&[Some((2, 5))])),
    ("\\B", 0, "aéa", 0, None),
    ("\\b", 0, "é", 0, None),
    ("^b", 0, "a\nb", 0, None),
    ("(?m)^b", 0, "a\nb", 0, Some(&[Some((2, 3))])),
    ("a$", 0, "a\nb", 0, None),
    ("(?m)a$", 0, "a\nb", 0, Some(&[Some((0, 1))])),
    ("a$", 4, "ba\nc", 0, Some(&[Some((1, 2))])),
    ("\\Aa", 0, "ba", 0, None),
    ("a\\z", 0, "a\n", 0, None),
    (".", 0, "\nx", 0, Some(&[Some((1, 2))])),
    ("(?s).", 0, "\nx", 0, Some(&[Some((0, 1))])),
    (".", 2, "\nx", 0, Some(&[Some((0, 1))])),
    ("\\Q.*\\E", 0, "a.*b", 0, Some(&[Some((1, 3))])),
    ("\\x{1F600}", 0, "a😀", 0, Some(&[Some((1, 5))])),
    ("\\101\\x42", 0, "xAB", 0, Some(&[Some((1, 3))])),
    ("\\bb", 0, "ab b", 1, Some(&[Some((3, 4))])),
    ("^b", 4, "ab\nb", 1, Some(&[Some((3, 4))])),
    ("(?m)^b", 0, "ab\nb", 2, Some(&[Some((3, 4))])),
    ("b", 0, "ab", 2, None),
    ("", 0, "é", 2, Some(&[Some((2, 2))])),
    ("(a+?)(b*)", 0, "aabb", 0, Some(&[Some((0, 1)), Some((0, 1)), Some((1, 1))])),
    ("(?:a|(b))+", 0, "ab", 0, Some(&[Some((0, 2)), Some((1, 2))])),
    ("(a)?b", 0, "b", 0, Some(&[Some((0, 1)), None])),
];

fn flags(bits: u32) -> Re2Flags {
    let mut flags = Re2Flags::NONE;
    for (bit, flag) in [(1, Re2Flags::CASE_INSENSITIVE), (2, Re2Flags::DOTALL), (4, Re2Flags::MULTILINE)] {
        if bits & bit != 0 {
            flags = flags | flag;
        }
    }
    flags
}

#[test]
fn matches_each_text_where_node_matches_it() {
    for (pattern, bits, text, start, expected) in ROWS {
        let program = re2_pattern(pattern, flags(bits)).unwrap_or_else(|refused| panic!("{pattern}: {refused}"));
        let found = program.search(text, start, program.group_count() + 1).groups;
        let expected: Option<Vec<Option<Re2Span>>> = expected.map(|spans| {
            spans.iter().map(|span| span.map(|(start, end)| Re2Span { start, end })).collect()
        });
        assert_eq!(found, expected, "{pattern:?} with flags {bits} over {text:?} from {start}");
        if start == 0 {
            assert_eq!(program.is_match(text), expected.is_some(), "{pattern:?} over {text:?}");
        }
    }
}

#[test]
fn names_its_groups() {
    let program = re2_pattern("(?P<first>\\w+) (x)(?<last>\\w+)", Re2Flags::NONE).expect("accepted");
    assert_eq!(program.group_count(), 3);
    assert_eq!(program.named_group("first"), Some(1));
    assert_eq!(program.named_group("last"), Some(3));
    assert_eq!(program.named_group("x"), None);
}

#[test]
fn answers_only_whether_it_matched_when_no_group_is_asked_for() {
    let program = re2_pattern("b(c)", Re2Flags::NONE).expect("accepted");
    assert_eq!(program.search("abc", 0, 0).groups, Some(Vec::new()));
    assert_eq!(program.search("abd", 0, 0).groups, None);
}

#[test]
fn is_shared_by_every_thread() {
    fn shared<T: Send + Sync>() {}
    shared::<telorun_cel::Re2Program>();
    let program = re2_pattern("(a+)(b)", Re2Flags::NONE).expect("accepted");
    let searches: Vec<_> = (0..8)
        .map(|_| {
            let program = program.clone();
            std::thread::spawn(move || program.search("xaab", 0, 3).groups)
        })
        .collect();
    for search in searches {
        let groups = search.join().expect("the search ran to its end");
        assert_eq!(
            groups,
            Some(vec![
                Some(Re2Span { start: 1, end: 4 }),
                Some(Re2Span { start: 1, end: 3 }),
                Some(Re2Span { start: 3, end: 4 })
            ])
        );
    }
}
