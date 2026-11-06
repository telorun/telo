//! The longest text a string can hold: every text the engine builds that can come out longer
//! than its longest input is held to 536,870,888 UTF-16 code units, V8's longest string. At
//! the bound it is answered; past it the call is the error value `<function>: the text built
//! would exceed the longest text a string can hold (536870888 UTF-16 code units)`,
//! `invalid_argument`, found before any storage for the text is allocated.
//!
//! Every Node answer here was executed — `@telorun/cel 0.129.0 at 2ee5ef49` under Node
//! v24.21.0 (V8 13.6.233.17-node.53, ICU 78.3, tz 2026c), d3-format 3.1.2, `uuid` 14.0.1,
//! re2js 2.8.3, `--max-old-space-size=24000` — over the same source and activation, at the
//! bound and one unit past it (base64 is a multiple of four and hexadecimal of two, so their
//! one past is the next length they can have). Each row holds Node's two answers beside this
//! crate's one past the bound: where Node answers at the bound and throws its host's
//! `RangeError` past it, the refusal is an interim reading; every other outcome is a pinned
//! difference, named as one.

mod evaluation_support;

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::collections::HashMap;
use std::sync::Mutex;

use evaluation_support::{answer, handlers};
use telorun_cel::{
    catalog_implementation, register_function_catalog, CelCallContext, CelCatalogHandlers, CelEnvironment,
    CelEnvironmentOptions, CelValue, EvaluateOptions, RegisterCatalogOptions, SourceRange,
};

// --- the largest block an evaluation allocates ---------------------------------------------

struct Counting;

thread_local! {
    static LARGEST: Cell<usize> = const { Cell::new(0) };
}

fn noted(size: usize) {
    // `try_with`: an allocation made while the thread's storage is torn down is not noted.
    let _ = LARGEST.try_with(|largest| largest.set(largest.get().max(size)));
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        noted(layout.size());
        System.alloc(layout)
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        System.dealloc(pointer, layout)
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        noted(size);
        System.realloc(pointer, layout, size)
    }
}

#[global_allocator]
static COUNTING: Counting = Counting;

/// What `run` answered, and the largest block it allocated.
fn with_largest_block<T>(run: impl FnOnce() -> T) -> (T, usize) {
    LARGEST.with(|largest| largest.set(0));
    let answered = run();
    (answered, LARGEST.with(Cell::get))
}

/// A refusal allocates no block of the size of the text it refuses: the largest it makes —
/// the lists the expression itself builds, a list's parts — is below this, a thirty-second
/// of the text.
const REFUSAL_BLOCK_LIMIT: usize = 16 << 20;

/// The inputs here are up to half a gigabyte, so one row runs at a time.
static HEAVY: Mutex<()> = Mutex::new(());

// --- the rows ------------------------------------------------------------------------------

const LONGEST: usize = 536_870_888;
/// `range(K).map(i, s)` holds `s` K times: K × K is 536,848,900.
const K: usize = 23_170;

fn environment() -> CelEnvironment {
    let mut environment = CelEnvironment::new(CelEnvironmentOptions {
        unlisted_variables_are_dyn: true,
        enable_optional_types: true,
        ..Default::default()
    });
    register_function_catalog(&mut environment, RegisterCatalogOptions { handlers: handlers() });
    environment
}

fn text(repeated: &str, count: usize) -> CelValue {
    CelValue::String(repeated.repeat(count).into())
}

fn bytes(length: usize) -> CelValue {
    CelValue::Bytes(vec![b'a'; length].into())
}

/// The bound refusal, as this crate words it, ranged over `[start, end)`.
fn refused_at(function: &str, start: usize, end: usize) -> String {
    format!(
        "error invalid_argument [{start}, {end}] {function}: the text built would exceed the longest text a string can hold (536870888 UTF-16 code units)"
    )
}

/// The bound refusal of a call that is the whole source.
fn refused(function: &str, source: &str) -> String {
    refused_at(function, 0, source.encode_utf16().count())
}

type Activation = HashMap<String, CelValue>;

/// One builder one unit past the bound: its source, its activation, the function its
/// refusal names, and Node's answers at the bound and one past it.
struct Row {
    source: &'static str,
    activation: fn() -> Activation,
    function: &'static str,
    node_at_the_bound: &'static str,
    node_one_past: &'static str,
}

