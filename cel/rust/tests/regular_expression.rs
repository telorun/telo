//! `re2_pattern` and `cel_matches`: what is accepted, what is refused and how the refusal
//! is worded, the two limits on both sides, the flags, the shared cache.
//!
//! The `cel_matches` rows below pin Node's whole message for a refused `matches`; the
//! `evaluate.test.ts` case about RE2 is twinned by `evaluate.rs` alone.
//! Every expected text is Node's, executed (`@telorun/cel 0.120.1 at b4a2b6e9`, its
//! `re2Pattern` and `celMatches` over re2js 2.8.3), except the two rows of *Where it
//! differs from Node*, each of which names Node's answer.

use telorun_cel::{
    cel_matches, re2_pattern, CelError, CelEvaluationCode, CelValue, Re2Flags, Re2PatternErrorKind, SourceRange,
    PATTERN_CACHE_CAPACITY, RE2_FLAG_LETTERS, RE2_PATTERN_ERROR_KINDS,
};

use Re2PatternErrorKind::*;

const RANGE: SourceRange = SourceRange { start: 4, end: 9 };

fn refusal(pattern: &str) -> (Re2PatternErrorKind, String) {
    let refused = re2_pattern(pattern, Re2Flags::NONE).expect_err(pattern);
    (refused.kind, refused.message)
}

fn refused_match(message: &str) -> CelValue {
    CelValue::Error(CelError {
        code: CelEvaluationCode::InvalidRegularExpression,
        message: message.to_owned(),
        range: Some(RANGE),
    })
}

#[test]
fn cel_matches_answers_and_refuses_with_nodes_whole_message() {
    assert_eq!(cel_matches("abc", "b", Some(RANGE)), CelValue::Bool(true));
    assert_eq!(cel_matches("abc", "^a.c$", Some(RANGE)), CelValue::Bool(true));
    assert_eq!(
        cel_matches("aa", "(a)\\1", Some(RANGE)),
        refused_match("\"(a)\\\\1\" is not an RE2 pattern: error parsing regexp: invalid escape sequence: `\\1`")
    );
    assert_eq!(
        cel_matches("abc", "(", Some(RANGE)),
        refused_match("\"(\" is not an RE2 pattern: error parsing regexp: missing closing ): `(`")
    );
    assert_eq!(
        cel_matches("abc", "a\"(", Some(RANGE)),
        refused_match("\"a\\\"(\" is not an RE2 pattern: error parsing regexp: missing closing ): `a\"(`")
    );
}

#[test]
fn refuses_with_each_kind_its_message_and_fragment() {
    let rows: [(&str, Re2PatternErrorKind, &str); 19] = [
        ("(", MissingClosingParen, "error parsing regexp: missing closing ): `(`"),
        ("[a", MissingClosingBracket, "error parsing regexp: missing closing ]: `[a`"),
        ("a)", UnexpectedParen, "error parsing regexp: unexpected ): `a)`"),
        ("\\", TrailingBackslash, "error parsing regexp: trailing backslash at end of expression"),
        ("\\q", InvalidEscapeSequence, "error parsing regexp: invalid escape sequence: `\\q`"),
        ("\\C", InvalidEscapeSequence, "error parsing regexp: invalid escape sequence: `\\C`"),
        ("[z-a]", InvalidCharacterClassRange, "error parsing regexp: invalid character class range: `z-a`"),
        ("\\p{Foo}", InvalidCharacterClassRange, "error parsing regexp: invalid character class range: `\\p{Foo}`"),
        ("[[:foo:]]", InvalidCharacterClassRange, "error parsing regexp: invalid character class range: `[:foo:]`"),
        ("(?P<n", InvalidNamedCapture, "error parsing regexp: invalid named capture: `(?P<n`"),
        ("(?<=a)b", InvalidNamedCapture, "error parsing regexp: invalid named capture: `(?<=a)b`"),
        ("(?P<n>a)(?P<n>b)", DuplicateCaptureGroupName, "error parsing regexp: duplicate capture group name: `n`"),
        ("(?=b)", InvalidOrUnsupportedPerlSyntax, "error parsing regexp: invalid or unsupported Perl syntax: `(?=`"),
        ("*", MissingArgumentToRepetitionOperator, "error parsing regexp: missing argument to repetition operator: `*`"),
        ("a**", InvalidNestedRepetitionOperator, "error parsing regexp: invalid nested repetition operator: `**`"),
        ("x{2}{3}", InvalidNestedRepetitionOperator, "error parsing regexp: invalid nested repetition operator: `{2}{3}`"),
        ("a{2,1}", InvalidRepeatCount, "error parsing regexp: invalid repeat count: `{2,1}`"),
        ("a{1001}", InvalidRepeatCount, "error parsing regexp: invalid repeat count: `{1001}`"),
        ("((a)", MissingClosingParen, "error parsing regexp: missing closing ): `((a)`"),
    ];
    for (pattern, kind, message) in rows {
        assert_eq!(refusal(pattern), (kind, message.to_owned()), "{pattern}");
    }
}