/// The largest block a row's refusal may allocate: [`REFUSAL_BLOCK_LIMIT`], except where
/// the engine copies an argument — the pattern cache keeps a pattern it was handed, refused
/// or not — which is the argument's size and not the text's.
fn block_limit(row: &Row, activation: &Activation) -> usize {
    match row.source {
        "regexExtract('a', s)" => match &activation["s"] {
            CelValue::String(pattern) => pattern.len() + REFUSAL_BLOCK_LIMIT,
            _ => REFUSAL_BLOCK_LIMIT,
        },
        _ => REFUSAL_BLOCK_LIMIT,
    }
}

fn activation(entries: Vec<(&str, CelValue)>) -> Activation {
    entries.into_iter().map(|(name, value)| (name.to_string(), value)).collect()
}

/// Each row's refusal one past the bound, worded and coded exactly, and allocating no
/// block of the size of the text it refuses. `interim` rows are those Node answers at the
/// bound and throws its host's `RangeError` past; every other row differs from that.
fn refuses_one_past(interim: bool, rows: &[Row]) {
    let _heavy = HEAVY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let environment = environment();
    for row in rows {
        let activation = (row.activation)();
        let (answered, largest) = with_largest_block(|| {
            answer(environment.evaluate(row.source, &activation, &EvaluateOptions::default()))
        });
        // A call on a parenthesized receiver is ranged from the receiver, inside its parentheses.
        let start = usize::from(row.source.starts_with('('));
        assert_eq!(answered, refused_at(row.function, start, row.source.encode_utf16().count()), "{}", row.source);
        assert_ne!(answered, row.node_one_past, "{}", row.source);
        assert!(largest < block_limit(row, &activation), "{} allocated a block of {largest} bytes", row.source);
        let as_interim = row.node_at_the_bound != NODE_RANGE_ERROR && row.node_one_past == NODE_RANGE_ERROR;
        assert_eq!(as_interim, interim, "{}: Node's answers are not of this group", row.source);
    }
}

const NODE_ANSWERS: &str = "value string of 536870888 units";
const NODE_RANGE_ERROR: &str = "threw RangeError: Invalid string length";

#[test]
fn answers_a_text_of_the_longest_length_and_refuses_one_unit_more() {
    let _heavy = HEAVY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let environment = environment();
    let source = "join(range(23170).map(i, s) + [t], '')";
    let at = |length: usize| activation(vec![("s", text("a", K)), ("t", text("a", length - K * K))]);
    match environment.evaluate(source, &at(LONGEST), &EvaluateOptions::default()) {
        Ok(CelValue::String(built)) => assert_eq!(built.len(), LONGEST),
        other => panic!("the longest text was not answered: {:?}", other.map(|_| ())),
    }
    assert_eq!(answer(environment.evaluate(source, &at(LONGEST + 1), &EvaluateOptions::default())), refused("join", source));
}

/// Interim: Node answers each at the bound and throws its host's `RangeError` one past it,
/// out of evaluation; this crate answers the error value.
#[test]
fn interim_a_text_built_past_the_longest_string_is_refused_where_node_throws() {
    refuses_one_past(true, &[
        Row {
            source: "join(range(23170).map(i, s) + [t], '')",
            activation: || activation(vec![("s", text("a", K)), ("t", text("a", LONGEST + 1 - K * K))]),
            function: "join",
            node_at_the_bound: NODE_ANSWERS,
            node_one_past: NODE_RANGE_ERROR,
        },
        Row {
            source: "join([range(23170).map(i, s) + [t]], '')",
            activation: || activation(vec![("s", text("a", K - 1)), ("t", text("a", LONGEST + 1 - K * K))]),
            function: "join",
            node_at_the_bound: NODE_ANSWERS,
            node_one_past: NODE_RANGE_ERROR,
        },
        Row {
            source: "sort(['x', range(23170).map(i, s) + [t]])",
            activation: || activation(vec![("s", text("a", K - 1)), ("t", text("a", LONGEST + 1 - K * K))]),
            function: "sort",
            node_at_the_bound: "value list of 2",
            node_one_past: NODE_RANGE_ERROR,
        },
        Row {
            source: "replace(s, 'a', w)",
            activation: || {
                activation(vec![("s", text(&("a".repeat(K) + &"c".repeat(LONGEST + 1 - K * K)), 1)), ("w", text("b", K))])
            },
            function: "replace",
            node_at_the_bound: NODE_ANSWERS,
            node_one_past: NODE_RANGE_ERROR,
        },
        // An empty search: 20,789 + 20,788 × 25,825 is one past; at the bound 8 + 7 × 76,695,840.
        Row {
            source: "replace(s, '', w)",
            activation: || activation(vec![("s", text("a", 20_789)), ("w", text("b", 25_825))]),
            function: "replace",
            node_at_the_bound: NODE_ANSWERS,
            node_one_past: NODE_RANGE_ERROR,
        },
        Row {
            source: "regexReplace(s, 'a', w)",
            activation: || {
                activation(vec![("s", text(&("a".repeat(K) + &"c".repeat(LONGEST + 1 - K * K)), 1)), ("w", text("b", K))])
            },
            function: "regexReplace",
            node_at_the_bound: NODE_ANSWERS,
            node_one_past: NODE_RANGE_ERROR,
        },
        Row {
            source: "regexReplace(s, 'A', w, 'i')",
            activation: || {
                activation(vec![("s", text(&("a".repeat(K) + &"c".repeat(LONGEST + 1 - K * K)), 1)), ("w", text("b", K))])
            },
            function: "regexReplace",
            node_at_the_bound: NODE_ANSWERS,
            node_one_past: NODE_RANGE_ERROR,
        },
        // `é` is six characters encoded.
        Row {
            source: "urlEncode(s)",
            activation: || activation(vec![("s", text(&("é".repeat(89_478_481) + "aaa"), 1))]),
            function: "urlEncode",
            node_at_the_bound: NODE_ANSWERS,
            node_one_past: NODE_RANGE_ERROR,
        },
        // `ΐ` upper-cases to three code points.
        Row {
            source: "upper(s)",
            activation: || activation(vec![("s", text(&("ΐ".repeat(178_956_962) + "aaa"), 1))]),
            function: "upper",
            node_at_the_bound: NODE_ANSWERS,
            node_one_past: NODE_RANGE_ERROR,
        },
        Row {
            source: "s.upperAscii()",
            activation: || activation(vec![("s", text(&("ΐ".repeat(178_956_962) + "aaa"), 1))]),
            function: "upperAscii",
            node_at_the_bound: NODE_ANSWERS,
            node_one_past: NODE_RANGE_ERROR,
        },
        Row {
            source: "s + t",
            activation: || activation(vec![("s", text("a", 268_435_444)), ("t", text("a", LONGEST + 1 - 268_435_444))]),
            function: "+",
            node_at_the_bound: NODE_ANSWERS,
            node_one_past: NODE_RANGE_ERROR,
        },
        Row {
            source: "(range(23170).map(i, s) + [t]).join()",
            activation: || activation(vec![("s", text("a", K)), ("t", text("a", LONGEST + 1 - K * K))]),
            function: "join",
            node_at_the_bound: NODE_ANSWERS,
            node_one_past: NODE_RANGE_ERROR,
        },
        Row {
            source: "(range(23170).map(i, s) + [t]).join(',')",
            activation: || activation(vec![("s", text("a", K - 1)), ("t", text("a", LONGEST + 1 - K * K))]),
            function: "join",
            node_at_the_bound: NODE_ANSWERS,
            node_one_past: NODE_RANGE_ERROR,
        },
        // Two characters a byte: one past the bound is 536,870,890.
        Row {
            source: "b.hex()",
            activation: || activation(vec![("b", bytes(268_435_445))]),
            function: "hex",
            node_at_the_bound: NODE_ANSWERS,
            node_one_past: NODE_RANGE_ERROR,
        },
        // A refusal quoting a value as a JSON string: `"` is written as two characters.
        Row {
            source: "format(1, s)",
            activation: || activation(vec![("s", text(&("\"".repeat(268_435_000) + &"!".repeat(854)), 1))]),
            function: "format",
            node_at_the_bound: "error invalid_argument [0, 12] message of 536870888 units: format: invalid format specifier \"\\\"\\\"…",
            node_one_past: NODE_RANGE_ERROR,
        },
        Row {
            source: "dateIn(timestamp('2024-01-01T00:00:00Z'), s)",
            activation: || activation(vec![("s", text(&("\"".repeat(268_435_000) + &"!".repeat(856)), 1))]),
            function: "dateIn",
            node_at_the_bound: "error invalid_argument [0, 44] message of 536870888 units: dateIn: unknown IANA time zone \"\\\"\\\"…",
            node_one_past: NODE_RANGE_ERROR,
        },
        Row {
            source: "regexExtract('a', s)",
            activation: || activation(vec![("s", text(&("*".to_string() + &"\"".repeat(268_435_000) + &"!".repeat(811)), 1))]),
            function: "regexExtract",
            node_at_the_bound: "error invalid_regular_expression [0, 20] message of 536870888 units: regexExtract: invalid RE2 pattern \"*\\\"…",
            node_one_past: NODE_RANGE_ERROR,
        },
    ]);
}