#[test]
fn reads_a_brace_that_opens_no_count_as_itself() {
    let program = re2_pattern("\\pN}{", Re2Flags::NONE).expect("Node accepts it");
    assert!(program.is_match("1}{"));
}

#[test]
fn quotes_the_flags_written_before_a_pattern_quoted_whole() {
    let message = |pattern, flags| re2_pattern(pattern, flags).expect_err(pattern).message;
    assert_eq!(message("(", Re2Flags::CASE_INSENSITIVE), "error parsing regexp: missing closing ): `(?i)(`");
    assert_eq!(
        message("(", Re2Flags::CASE_INSENSITIVE | Re2Flags::DOTALL | Re2Flags::MULTILINE),
        "error parsing regexp: missing closing ): `(?m)(?s)(?i)(`"
    );
    assert_eq!(message("a)", Re2Flags::MULTILINE), "error parsing regexp: unexpected ): `(?m)a)`");
}

/// `(` × `depth`, `a`, `)` × `depth`: a tree `depth` + 1 high.
fn nested(depth: usize) -> String {
    format!("{}a{}", "(".repeat(depth), ")".repeat(depth))
}

#[test]
fn holds_the_height_limit_at_1000() {
    let program = re2_pattern(&nested(999), Re2Flags::NONE).expect("a height of 1000 is accepted");
    assert_eq!(program.group_count(), 999);
    assert_eq!(cel_matches("xa", &nested(999), Some(RANGE)), CelValue::Bool(true));
    let past = nested(1000);
    assert_eq!(refusal(&past), (ExpressionNestsTooDeeply, "error parsing regexp: expression nests too deeply".to_owned()));
    assert_eq!(
        cel_matches("xa", &past, Some(RANGE)),
        refused_match(&format!("\"{past}\" is not an RE2 pattern: error parsing regexp: expression nests too deeply"))
    );
}

#[test]
fn holds_the_size_limit_at_3355443() {
    let at = "a{1000}".repeat(3355);
    let program = re2_pattern(&at, Re2Flags::NONE).expect("a size of 3,355,000 is accepted");
    assert_eq!(program.instruction_count(), 3_355_002);
    assert_eq!(cel_matches("b", &at, Some(RANGE)), CelValue::Bool(false));
    let past = "a{1000}".repeat(3356);
    assert_eq!(refusal(&past), (ExpressionTooLarge, "error parsing regexp: expression too large".to_owned()));
    assert_eq!(
        cel_matches("b", &past, Some(RANGE)),
        refused_match(&format!("\"{past}\" is not an RE2 pattern: error parsing regexp: expression too large"))
    );
}