/// Pinned difference: Node's host crashes (`SIGSEGV`, exit 139) lower-casing `İ` one past the
/// bound — `toLowerCase` itself, outside the engine — and answers at the bound.
#[test]
fn difference_lower_casing_past_the_longest_string_is_refused_where_node_crashes() {
    refuses_one_past(false, &[
        Row {
            source: "lower(s)",
            activation: || activation(vec![("s", text(&("İ".repeat(268_435_443) + "aaa"), 1))]),
            function: "lower",
            node_at_the_bound: NODE_ANSWERS,
            node_one_past: "crashed: SIGSEGV",
        },
        Row {
            source: "s.lowerAscii()",
            activation: || activation(vec![("s", text(&("İ".repeat(268_435_443) + "aaa"), 1))]),
            function: "lowerAscii",
            node_at_the_bound: NODE_ANSWERS,
            node_one_past: "crashed: SIGSEGV",
        },
    ]);
}

/// Pinned difference: Node builds base64 a character at a time and exhausts its heap
/// (`FATAL ERROR: … JavaScript heap out of memory`, exit 134) at the bound and past it.
#[test]
fn difference_base64_past_the_longest_string_is_refused_where_node_exhausts_its_heap() {
    refuses_one_past(false, &[
        Row {
            source: "bytesToBase64(b)",
            activation: || activation(vec![("b", bytes(402_653_167))]),
            function: "bytesToBase64",
            node_at_the_bound: "aborted: JavaScript heap out of memory",
            node_one_past: "aborted: JavaScript heap out of memory",
        },
        Row {
            source: "b.base64()",
            activation: || activation(vec![("b", bytes(402_653_167))]),
            function: "base64",
            node_at_the_bound: "aborted: JavaScript heap out of memory",
            node_one_past: "aborted: JavaScript heap out of memory",
        },
    ]);
}

/// Pinned difference: Node decodes bytes with a decoder whose failure to build the text is
/// caught as though the bytes were not UTF-8, so one past the bound it answers `the bytes
/// are not UTF-8 text`, `invalid_conversion`, about bytes that are.
#[test]
fn difference_bytes_decoded_past_the_longest_string_are_refused_where_node_calls_them_not_utf8() {
    refuses_one_past(false, &[
        Row {
            source: "string(b)",
            activation: || activation(vec![("b", bytes(LONGEST + 1))]),
            function: "string",
            node_at_the_bound: NODE_ANSWERS,
            node_one_past: "error invalid_conversion [0, 9] the bytes are not UTF-8 text",
        },
        Row {
            source: "b.string()",
            activation: || activation(vec![("b", bytes(LONGEST + 1))]),
            function: "string",
            node_at_the_bound: NODE_ANSWERS,
            node_one_past: "error invalid_conversion [0, 10] the bytes are not UTF-8 text",
        },
        Row {
            source: "b.json()",
            activation: || {
                let mut quoted = vec![b'a'; LONGEST + 1];
                quoted[0] = b'"';
                quoted[LONGEST] = b'"';
                activation(vec![("b", CelValue::Bytes(quoted.into()))])
            },
            function: "json",
            node_at_the_bound: "value string of 536870886 units",
            node_one_past: "error invalid_conversion [0, 8] the bytes are not UTF-8 text",
        },
        Row {
            source: "join([b], '')",
            activation: || activation(vec![("b", bytes(LONGEST + 1))]),
            function: "join",
            node_at_the_bound: NODE_ANSWERS,
            node_one_past: "error invalid_conversion [0, 13] join: the bytes are not UTF-8 text",
        },
    ]);
}

/// Pinned difference: Node never quotes a text that is not a UUID — it throws `TypeError:
/// Invalid UUID` out of evaluation at any length — so where this crate's interim refusal
/// would quote one past the bound, the bound's refusal is answered.
#[test]
fn difference_a_uuid_refusal_quoting_past_the_longest_string_is_the_bounds_refusal() {
    refuses_one_past(false, &[
        Row {
            source: "uuidv3('a', s)",
            activation: || activation(vec![("s", text(&("\"".repeat(268_435_000) + &"!".repeat(856)), 1))]),
            function: "uuidv3",
            node_at_the_bound: "threw TypeError: Invalid UUID",
            node_one_past: "threw TypeError: Invalid UUID",
        },
        Row {
            source: "uuidv5('a', s)",
            activation: || activation(vec![("s", text(&("\"".repeat(268_435_000) + &"!".repeat(856)), 1))]),
            function: "uuidv5",
            node_at_the_bound: "threw TypeError: Invalid UUID",
            node_one_past: "threw TypeError: Invalid UUID",
        },
        Row {
            source: "uuidVersion(s)",
            activation: || activation(vec![("s", text(&("\"".repeat(268_435_000) + &"!".repeat(861)), 1))]),
            function: "uuidVersion",
            node_at_the_bound: "threw TypeError: Invalid UUID",
            node_one_past: "threw TypeError: Invalid UUID",
        },
    ]);
}

/// A list where a specifier, a zone, flags, a pattern or decimal places are read as text,
/// which only a direct call hands over — dispatch takes none. Node answers the specifier and
/// the flags at the bound, refusing each for what it holds, and throws its host's
/// `RangeError` one past it (interim); for the zone, the pattern and the decimal places the
/// refusal would hold the text, so Node throws at the bound too, and this crate answers the
/// bound's refusal at both (a pinned difference at the bound, evaluated for the decimal
/// places alone: the zone's and the pattern's take seconds each to reach it).
#[test]
fn interim_a_list_read_as_text_past_the_longest_string_is_refused() {
    let _heavy = HEAVY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let ctx = CelCallContext { range: Some(SourceRange { start: 0, end: 1 }) };
    let call = |key: &str, args: &[CelValue]| match catalog_implementation(key, &CelCatalogHandlers::default()).unwrap()(&ctx, args) {
        CelValue::Error(error) => format!("error {} {}", error.code.as_str(), error.message),
        _ => "a value".to_string(),
    };
    let listed = |fill: &str, head: &[&str], tail: usize| {
        let element = CelValue::String(fill.repeat(K - 1).into());
        let mut items: Vec<CelValue> = head.iter().map(|text| CelValue::String((*text).into())).collect();
        items.extend(std::iter::repeat_n(element, K));
        items.push(CelValue::String(fill.repeat(tail).into()));
        CelValue::List(items.into())
    };
    let instant = environment().evaluate("timestamp('2024-01-01T00:00:00Z')", &(), &EvaluateOptions::default()).unwrap();
    let too_long = |function: &str| {
        format!("error invalid_argument {function}: the text built would exceed the longest text a string can hold (536870888 UTF-16 code units)")
    };
    // (key, the function refusing, Node at the bound, Node one past, evaluated at the bound)
    let rows: [(&str, &str, &str, &str, bool); 5] = [
        ("format(double, string)", "format", "error invalid_argument format: unknown format type 'a' (one of efgrs%pbodxXcn)", NODE_RANGE_ERROR, true),
        ("regexExtract(string, string, string)", "regexExtract", "error invalid_argument regexExtract: unknown regex flag ',' (supported: i, m, s)", NODE_RANGE_ERROR, true),
        ("dateIn(google.protobuf.Timestamp, string)", "dateIn", NODE_RANGE_ERROR, NODE_RANGE_ERROR, false),
        ("regexExtract(string, string)", "regexExtract", NODE_RANGE_ERROR, NODE_RANGE_ERROR, false),
        ("round(double, int)", "round", NODE_RANGE_ERROR, NODE_RANGE_ERROR, true),
    ];
    for (key, function, node_at_the_bound, node_one_past, evaluated_at_the_bound) in rows {
        let at = |length: usize| -> Vec<CelValue> {
            match key {
                "format(double, string)" => vec![CelValue::Double(1.5), listed("a", &[], length - K * K)],
                "regexExtract(string, string, string)" => {
                    vec![CelValue::String("a".into()), CelValue::String("a".into()), listed("g", &[], length - K * K)]
                }
                "dateIn(google.protobuf.Timestamp, string)" => vec![instant.clone(), listed("a", &[], length - K * K)],
                "regexExtract(string, string)" => vec![CelValue::String("a".into()), listed("a", &["*"], length - K * K - 2)],
                _ => vec![CelValue::Double(1.5), listed("a", &[], length - K * K)],
            }
        };
        let (one_past, largest) = with_largest_block(|| call(key, &at(LONGEST + 1)));
        assert_eq!(one_past, too_long(function), "{key}");
        assert_ne!(one_past, node_one_past, "{key}");
        assert!(largest < REFUSAL_BLOCK_LIMIT, "{key} allocated a block of {largest} bytes");
        if !evaluated_at_the_bound {
            continue;
        }
        let at_the_bound = call(key, &at(LONGEST));
        if node_at_the_bound == NODE_RANGE_ERROR {
            assert_eq!(at_the_bound, too_long(function), "{key} at the bound");
        } else {
            assert_eq!(at_the_bound, node_at_the_bound, "{key} at the bound");
        }
    }
}