/// `\pL` holds 1,368 class bounds, and re2js counts every bound of every class it reads.
#[test]
fn holds_the_class_bound_limit_at_33554432() {
    let at = "\\pL".repeat(24_528);
    assert!(re2_pattern(&at, Re2Flags::NONE).is_ok(), "24,528 × 1,368 = 33,554,304 bounds are accepted");
    assert_eq!(cel_matches("1", &at, Some(RANGE)), CelValue::Bool(false));
    let past = "\\pL".repeat(24_529);
    assert_eq!(refusal(&past), (ExpressionTooLarge, "error parsing regexp: expression too large".to_owned()));
    assert_eq!(
        cel_matches("1", &past, Some(RANGE)),
        refused_match(&format!(
            "\"{}\" is not an RE2 pattern: error parsing regexp: expression too large",
            "\\\\pL".repeat(24_529)
        ))
    );
}

#[test]
fn names_the_kinds_and_flag_letters_as_node_does() {
    let words: Vec<&str> = RE2_PATTERN_ERROR_KINDS.iter().map(|kind| kind.as_str()).collect();
    assert_eq!(
        words,
        [
            "missing closing )",
            "missing closing ]",
            "unexpected )",
            "trailing backslash at end of expression",
            "invalid escape sequence",
            "invalid character class range",
            "invalid named capture",
            "duplicate capture group name",
            "invalid or unsupported Perl syntax",
            "missing argument to repetition operator",
            "invalid nested repetition operator",
            "invalid repeat count",
            "expression nests too deeply",
            "expression too large",
        ]
    );
    let letters: Vec<(char, u32)> = RE2_FLAG_LETTERS.iter().map(|&(letter, flags)| (letter, flags.bits())).collect();
    assert_eq!(letters, [('i', 1), ('m', 4), ('s', 2)]);
    assert_eq!(PATTERN_CACHE_CAPACITY, 128);
}

#[test]
fn serves_one_compiled_program_to_every_caller() {
    let first = re2_pattern("shared(x)+", Re2Flags::NONE).expect("accepted");
    let second = re2_pattern("shared(x)+", Re2Flags::NONE).expect("accepted");
    assert!(std::sync::Arc::ptr_eq(&first, &second));
    let folded = re2_pattern("shared(x)+", Re2Flags::CASE_INSENSITIVE).expect("accepted");
    assert!(!std::sync::Arc::ptr_eq(&first, &folded), "the flags are part of the key");
}

// ---------------------------------------------------------------- where it differs from Node

/// Node: re2js resolves a `\p` name with JavaScript's `in`, so `\p{constructor}` and
/// `\p{isPrototypeOf}` reach `Object.prototype`, are accepted as a class holding nothing,
/// and `'abc'.matches('\\p{constructor}')` is `false`. Here they are unknown names.
#[test]
fn reads_a_prototype_name_as_an_unknown_class_name() {
    for name in ["constructor", "isPrototypeOf"] {
        let pattern = format!("\\p{{{name}}}");
        assert_eq!(
            refusal(&pattern),
            (InvalidCharacterClassRange, format!("error parsing regexp: invalid character class range: `{pattern}`"))
        );
    }
}

/// Node: re2js throws a `TypeError` for `\p{__proto__}` (`fn is not a function`),
/// `\p{toString}` (`table.getLo is not a function`) and `\p{hasOwnProperty}` (`Cannot
/// convert undefined or null to object`), and Node folds each into a refusal with no kind:
/// `"\\p{__proto__}" is not an RE2 pattern: fn is not a function`. Here no refusal lacks a
/// kind: each is an unknown name.
#[test]
fn refuses_nothing_without_a_kind() {
    for name in ["__proto__", "toString", "hasOwnProperty"] {
        let pattern = format!("\\p{{{name}}}");
        assert_eq!(
            cel_matches("abc", &pattern, Some(RANGE)),
            refused_match(&format!(
                "\"\\\\p{{{name}}}\" is not an RE2 pattern: error parsing regexp: invalid character class range: `{pattern}`"
            ))
        );
    }
}