// --- the audit's case ------------------------------------------------------------------------

const AUDIT_25000: &str = "size(replace(join(range(25000).map(i, 'a'), ''), '', join(range(25000).map(i, 'b'), '')))";
const AUDIT_40000: &str = "size(replace(join(range(40000).map(i, 'a'), ''), '', join(range(40000).map(i, 'b'), '')))";

/// Interim: Node throws its host's `RangeError` for both; this crate answered `625000000`
/// for the first, building the text, and aborted building the second under 1 GiB.
#[test]
fn interim_the_audits_replacement_is_refused_before_it_is_built() {
    let environment = environment();
    for source in [AUDIT_25000, AUDIT_40000] {
        let (answered, largest) =
            with_largest_block(|| answer(environment.evaluate(source, &(), &EvaluateOptions::default())));
        // The `replace` call, inside `size(…)`.
        assert_eq!(answered, refused_at("replace", "size(".len(), source.len() - 1));
        assert!(largest < REFUSAL_BLOCK_LIMIT, "{source} allocated a block of {largest} bytes");
    }
}

/// The 40,000-character case under an address-space limit of 1 GiB, which Linux enforces:
/// the text it would build is 1.6 GB, so the refusal is answered only if it is found before
/// the text is allocated. The test runs itself again under the limit, and fails wherever the
/// limit is not enforced or the evaluation aborts.
#[cfg(target_os = "linux")]
#[test]
fn refuses_the_audits_replacement_under_an_address_space_limit() {
    const LIMITED: &str = "TELORUN_CEL_TEST_ADDRESS_SPACE_LIMITED";
    if std::env::var_os(LIMITED).is_some() {
        let answered = answer(environment().evaluate(AUDIT_40000, &(), &EvaluateOptions::default()));
        assert_eq!(answered, refused_at("replace", 5, 88));
        // The limit is enforced: a gigabyte is refused.
        assert!(Vec::<u8>::new().try_reserve_exact(1 << 30).is_err(), "the address space is not limited");
        return;
    }
    let status = std::process::Command::new("sh")
        .args(["-c", "ulimit -v 1048576 && exec \"$0\" \"$@\""])
        .arg(std::env::current_exe().unwrap())
        .args(["--exact", "refuses_the_audits_replacement_under_an_address_space_limit", "--test-threads", "1"])
        .env(LIMITED, "1")
        .status()
        .unwrap();
    assert!(status.success(), "the test under an address-space limit failed: {status}");
}
