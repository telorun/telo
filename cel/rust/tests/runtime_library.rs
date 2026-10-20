//! What every operator and standard function does — the twin of
//! `cel/nodejs/tests/runtime-library.test.ts`, and a table of what each implementation
//! answers.
//!
//! Twinned: the two coverage cases (every signature the library registers has an
//! implementation, and every keyed implementation answers a registered signature).
//! The by-name direction Node's test leaves unchecked is pinned inside the crate, where
//! the by-name table is readable. The two evaluating cases — a host's function with no
//! behaviour, and a call written wider than any signature — evaluate through the
//! environment; their answers are Node's `CelEnvironment.evaluate`, executed on the same
//! build. The registration half of the second is `function_registry.rs`'s.
//!
//! The table calls each of the 119 keyed implementations and the seven by name at least
//! once, about the range `[3, 9)`; each expected value is what `implementationOf` answered
//! on Node, executed — `@telorun/cel 0.120.1 at b4a2b6e9`. Where the engine answers
//! otherwise than Node, the row is a named test below that names Node's answer.

mod evaluation_support;
mod value_support;

use std::sync::Arc;

use evaluation_support::{loose, source_answer};
use telorun_cel::{
    FunctionMetadata,
    base64_text, cel_type_value_of, implementation_of, implemented_keys, json_as_cel_value, optional_of_non_zero,
    read_json_text, register_standard_library, signature_key, standard_constant_values, type_value_name,
    CelCallContext, CelHostValue, CelValue, FunctionRegistry, StandardLibraryOptions,
};

use value_support::*;

/// `(dispatch key or name, arguments, Node's answer)`.
fn node_answers() -> Vec<(&'static str, Vec<CelValue>, CelValue)> {
    vec![
    ("bool(bool)", vec![b(true)], b(true)),
    ("bool(bool)", vec![b(false)], b(false)),
    ("bool(string)", vec![s("1")], b(true)),
    ("bool(string)", vec![s("t")], b(true)),
    ("bool(string)", vec![s("true")], b(true)),
    ("bool(string)", vec![s("TRUE")], b(true)),
    ("bool(string)", vec![s("True")], b(true)),
    ("bool(string)", vec![s("0")], b(false)),
    ("bool(string)", vec![s("f")], b(false)),
    ("bool(string)", vec![s("false")], b(false)),
    ("bool(string)", vec![s("FALSE")], b(false)),
    ("bool(string)", vec![s("False")], b(false)),
    ("bool(string)", vec![s("tRUE")], err("invalid_conversion", "bool() cannot convert \"tRUE\"")),
    ("bool(string)", vec![s("yes")], err("invalid_conversion", "bool() cannot convert \"yes\"")),
    ("bool(string)", vec![s("")], err("invalid_conversion", "bool() cannot convert \"\"")),
    ("bool(string)", vec![s(" true")], err("invalid_conversion", "bool() cannot convert \" true\"")),
    ("bytes(bytes)", vec![by(&[0, 255])], by(&[0, 255])),
    ("bytes(string)", vec![s("abc")], by(&[97, 98, 99])),
    ("bytes(string)", vec![s("ÿ")], by(&[195, 191])),
    ("bytes(string)", vec![s("😀")], by(&[240, 159, 152, 128])),
    ("bytes(string)", vec![s("")], by(&[])),
    ("double(double)", vec![d(1.5)], d(1.5)),
    ("double(double)", vec![d(f64::NAN)], d(f64::NAN)),
    ("double(int)", vec![i(9223372036854775807)], d(9223372036854776000.0)),
    ("double(int)", vec![i(i64::MIN)], d(-9223372036854776000.0)),
    ("double(int)", vec![i(9007199254740993)], d(9007199254740992.0)),
    ("double(int)", vec![i(7)], d(7.0)),
    ("double(uint)", vec![u(18446744073709551615)], d(18446744073709552000.0)),
    ("double(uint)", vec![u(9007199254740993)], d(9007199254740992.0)),
    ("double(string)", vec![s("1.5")], d(1.5)),
    ("double(string)", vec![s("-.5")], d(-0.5)),
    ("double(string)", vec![s("5.")], d(5.0)),
    ("double(string)", vec![s("+1e3")], d(1000.0)),
    ("double(string)", vec![s("1E-3")], d(0.001)),
    ("double(string)", vec![s("1e400")], d(f64::INFINITY)),
    ("double(string)", vec![s("-1e400")], d(f64::NEG_INFINITY)),
    ("double(string)", vec![s("Inf")], d(f64::INFINITY)),
    ("double(string)", vec![s("+Inf")], d(f64::INFINITY)),
    ("double(string)", vec![s("-Infinity")], d(f64::NEG_INFINITY)),
    ("double(string)", vec![s("NaN")], d(f64::NAN)),
    ("double(string)", vec![s("nan")], err("invalid_conversion", "double() cannot convert \"nan\"")),
    ("double(string)", vec![s("inf")], err("invalid_conversion", "double() cannot convert \"inf\"")),
    ("double(string)", vec![s(" 1")], err("invalid_conversion", "double() cannot convert \" 1\"")),
    ("double(string)", vec![s("0x10")], err("invalid_conversion", "double() cannot convert \"0x10\"")),
    ("double(string)", vec![s(".")], err("invalid_conversion", "double() cannot convert \".\"")),
    ("double(string)", vec![s("1e")], err("invalid_conversion", "double() cannot convert \"1e\"")),
    ("double(string)", vec![s("e3")], err("invalid_conversion", "double() cannot convert \"e3\"")),
    ("double(string)", vec![s("")], err("invalid_conversion", "double() cannot convert \"\"")),
    ("double(string)", vec![s("0.30000000000000004")], d(0.30000000000000004)),
    ("double(string)", vec![s("123456789012345678901234567890")], d(1.2345678901234568e29)),
    ("duration(string)", vec![s("1h30m")], du(5400, 0)),
    ("duration(string)", vec![s("-1.5s")], du(-1, -500000000)),
    ("duration(string)", vec![s("0")], du(0, 0)),
    ("duration(string)", vec![s("100ns")], du(0, 100)),
    ("duration(string)", vec![s("1µs")], du(0, 1000)),
    ("duration(string)", vec![s("9223372036.854775807s")], du(9223372036, 854775807)),
    ("duration(string)", vec![s("9223372036.854775808s")], err("invalid_conversion", "duration out of range")),
    ("duration(string)", vec![s("1x")], err("invalid_conversion", "\"1x\" is not a duration")),
    ("duration(string)", vec![s("")], err("invalid_conversion", "\"\" is not a duration")),
    ("duration(google.protobuf.Duration)", vec![du(1, 500000000)], du(1, 500000000)),
    ("dyn(A)", vec![l(vec![i(1), s("a")])], l(vec![i(1), s("a")])),
    ("dyn(A)", vec![null()], null()),
    ("int(int)", vec![i(-5)], i(-5)),
    ("int(uint)", vec![u(9223372036854775807)], i(9223372036854775807)),
    ("int(uint)", vec![u(9223372036854775808)], err("numeric_overflow", "integer overflow: 9223372036854775808")),
    ("int(double)", vec![d(1.9)], i(1)),
    ("int(double)", vec![d(-1.9)], i(-1)),
    ("int(double)", vec![d(-0.5)], i(0)),
    ("int(double)", vec![d(9223372036854775000.0)], i(9223372036854774784)),
    ("int(double)", vec![d(9223372036854776000.0)], err("numeric_overflow", "integer overflow: 9223372036854776000")),
    ("int(double)", vec![d(-9223372036854776000.0)], err("numeric_overflow", "integer overflow: -9223372036854776000")),
    ("int(double)", vec![d(f64::NAN)], err("invalid_conversion", "int() cannot convert NaN")),
    ("int(double)", vec![d(f64::INFINITY)], err("invalid_conversion", "int() cannot convert +Inf")),
    ("int(double)", vec![d(f64::NEG_INFINITY)], err("invalid_conversion", "int() cannot convert -Inf")),
    ("int(double)", vec![d(1e300)], err("numeric_overflow", "integer overflow: 1e+300")),
    ("int(string)", vec![s("42")], i(42)),
    ("int(string)", vec![s("-42")], i(-42)),
    ("int(string)", vec![s("+42")], i(42)),
    ("int(string)", vec![s("007")], i(7)),
    ("int(string)", vec![s("-0")], i(0)),
    ("int(string)", vec![s("9223372036854775807")], i(9223372036854775807)),
    ("int(string)", vec![s("9223372036854775808")], err("numeric_overflow", "integer overflow: 9223372036854775808")),
    ("int(string)", vec![s("-9223372036854775808")], i(i64::MIN)),
    ("int(string)", vec![s("-9223372036854775809")], err("numeric_overflow", "integer overflow: -9223372036854775809")),
    ("int(string)", vec![s("00000000000000000000000000000000000000000000000000001")], i(1)),
    ("int(string)", vec![s("99999999999999999999999999999999999999999")], err("numeric_overflow", "integer overflow: 99999999999999999999999999999999999999999")),
    ("int(string)", vec![s("-99999999999999999999999999999999999999999")], err("numeric_overflow", "integer overflow: -99999999999999999999999999999999999999999")),
    ("int(string)", vec![s("1.0")], err("invalid_conversion", "int() cannot convert \"1.0\"")),
    ("int(string)", vec![s(" 1")], err("invalid_conversion", "int() cannot convert \" 1\"")),
    ("int(string)", vec![s("")], err("invalid_conversion", "int() cannot convert \"\"")),
    ("int(string)", vec![s("--1")], err("invalid_conversion", "int() cannot convert \"--1\"")),
    ("int(string)", vec![s("1e3")], err("invalid_conversion", "int() cannot convert \"1e3\"")),
    ("int(google.protobuf.Timestamp)", vec![ts(1234567890, 500000000)], i(1234567890)),
    ("int(google.protobuf.Timestamp)", vec![ts(-1, 500000000)], i(-1)),
    ("int(google.protobuf.Timestamp)", vec![ts(-62135596800, 0)], i(-62135596800)),
    ("int(google.protobuf.Duration)", vec![du(-1, -500000000)], i(-1)),
    ("int(google.protobuf.Duration)", vec![du(123, 321456789)], i(123)),
    ("int(google.protobuf.Duration)", vec![du(200000000000, 0)], i(200000000000)),
    ("matches(string, string)", vec![s("abc"), s("b+")], b(true)),
    ("matches(string, string)", vec![s("abc"), s("^b")], b(false)),
    ("matches(string, string)", vec![s("abc"), s("(")], err("invalid_regular_expression", "\"(\" is not an RE2 pattern: error parsing regexp: missing closing ): `(`")),
    ("size(string)", vec![s("abc")], i(3)),
    ("size(string)", vec![s("😀a")], i(2)),
    ("size(string)", vec![s("é")], i(2)),
    ("size(string)", vec![s("")], i(0)),
    ("size(bytes)", vec![by(&[240, 159, 152, 128])], i(4)),
    ("size(list<A>)", vec![l(vec![i(1), l(vec![i(2), i(3)])])], i(2)),
    ("size(list<A>)", vec![l(vec![])], i(0)),
    ("size(map<K, V>)", vec![m(vec![(i(1), s("a")), (s("b"), i(2))])], i(2)),
    ("size(map<K, V>)", vec![rec(vec![("a", i(1))])], i(1)),
    ("size(map<K, V>)", vec![m(vec![])], i(0)),
    ("string(string)", vec![s("x")], s("x")),
    ("string(bool)", vec![b(true)], s("true")),
    ("string(bool)", vec![b(false)], s("false")),
    ("string(int)", vec![i(i64::MIN)], s("-9223372036854775808")),
    ("string(uint)", vec![u(18446744073709551615)], s("18446744073709551615")),
    ("string(double)", vec![d(1.5)], s("1.5")),
    ("string(double)", vec![d(100.0)], s("100")),
    ("string(double)", vec![d(1e21)], s("1e+21")),
    ("string(double)", vec![d(1e-7)], s("1e-7")),
    ("string(double)", vec![d(123456789.123)], s("123456789.123")),
    ("string(double)", vec![d(-0.0)], s("-0")),
    ("string(double)", vec![d(f64::NAN)], s("NaN")),
    ("string(double)", vec![d(f64::INFINITY)], s("+Inf")),
    ("string(double)", vec![d(f64::NEG_INFINITY)], s("-Inf")),
    ("string(double)", vec![d(0.30000000000000004)], s("0.30000000000000004")),
    ("string(bytes)", vec![by(&[104, 195, 169, 108, 108, 111])], s("héllo")),
    ("string(bytes)", vec![by(&[239, 187, 191, 97])], s("a")),
    ("string(bytes)", vec![by(&[255])], err("invalid_conversion", "the bytes are not UTF-8 text")),
    ("string(bytes)", vec![by(&[237, 160, 128])], err("invalid_conversion", "the bytes are not UTF-8 text")),
    ("string(google.protobuf.Timestamp)", vec![ts(1234567890, 0)], s("2009-02-13T23:31:30Z")),
    ("string(google.protobuf.Timestamp)", vec![ts(253402300799, 999999999)], s("9999-12-31T23:59:59.999999999Z")),
    ("string(google.protobuf.Timestamp)", vec![ts(1709208000, 120000000)], s("2024-02-29T12:00:00.12Z")),
    ("string(google.protobuf.Duration)", vec![du(5400, 0)], s("5400s")),
    ("string(google.protobuf.Duration)", vec![du(-1, -500000000)], s("-1.5s")),
    ("string(google.protobuf.Duration)", vec![du(0, 1)], s("0.000000001s")),
    ("string(google.protobuf.Duration)", vec![du(0, 0)], s("0s")),
    ("timestamp(string)", vec![s("2009-02-13T23:31:30Z")], ts(1234567890, 0)),
    ("timestamp(string)", vec![s("2009-02-13t23:31:30.123456789123+05:30")], ts(1234548090, 123456789)),
    ("timestamp(string)", vec![s("0001-01-01T00:00:00Z")], ts(-62135596800, 0)),
    ("timestamp(string)", vec![s("0000-12-31T23:59:59Z")], err("invalid_conversion", "timestamp out of range")),
    ("timestamp(string)", vec![s("2024-02-30T00:00:00Z")], err("invalid_conversion", "\"2024-02-30T00:00:00Z\" is not an instant")),
    ("timestamp(string)", vec![s("2009-02-13")], err("invalid_conversion", "\"2009-02-13\" is not an RFC 3339 instant")),
    ("timestamp(string)", vec![s("2009-02-13T23:31:30+99:99")], ts(1234205550, 0)),
    ("timestamp(int)", vec![i(1234567890)], ts(1234567890, 0)),
    ("timestamp(int)", vec![i(-62135596800)], ts(-62135596800, 0)),
    ("timestamp(int)", vec![i(-62135596801)], err("invalid_conversion", "timestamp out of range")),
    ("timestamp(int)", vec![i(253402300800)], err("invalid_conversion", "timestamp out of range")),
    ("timestamp(google.protobuf.Timestamp)", vec![ts(1234567890, 0)], ts(1234567890, 0)),
    ("uint(uint)", vec![u(3)], u(3)),
    ("uint(int)", vec![i(7)], u(7)),
    ("uint(int)", vec![i(-1)], err("numeric_overflow", "unsigned integer overflow: -1")),
    ("uint(double)", vec![d(1.9)], u(1)),
    ("uint(double)", vec![d(-0.5)], u(0)),
    ("uint(double)", vec![d(-1.5)], err("numeric_overflow", "unsigned integer overflow: -1")),
    ("uint(double)", vec![d(18446744073709550000.0)], u(18446744073709549568)),
    ("uint(double)", vec![d(18446744073709552000.0)], err("numeric_overflow", "unsigned integer overflow: 18446744073709551616")),
    ("uint(double)", vec![d(1e300)], err("numeric_overflow", "unsigned integer overflow: 1000000000000000052504760255204420248704468581108159154915854115511802457988908195786371375080447864043704443832883878176942523235360430575644792184786706982848387200926575803737830233794788090059368953234970799945081119038967640880074652742780142494579258788820056842838115669472196386865459400540160")),
    ("uint(double)", vec![d(f64::NAN)], err("invalid_conversion", "uint() cannot convert NaN")),
    ("uint(double)", vec![d(f64::NEG_INFINITY)], err("invalid_conversion", "uint() cannot convert -Inf")),
    ("uint(string)", vec![s("42")], u(42)),
    ("uint(string)", vec![s("+42")], u(42)),
    ("uint(string)", vec![s("-1")], err("invalid_conversion", "uint() cannot convert \"-1\"")),
    ("uint(string)", vec![s("18446744073709551615")], u(18446744073709551615)),
    ("uint(string)", vec![s("18446744073709551616")], err("numeric_overflow", "unsigned integer overflow: 18446744073709551616")),
    ("uint(string)", vec![s("000018446744073709551615")], u(18446744073709551615)),
    ("uint(string)", vec![s("1.0")], err("invalid_conversion", "uint() cannot convert \"1.0\"")),
    ("string.size()", vec![s("😀😀")], i(2)),
    ("bytes.size()", vec![by(&[97, 98, 99])], i(3)),
    ("list<A>.size()", vec![l(vec![null(), null()])], i(2)),
    ("map<K, V>.size()", vec![rec(vec![("a", i(1)), ("b", i(2))])], i(2)),
    ("string.startsWith(string)", vec![s("abc"), s("ab")], b(true)),
    ("string.startsWith(string)", vec![s("abc"), s("")], b(true)),
    ("string.startsWith(string)", vec![s("😀a"), s("😀")], b(true)),
    ("string.startsWith(string)", vec![s("abc"), s("b")], b(false)),
    ("string.endsWith(string)", vec![s("abc"), s("bc")], b(true)),
    ("string.endsWith(string)", vec![s("a😀"), s("😀")], b(true)),
    ("string.endsWith(string)", vec![s("abc"), s("ab")], b(false)),
    ("string.contains(string)", vec![s("abc"), s("b")], b(true)),
    ("string.contains(string)", vec![s("abc"), s("")], b(true)),
    ("string.contains(string)", vec![s("abc"), s("d")], b(false)),
    ("string.matches(string)", vec![s("a1"), s("\\d")], b(true)),
    ("string.matches(string)", vec![s("abc"), s("a)")], err("invalid_regular_expression", "\"a)\" is not an RE2 pattern: error parsing regexp: unexpected ): `a)`")),
    ("string.lowerAscii()", vec![s("HeLLo")], s("hello")),
    ("string.lowerAscii()", vec![s("ΟΔΥΣΣΕΥΣ")], s("οδυσσευς")),
    ("string.lowerAscii()", vec![s("İ")], s("i̇")),
    ("string.lowerAscii()", vec![s("ΑΣ.Σ")], s("ασ.ς")),
    ("string.lowerAscii()", vec![s("ÀÉÎ")], s("àéî")),
    ("string.lowerAscii()", vec![s("𐐀")], s("𐐨")),
    ("string.upperAscii()", vec![s("hello")], s("HELLO")),
    ("string.upperAscii()", vec![s("straße")], s("STRASSE")),
    ("string.upperAscii()", vec![s("ŉ")], s("ʼN")),
    ("string.upperAscii()", vec![s("ﬃ")], s("FFI")),
    ("string.upperAscii()", vec![s("ΐ")], s("Ϊ́")),
    ("string.upperAscii()", vec![s("ǅ")], s("Ǆ")),
    ("string.trim()", vec![s("  a b \t\n")], s("a b")),
    ("string.trim()", vec![s(" \u{2028}x\u{feff}　")], s("x")),
    ("string.trim()", vec![s("\u{85}x\u{85}")], s("\u{85}x\u{85}")),
    ("string.trim()", vec![s("")], s("")),
    ("string.indexOf(string)", vec![s("abcabc"), s("c")], i(2)),
    ("string.indexOf(string)", vec![s("a😀b😀"), s("😀")], i(1)),
    ("string.indexOf(string)", vec![s("a😀b"), s("b")], i(3)),
    ("string.indexOf(string)", vec![s("abc"), s("")], i(0)),
    ("string.indexOf(string)", vec![s("abc"), s("d")], i(-1)),
    ("string.indexOf(string, int)", vec![s("abcabc"), s("c"), i(3)], i(5)),
    ("string.indexOf(string, int)", vec![s("😀😀"), s("😀"), i(1)], i(2)),
    ("string.indexOf(string, int)", vec![s("😀x"), s(""), i(1)], i(1)),
    ("string.indexOf(string, int)", vec![s("abc"), s("a"), i(3)], i(-1)),
    ("string.indexOf(string, int)", vec![s("abc"), s(""), i(3)], i(3)),
    ("string.indexOf(string, int)", vec![s("abc"), s("a"), i(4)], err("invalid_argument", "index 4 is outside the string")),
    ("string.indexOf(string, int)", vec![s("abc"), s("a"), i(-1)], err("invalid_argument", "index -1 is outside the string")),
    ("string.lastIndexOf(string)", vec![s("abcabc"), s("c")], i(5)),
    ("string.lastIndexOf(string)", vec![s("a😀b😀"), s("😀")], i(4)),
    ("string.lastIndexOf(string)", vec![s("abc"), s("")], i(3)),
    ("string.lastIndexOf(string)", vec![s("aaa"), s("aa")], i(1)),
    ("string.lastIndexOf(string, int)", vec![s("abcabc"), s("c"), i(4)], i(2)),
    ("string.lastIndexOf(string, int)", vec![s("aaa"), s("aa"), i(0)], i(0)),
    ("string.lastIndexOf(string, int)", vec![s("😀😀"), s("😀"), i(3)], i(2)),
    ("string.lastIndexOf(string, int)", vec![s("😀😀"), s("😀"), i(1)], i(0)),
    ("string.lastIndexOf(string, int)", vec![s("a😀"), s("😀"), i(0)], i(-1)),
    ("string.lastIndexOf(string, int)", vec![s("abc"), s(""), i(1)], i(1)),
    ("string.lastIndexOf(string, int)", vec![s("abc"), s("a"), i(4)], err("invalid_argument", "index 4 is outside the string")),
    ("string.substring(int)", vec![s("abc"), i(1)], s("bc")),
    ("string.substring(int)", vec![s("abc"), i(3)], s("")),
    ("string.substring(int)", vec![s("a😀b"), i(3)], s("b")),
    ("string.substring(int)", vec![s("abc"), i(4)], err("invalid_argument", "index 4 is outside the string")),
    ("string.substring(int)", vec![s("abc"), i(-1)], err("invalid_argument", "index -1 is outside the string")),
    ("string.substring(int)", vec![s("😀"), i(2)], s("")),
    ("string.substring(int, int)", vec![s("abcdef"), i(1), i(3)], s("bc")),
    ("string.substring(int, int)", vec![s("abc"), i(2), i(2)], s("")),
    ("string.substring(int, int)", vec![s("abc"), i(2), i(1)], err("invalid_argument", "the substring starts at 2 and ends at 1")),
    ("string.substring(int, int)", vec![s("abc"), i(0), i(4)], err("invalid_argument", "index 4 is outside the string")),
    ("string.substring(int, int)", vec![s("a😀b"), i(1), i(3)], s("😀")),
    ("string.substring(int, int)", vec![s("😀"), i(1), i(1)], s("")),
    ("string.split(string)", vec![s("a,b,,c"), s(",")], l(vec![s("a"), s("b"), s(""), s("c")])),
    ("string.split(string)", vec![s("abc"), s("")], l(vec![s("a"), s("b"), s("c")])),
    ("string.split(string)", vec![s(""), s("")], l(vec![])),
    ("string.split(string)", vec![s(""), s(",")], l(vec![s("")])),
    ("string.split(string)", vec![s("a😀b"), s("😀")], l(vec![s("a"), s("b")])),
    ("string.split(string)", vec![s("abc"), s("abc")], l(vec![s(""), s("")])),
    ("string.split(string, int)", vec![s("a,b,c"), s(","), i(-1)], l(vec![s("a"), s("b"), s("c")])),
    ("string.split(string, int)", vec![s("a,b,c"), s(","), i(0)], l(vec![])),
    ("string.split(string, int)", vec![s("a,b,c"), s(","), i(1)], l(vec![s("a,b,c")])),
    ("string.split(string, int)", vec![s("a,b,c"), s(","), i(2)], l(vec![s("a"), s("b,c")])),
    ("string.split(string, int)", vec![s("a,b,c"), s(","), i(5)], l(vec![s("a"), s("b"), s("c")])),
    ("string.split(string, int)", vec![s("abc"), s(""), i(2)], l(vec![s("a"), s("bc")])),
    ("string.split(string, int)", vec![s("😀a"), s(""), i(1)], l(vec![s("😀a")])),
    ("string.split(string, int)", vec![s("a😀"), s(""), i(2)], l(vec![s("a"), s("😀")])),
    ("list<string>.join()", vec![l(vec![s("a"), s("b")])], s("ab")),
    ("list<string>.join()", vec![l(vec![])], s("")),
    ("list<string>.join(string)", vec![l(vec![s("a"), s("b"), s("c")]), s(", ")], s("a, b, c")),
    ("list<string>.join(string)", vec![l(vec![s("a")]), s("-")], s("a")),
    ("bytes.string()", vec![by(&[97, 98, 99])], s("abc")),
    ("bytes.string()", vec![by(&[195])], err("invalid_conversion", "the bytes are not UTF-8 text")),
    ("bytes.hex()", vec![by(&[0, 15, 16, 255])], s("000f10ff")),
    ("bytes.hex()", vec![by(&[])], s("")),
    ("bytes.base64()", vec![by(&[])], s("")),
    ("bytes.base64()", vec![by(&[102])], s("Zg==")),
    ("bytes.base64()", vec![by(&[102, 111])], s("Zm8=")),
    ("bytes.base64()", vec![by(&[102, 111, 111])], s("Zm9v")),
    ("bytes.base64()", vec![by(&[102, 111, 111, 98])], s("Zm9vYg==")),
    ("bytes.base64()", vec![by(&[251, 255])], s("+/8=")),
    ("bytes.json()", vec![by(&[123, 34, 98, 34, 58, 32, 91, 49, 44, 32, 50, 46, 53, 44, 32, 116, 114, 117, 101, 44, 32, 110, 117, 108, 108, 93, 44, 32, 34, 97, 34, 58, 32, 34, 120, 34, 44, 32, 34, 49, 48, 34, 58, 32, 123, 125, 44, 32, 34, 57, 34, 58, 32, 91, 93, 125])], rec(vec![("9", l(vec![])), ("10", rec(vec![])), ("b", l(vec![d(1.0), d(2.5), b(true), null()])), ("a", s("x"))])),
    ("bytes.json()", vec![by(&[239, 187, 191, 49])], d(1.0)),
    ("bytes.json()", vec![by(&[49, 101, 52, 48, 48])], d(f64::INFINITY)),
    ("bytes.json()", vec![by(&[34, 92, 117, 100, 56, 51, 100, 92, 117, 100, 101, 48, 48, 34])], s("😀")),
    ("bytes.json()", vec![by(&[255])], err("invalid_conversion", "the bytes are not UTF-8 text")),
    ("bytes.at(int)", vec![by(&[97, 98, 99]), i(0)], i(97)),
    ("bytes.at(int)", vec![by(&[97, 98, 99]), i(2)], i(99)),
    ("bytes.at(int)", vec![by(&[97, 98, 99]), i(3)], err("index_out_of_range", "index out of range: 3")),
    ("bytes.at(int)", vec![by(&[97, 98, 99]), i(-1)], err("index_out_of_range", "index out of range: -1")),
    ("bytes.at(int)", vec![by(&[255]), i(0)], i(255)),
    ("!(bool)", vec![b(true)], b(false)),
    ("-(int)", vec![i(5)], i(-5)),
    ("-(int)", vec![i(i64::MIN)], err("numeric_overflow", "integer overflow: 9223372036854775808")),
    ("-(int)", vec![i(9223372036854775807)], i(-9223372036854775807)),
    ("-(double)", vec![d(0.0)], d(-0.0)),
    ("-(double)", vec![d(-0.0)], d(0.0)),
    ("-(double)", vec![d(1.5)], d(-1.5)),
    ("+(int, int)", vec![i(1), i(2)], i(3)),
    ("+(int, int)", vec![i(9223372036854775807), i(1)], err("numeric_overflow", "integer overflow: 9223372036854775808")),
    ("+(int, int)", vec![i(i64::MIN), i(-1)], err("numeric_overflow", "integer overflow: -9223372036854775809")),
    ("+(int, int)", vec![i(i64::MIN), i(i64::MIN)], err("numeric_overflow", "integer overflow: -18446744073709551616")),
    ("+(uint, uint)", vec![u(1), u(2)], u(3)),
    ("+(uint, uint)", vec![u(18446744073709551615), u(1)], err("numeric_overflow", "unsigned integer overflow: 18446744073709551616")),
    ("+(uint, uint)", vec![u(18446744073709551615), u(18446744073709551615)], err("numeric_overflow", "unsigned integer overflow: 36893488147419103230")),
    ("+(double, double)", vec![d(0.1), d(0.2)], d(0.30000000000000004)),
    ("+(double, double)", vec![d(f64::INFINITY), d(f64::NEG_INFINITY)], d(f64::NAN)),
    ("+(double, double)", vec![d(1.7976931348623157e308), d(1.7976931348623157e308)], d(f64::INFINITY)),
    ("+(string, string)", vec![s("a"), s("😀")], s("a😀")),
    ("+(string, string)", vec![s(""), s("")], s("")),
    ("+(bytes, bytes)", vec![by(&[97]), by(&[98])], by(&[97, 98])),
    ("+(list<A>, list<A>)", vec![l(vec![i(1)]), l(vec![s("a")])], l(vec![i(1), s("a")])),
    ("+(list<A>, list<A>)", vec![l(vec![]), l(vec![])], l(vec![])),
    ("+(google.protobuf.Timestamp, google.protobuf.Duration)", vec![ts(1234567890, 0), du(1, 500000000)], ts(1234567891, 500000000)),
    ("+(google.protobuf.Timestamp, google.protobuf.Duration)", vec![ts(253402300799, 0), du(1, 0)], err("invalid_conversion", "timestamp out of range")),
    ("+(google.protobuf.Timestamp, google.protobuf.Duration)", vec![ts(1234567890, 0), du(200000000000, 0)], err("invalid_conversion", "duration out of range")),
    ("+(google.protobuf.Duration, google.protobuf.Timestamp)", vec![du(0, -1), ts(-62135596800, 0)], err("invalid_conversion", "timestamp out of range")),
    ("+(google.protobuf.Duration, google.protobuf.Timestamp)", vec![du(86400, 0), ts(1709078400, 0)], ts(1709164800, 0)),
    ("+(google.protobuf.Duration, google.protobuf.Duration)", vec![du(1, 500000000), du(1, 500000000)], du(3, 0)),
    ("+(google.protobuf.Duration, google.protobuf.Duration)", vec![du(9223372036, 854775807), du(0, 1)], err("invalid_conversion", "duration out of range")),
    ("+(google.protobuf.Duration, google.protobuf.Duration)", vec![du(200000000000, 0), du(0, 0)], err("invalid_conversion", "duration out of range")),
    ("-(int, int)", vec![i(1), i(2)], i(-1)),
    ("-(int, int)", vec![i(i64::MIN), i(1)], err("numeric_overflow", "integer overflow: -9223372036854775809")),
    ("-(uint, uint)", vec![u(3), u(2)], u(1)),
    ("-(uint, uint)", vec![u(2), u(3)], err("numeric_overflow", "unsigned integer overflow: -1")),
    ("-(double, double)", vec![d(1.5), d(0.5)], d(1.0)),
    ("-(double, double)", vec![d(f64::INFINITY), d(f64::INFINITY)], d(f64::NAN)),
    ("-(google.protobuf.Timestamp, google.protobuf.Timestamp)", vec![ts(1234567890, 0), ts(0, 0)], du(1234567890, 0)),
    ("-(google.protobuf.Timestamp, google.protobuf.Timestamp)", vec![ts(253402300799, 0), ts(-62135596800, 0)], err("invalid_conversion", "duration out of range")),
    ("-(google.protobuf.Timestamp, google.protobuf.Duration)", vec![ts(1234567890, 0), du(1, 500000000)], ts(1234567888, 500000000)),
    ("-(google.protobuf.Timestamp, google.protobuf.Duration)", vec![ts(-62135596800, 0), du(0, 1)], err("invalid_conversion", "timestamp out of range")),
    ("-(google.protobuf.Duration, google.protobuf.Duration)", vec![du(0, 1), du(0, 2)], du(0, -1)),
    ("-(google.protobuf.Duration, google.protobuf.Duration)", vec![du(-9223372036, -854775808), du(0, 1)], err("invalid_conversion", "duration out of range")),
    ("*(int, int)", vec![i(6), i(7)], i(42)),
    ("*(int, int)", vec![i(9223372036854775807), i(2)], err("numeric_overflow", "integer overflow: 18446744073709551614")),
    ("*(int, int)", vec![i(i64::MIN), i(-1)], err("numeric_overflow", "integer overflow: 9223372036854775808")),
    ("*(int, int)", vec![i(i64::MIN), i(i64::MIN)], err("numeric_overflow", "integer overflow: 85070591730234615865843651857942052864")),
    ("*(uint, uint)", vec![u(6), u(7)], u(42)),
    ("*(uint, uint)", vec![u(4294967296), u(4294967296)], err("numeric_overflow", "unsigned integer overflow: 18446744073709551616")),
    ("*(uint, uint)", vec![u(18446744073709551615), u(18446744073709551615)], err("numeric_overflow", "unsigned integer overflow: 340282366920938463426481119284349108225")),
    ("*(double, double)", vec![d(1.5), d(2.0)], d(3.0)),
    ("*(double, double)", vec![d(1e308), d(10.0)], d(f64::INFINITY)),
    ("/(int, int)", vec![i(7), i(2)], i(3)),
    ("/(int, int)", vec![i(-7), i(2)], i(-3)),
    ("/(int, int)", vec![i(7), i(0)], err("division_by_zero", "division by zero")),
    ("/(int, int)", vec![i(i64::MIN), i(-1)], err("numeric_overflow", "integer overflow: 9223372036854775808")),
    ("/(uint, uint)", vec![u(7), u(2)], u(3)),
    ("/(uint, uint)", vec![u(7), u(0)], err("division_by_zero", "division by zero")),
    ("/(double, double)", vec![d(1.0), d(0.0)], d(f64::INFINITY)),
    ("/(double, double)", vec![d(-1.0), d(0.0)], d(f64::NEG_INFINITY)),
    ("/(double, double)", vec![d(0.0), d(0.0)], d(f64::NAN)),
    ("/(double, double)", vec![d(1.0), d(-0.0)], d(f64::NEG_INFINITY)),
    ("%(int, int)", vec![i(7), i(3)], i(1)),
    ("%(int, int)", vec![i(-7), i(3)], i(-1)),
    ("%(int, int)", vec![i(7), i(-3)], i(1)),
    ("%(int, int)", vec![i(7), i(0)], err("modulo_by_zero", "modulus by zero")),
    ("%(int, int)", vec![i(i64::MIN), i(-1)], i(0)),
    ("%(uint, uint)", vec![u(7), u(3)], u(1)),
    ("%(uint, uint)", vec![u(7), u(0)], err("modulo_by_zero", "modulus by zero")),
    ("in(A, list<A>)", vec![i(1), l(vec![d(1.0), i(2)])], b(true)),
    ("in(A, list<A>)", vec![u(2), l(vec![i(1), i(2)])], b(true)),
    ("in(A, list<A>)", vec![s("a"), l(vec![s("b")])], b(false)),
    ("in(A, list<A>)", vec![d(f64::NAN), l(vec![d(f64::NAN)])], b(false)),
    ("in(A, list<A>)", vec![l(vec![i(1)]), l(vec![l(vec![d(1.0)])])], b(true)),
    ("in(A, list<A>)", vec![null(), l(vec![null()])], b(true)),
    ("in(K, map<K, V>)", vec![i(1), m(vec![(u(1), s("x"))])], b(true)),
    ("in(K, map<K, V>)", vec![d(1.0), m(vec![(i(1), s("x"))])], b(true)),
    ("in(K, map<K, V>)", vec![d(1.5), m(vec![(i(1), s("x"))])], b(false)),
    ("in(K, map<K, V>)", vec![s("a"), rec(vec![("a", i(1))])], b(true)),
    ("in(K, map<K, V>)", vec![i(1), rec(vec![("1", i(1))])], b(false)),
    ("in(K, map<K, V>)", vec![s("__proto__"), rec(vec![])], b(false)),
    ("in(K, map<K, V>)", vec![l(vec![i(1)]), m(vec![(i(1), s("x"))])], b(false)),
    ("optional<A>.hasValue()", vec![some(null())], b(true)),
    ("optional<A>.hasValue()", vec![none()], b(false)),
    ("optional<A>.value()", vec![some(i(1))], i(1)),
    ("optional<A>.value()", vec![none()], err("optional_value_missing", "the optional holds no value")),
    ("optional<A>.or(optional<A>)", vec![some(i(1)), some(i(2))], some(i(1))),
    ("optional<A>.or(optional<A>)", vec![none(), some(i(2))], some(i(2))),
    ("optional<A>.or(optional<A>)", vec![none(), none()], none()),
    ("optional<A>.orValue(A)", vec![some(i(1)), i(2)], i(1)),
    ("optional<A>.orValue(A)", vec![none(), i(2)], i(2)),
    ("google.protobuf.Duration.getHours()", vec![du(5400, 0)], i(1)),
    ("google.protobuf.Duration.getHours()", vec![du(-5400, 0)], i(-1)),
    ("google.protobuf.Duration.getMinutes()", vec![du(5400, 0)], i(90)),
    ("google.protobuf.Duration.getMinutes()", vec![du(-90, 0)], i(-1)),
    ("google.protobuf.Duration.getSeconds()", vec![du(123, 321456789)], i(123)),
    ("google.protobuf.Duration.getSeconds()", vec![du(-1, -500000000)], i(-1)),
    ("google.protobuf.Duration.getMilliseconds()", vec![du(123, 321456789)], i(321)),
    ("google.protobuf.Duration.getMilliseconds()", vec![du(-1, -500000000)], i(-500)),
    ("google.protobuf.Timestamp.getDate()", vec![ts(1234567890, 123456789)], i(13)),
    ("google.protobuf.Timestamp.getDate()", vec![ts(-62135596800, 0)], i(1)),
    ("google.protobuf.Timestamp.getDate(string)", vec![ts(1234567890, 123456789), s("Australia/Sydney")], i(14)),
    ("google.protobuf.Timestamp.getDate(string)", vec![ts(1234567890, 123456789), s("-08:00")], i(13)),
    ("google.protobuf.Timestamp.getDate(string)", vec![ts(-62135596800, 0), s("America/New_York")], i(31)),
    ("google.protobuf.Timestamp.getDate(string)", vec![ts(1234567890, 123456789), s("Mars/Olympus")], err("invalid_argument", "\"Mars/Olympus\" is not a time zone")),
    ("google.protobuf.Timestamp.getDayOfMonth()", vec![ts(1234567890, 123456789)], i(12)),
    ("google.protobuf.Timestamp.getDayOfMonth()", vec![ts(-62135596800, 0)], i(0)),
    ("google.protobuf.Timestamp.getDayOfMonth(string)", vec![ts(1234567890, 123456789), s("Australia/Sydney")], i(13)),
    ("google.protobuf.Timestamp.getDayOfMonth(string)", vec![ts(1234567890, 123456789), s("-08:00")], i(12)),
    ("google.protobuf.Timestamp.getDayOfMonth(string)", vec![ts(-62135596800, 0), s("America/New_York")], i(30)),
    ("google.protobuf.Timestamp.getDayOfMonth(string)", vec![ts(1234567890, 123456789), s("Mars/Olympus")], err("invalid_argument", "\"Mars/Olympus\" is not a time zone")),
    ("google.protobuf.Timestamp.getDayOfWeek()", vec![ts(1234567890, 123456789)], i(5)),
    ("google.protobuf.Timestamp.getDayOfWeek()", vec![ts(-62135596800, 0)], i(1)),
    ("google.protobuf.Timestamp.getDayOfWeek(string)", vec![ts(1234567890, 123456789), s("Australia/Sydney")], i(6)),
    ("google.protobuf.Timestamp.getDayOfWeek(string)", vec![ts(1234567890, 123456789), s("-08:00")], i(5)),
    ("google.protobuf.Timestamp.getDayOfWeek(string)", vec![ts(-62135596800, 0), s("America/New_York")], i(0)),
    ("google.protobuf.Timestamp.getDayOfWeek(string)", vec![ts(1234567890, 123456789), s("Mars/Olympus")], err("invalid_argument", "\"Mars/Olympus\" is not a time zone")),
    ("google.protobuf.Timestamp.getDayOfYear()", vec![ts(1234567890, 123456789)], i(43)),
    ("google.protobuf.Timestamp.getDayOfYear()", vec![ts(-62135596800, 0)], i(0)),
    ("google.protobuf.Timestamp.getDayOfYear(string)", vec![ts(1234567890, 123456789), s("Australia/Sydney")], i(44)),
    ("google.protobuf.Timestamp.getDayOfYear(string)", vec![ts(1234567890, 123456789), s("-08:00")], i(43)),
    ("google.protobuf.Timestamp.getDayOfYear(string)", vec![ts(-62135596800, 0), s("America/New_York")], i(365)),
    ("google.protobuf.Timestamp.getDayOfYear(string)", vec![ts(1234567890, 123456789), s("Mars/Olympus")], err("invalid_argument", "\"Mars/Olympus\" is not a time zone")),
    ("google.protobuf.Timestamp.getFullYear()", vec![ts(1234567890, 123456789)], i(2009)),
    ("google.protobuf.Timestamp.getFullYear()", vec![ts(-62135596800, 0)], i(1)),
    ("google.protobuf.Timestamp.getFullYear(string)", vec![ts(1234567890, 123456789), s("Australia/Sydney")], i(2009)),
    ("google.protobuf.Timestamp.getFullYear(string)", vec![ts(1234567890, 123456789), s("-08:00")], i(2009)),
    ("google.protobuf.Timestamp.getFullYear(string)", vec![ts(-62135596800, 0), s("America/New_York")], i(0)),
    ("google.protobuf.Timestamp.getFullYear(string)", vec![ts(1234567890, 123456789), s("Mars/Olympus")], err("invalid_argument", "\"Mars/Olympus\" is not a time zone")),
    ("google.protobuf.Timestamp.getHours()", vec![ts(1234567890, 123456789)], i(23)),
    ("google.protobuf.Timestamp.getHours()", vec![ts(-62135596800, 0)], i(0)),
    ("google.protobuf.Timestamp.getHours(string)", vec![ts(1234567890, 123456789), s("Australia/Sydney")], i(10)),
    ("google.protobuf.Timestamp.getHours(string)", vec![ts(1234567890, 123456789), s("-08:00")], i(15)),
    ("google.protobuf.Timestamp.getHours(string)", vec![ts(-62135596800, 0), s("America/New_York")], i(19)),
    ("google.protobuf.Timestamp.getHours(string)", vec![ts(1234567890, 123456789), s("Mars/Olympus")], err("invalid_argument", "\"Mars/Olympus\" is not a time zone")),
    ("google.protobuf.Timestamp.getMilliseconds()", vec![ts(1234567890, 123456789)], i(123)),
    ("google.protobuf.Timestamp.getMilliseconds()", vec![ts(-62135596800, 0)], i(0)),
    ("google.protobuf.Timestamp.getMilliseconds(string)", vec![ts(1234567890, 123456789), s("Australia/Sydney")], i(123)),
    ("google.protobuf.Timestamp.getMilliseconds(string)", vec![ts(1234567890, 123456789), s("-08:00")], i(123)),
    ("google.protobuf.Timestamp.getMilliseconds(string)", vec![ts(-62135596800, 0), s("America/New_York")], i(0)),
    ("google.protobuf.Timestamp.getMilliseconds(string)", vec![ts(1234567890, 123456789), s("Mars/Olympus")], i(123)),
    ("google.protobuf.Timestamp.getMinutes()", vec![ts(1234567890, 123456789)], i(31)),
    ("google.protobuf.Timestamp.getMinutes()", vec![ts(-62135596800, 0)], i(0)),
    ("google.protobuf.Timestamp.getMinutes(string)", vec![ts(1234567890, 123456789), s("Australia/Sydney")], i(31)),
    ("google.protobuf.Timestamp.getMinutes(string)", vec![ts(1234567890, 123456789), s("-08:00")], i(31)),
    ("google.protobuf.Timestamp.getMinutes(string)", vec![ts(-62135596800, 0), s("America/New_York")], i(3)),
    ("google.protobuf.Timestamp.getMinutes(string)", vec![ts(1234567890, 123456789), s("Mars/Olympus")], err("invalid_argument", "\"Mars/Olympus\" is not a time zone")),
    ("google.protobuf.Timestamp.getMonth()", vec![ts(1234567890, 123456789)], i(1)),
    ("google.protobuf.Timestamp.getMonth()", vec![ts(-62135596800, 0)], i(0)),
    ("google.protobuf.Timestamp.getMonth(string)", vec![ts(1234567890, 123456789), s("Australia/Sydney")], i(1)),
    ("google.protobuf.Timestamp.getMonth(string)", vec![ts(1234567890, 123456789), s("-08:00")], i(1)),
    ("google.protobuf.Timestamp.getMonth(string)", vec![ts(-62135596800, 0), s("America/New_York")], i(11)),
    ("google.protobuf.Timestamp.getMonth(string)", vec![ts(1234567890, 123456789), s("Mars/Olympus")], err("invalid_argument", "\"Mars/Olympus\" is not a time zone")),
    ("google.protobuf.Timestamp.getSeconds()", vec![ts(1234567890, 123456789)], i(30)),
    ("google.protobuf.Timestamp.getSeconds()", vec![ts(-62135596800, 0)], i(0)),
    ("google.protobuf.Timestamp.getSeconds(string)", vec![ts(1234567890, 123456789), s("Australia/Sydney")], i(30)),
    ("google.protobuf.Timestamp.getSeconds(string)", vec![ts(1234567890, 123456789), s("-08:00")], i(30)),
    ("google.protobuf.Timestamp.getSeconds(string)", vec![ts(-62135596800, 0), s("America/New_York")], i(58)),
    ("google.protobuf.Timestamp.getSeconds(string)", vec![ts(1234567890, 123456789), s("Mars/Olympus")], err("invalid_argument", "\"Mars/Olympus\" is not a time zone")),
    ("==", vec![i(1), d(1.0)], b(true)),
    ("==", vec![u(1), i(1)], b(true)),
    ("==", vec![d(f64::NAN), d(f64::NAN)], b(false)),
    ("==", vec![d(-0.0), d(0.0)], b(true)),
    ("==", vec![l(vec![i(1), i(2)]), l(vec![d(1.0), u(2)])], b(true)),
    ("==", vec![m(vec![(i(1), s("a"))]), m(vec![(u(1), s("a"))])], b(true)),
    ("==", vec![rec(vec![("a", i(1))]), m(vec![(s("a"), d(1.0))])], b(true)),
    ("==", vec![some(i(1)), some(d(1.0))], b(true)),
    ("==", vec![none(), some(null())], b(false)),
    ("==", vec![null(), b(false)], b(false)),
    ("==", vec![ty("int"), ty("int")], b(true)),
    ("==", vec![s("a"), s("a")], b(true)),
    ("==", vec![i(9223372036854775807), d(9223372036854776000.0)], b(true)),
    ("!=", vec![i(1), i(2)], b(true)),
    ("!=", vec![null(), null()], b(false)),
    ("<", vec![i(1), d(1.5)], b(true)),
    ("<", vec![u(1), i(-1)], b(false)),
    ("<", vec![i(9223372036854775807), d(9223372036854776000.0)], b(false)),
    ("<", vec![s("a"), s("b")], b(true)),
    ("<", vec![s("￿"), s("😀")], b(false)),
    ("<", vec![b(false), b(true)], b(true)),
    ("<", vec![by(&[1]), by(&[1, 0])], b(true)),
    ("<", vec![ts(0, 0), ts(0, 1)], b(true)),
    ("<", vec![du(0, -1), du(0, 0)], b(true)),
    ("<", vec![d(f64::NAN), i(1)], b(false)),
    ("<", vec![i(1), s("a")], err("no_matching_overload", "int and string do not order")),
    ("<", vec![l(vec![i(1)]), l(vec![i(2)])], err("no_matching_overload", "list and list do not order")),
    ("<", vec![null(), null()], err("no_matching_overload", "null_type and null_type do not order")),
    ("<=", vec![i(1), i(1)], b(true)),
    ("<=", vec![d(f64::NAN), d(f64::NAN)], b(false)),
    (">", vec![u(18446744073709551615), d(18446744073709552000.0)], b(false)),
    (">", vec![d(2.5), i(2)], b(true)),
    (">=", vec![i(i64::MIN), d(-9223372036854776000.0)], b(true)),
    (">=", vec![b(true), b(false)], b(true)),
    ("type", vec![null()], ty("null_type")),
    ("type", vec![i(1)], ty("int")),
    ("type", vec![u(1)], ty("uint")),
    ("type", vec![d(1.5)], ty("double")),
    ("type", vec![s("a")], ty("string")),
    ("type", vec![by(&[])], ty("bytes")),
    ("type", vec![l(vec![])], ty("list")),
    ("type", vec![m(vec![])], ty("map")),
    ("type", vec![rec(vec![])], ty("map")),
    ("type", vec![ts(0, 0)], ty("google.protobuf.Timestamp")),
    ("type", vec![du(0, 0)], ty("google.protobuf.Duration")),
    ("type", vec![ty("int")], ty("type")),
    ("type", vec![some(i(1))], ty("optional_type")),
    ("type", vec![none()], ty("optional_type")),
    ]
}

#[test]
fn answers_every_implementation_as_node_does() {
    let rows = node_answers();
    for (key, args, expected) in &rows {
        assert_eq!(&call(key, args), expected, "{key} {args:?}");
    }
    let mut called: Vec<&str> = rows.iter().map(|(key, _, _)| *key).collect();
    called.dedup();
    for key in implemented_keys().into_iter().chain(["==", "!=", "<", "<=", ">", ">=", "type"]) {
        assert!(called.contains(&key), "{key} is called");
    }
}

fn registered() -> FunctionRegistry {
    let mut registry = FunctionRegistry::new();
    register_standard_library(&mut registry, StandardLibraryOptions { optional_types: true, resolve_nominal: None });
    registry
}

#[test]
fn implements_every_signature_the_standard_library_registers() {
    let registry = registered();
    let missing: Vec<String> = registry
        .list()
        .iter()
        .filter(|held| implementation_of(&held.signature).is_none())
        .map(|held| signature_key(&held.signature))
        .collect();
    assert_eq!(missing, Vec::<String>::new());
    assert_eq!(registry.list().len(), 214);
}

#[test]
fn implements_nothing_the_standard_library_does_not_register() {
    let keys: Vec<String> = registered().list().iter().map(|held| signature_key(&held.signature)).collect();
    let extra: Vec<&str> = implemented_keys().into_iter().filter(|key| !keys.iter().any(|held| held == key)).collect();
    assert_eq!(extra, Vec::<&str>::new());
    assert_eq!(implemented_keys().len(), 119);
}

/// Node: `bool('constructor')` and `bool('toString')` answer a JavaScript function and
/// `bool('__proto__')` the object prototype, read off a plain object's inherited
/// members. Here a word is one of the ten or it is refused, as any other text is.
#[test]
fn bool_refuses_a_word_on_the_javascript_prototype() {
    for word in ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"] {
        assert_eq!(
            call("bool(string)", &[s(word)]),
            err("invalid_conversion", &format!("bool() cannot convert \"{word}\"")),
            "{word}"
        );
    }
}

/// Node coerces each element to text: `['a', 1].join()` is `"a1"`, `[null].join()` is
/// `""`, `[['x']].join()` is `"x"`, `['a', 1.5].join('-')` is `"a-1.5"`, a uint joins as
/// `"[object Object]"`, and a record makes Node throw a `TypeError` out of the call. Here
/// a list holding anything but strings is no list `join` takes.
#[test]
fn join_refuses_a_list_holding_anything_but_strings() {
    let refused = |held: &str| err("no_matching_overload", &format!("no overload of \"join\" takes a list holding {held}"));
    assert_eq!(call("list<string>.join()", &[l(vec![s("a"), i(1)])]), refused("a value of type int"));
    assert_eq!(call("list<string>.join()", &[l(vec![null()])]), refused("null"));
    assert_eq!(call("list<string>.join()", &[l(vec![l(vec![s("x")])])]), refused("a list"));
    assert_eq!(call("list<string>.join()", &[l(vec![rec(vec![])])]), refused("a map"));
    assert_eq!(call("list<string>.join(string)", &[l(vec![s("a"), d(1.5)]), s("-")]), refused("a value of type double"));
    assert_eq!(call("list<string>.join(string)", &[l(vec![s("a"), u(1)]), s("-")]), refused("a value of type uint"));
}

/// Node words the refusal with V8's `JSON.parse` message — `Unexpected end of JSON
/// input`, `Unexpected token ']', "[1,]" is not valid JSON`, `Expected property name or
/// '}' in JSON at position 1 (line 1 column 2)`. Here it is the engine's JSON scan: the
/// UTF-16 offset where the text stops being JSON, and whether that is its end.
#[test]
fn bytes_json_names_the_offset_where_the_text_stops_being_json() {
    let refused = |message: &str| err("invalid_conversion", &format!("the bytes are not JSON: {message}"));
    for (text, message) in [
        ("", "invalid JSON at offset 0 (unexpected end of input)"),
        ("[1,]", "invalid JSON at offset 3"),
        ("{", "invalid JSON at offset 1 (unexpected end of input)"),
        ("tru", "invalid JSON at offset 3 (unexpected end of input)"),
        ("01", "invalid JSON at offset 1"),
        ("\"\\x\"", "invalid JSON at offset 2"),
        // After the byte order mark, counted in UTF-16 code units: `😀` is two.
        ("\u{feff}[\"😀\",]", "invalid JSON at offset 6"),
    ] {
        assert_eq!(call("bytes.json()", &[by(text.as_bytes())]), refused(message), "{text:?}");
    }
}

/// Node reads `"\ud83d"` into a string holding a lone surrogate, which no Rust string
/// holds; here the escape is refused at its backslash.
#[test]
fn bytes_json_refuses_an_escape_naming_an_unpaired_surrogate() {
    assert_eq!(
        call("bytes.json()", &[by(b"\"\\ud83d\"")]),
        err("invalid_argument", "json: unpaired surrogate at offset 1")
    );
    assert_eq!(
        call("bytes.json()", &[by(b"[1, \"\\udc00\"]")]),
        err("invalid_argument", "json: unpaired surrogate at offset 5")
    );
    assert_eq!(call("bytes.json()", &[by(b"\"\\ud83d\\ude00\"")]), s("😀"));
}

/// Node answers half a character — `'😀'.substring(1)` is `"\ude00"`, `'a😀b'.substring(0,
/// 2)` is `"a\ud83d"`, `'😀a'.split('')` is `["\ud83d", "\ude00", "a"]`. A result holding
/// no half character answers as Node, because the cut is made in code units.
#[test]
fn refuses_a_result_holding_half_a_surrogate_pair() {
    let inside = |name: &str, offset: u32| err("invalid_argument", &format!("{name}: offset {offset} is inside a surrogate pair"));
    assert_eq!(call("string.substring(int)", &[s("😀"), i(1)]), inside("substring", 1));
    assert_eq!(call("string.substring(int, int)", &[s("a😀b"), i(0), i(2)]), inside("substring", 2));
    assert_eq!(call("string.substring(int, int)", &[s("a😀b"), i(2), i(4)]), inside("substring", 2));
    assert_eq!(call("string.split(string)", &[s("😀a"), s("")]), inside("split", 1));
    assert_eq!(call("string.split(string, int)", &[s("😀a"), s(""), i(2)]), inside("split", 1));
    assert_eq!(call("string.split(string, int)", &[s("😀a"), s(""), i(1)]), l(vec![s("😀a")]));
    assert_eq!(call("string.substring(int, int)", &[s("😀"), i(1), i(1)]), s(""));
    assert_eq!(call("string.substring(int, int)", &[s("a😀b"), i(1), i(3)]), s("😀"));
}

/// Node's `getMilliseconds` answers before it reads its zone, so it refuses none:
/// `timestamp('2009-02-13T23:31:30.123456789Z').getMilliseconds('Mars/Olympus')` is
/// `123`. Kept as interim.
#[test]
fn get_milliseconds_never_judges_its_zone() {
    let at = ts(1234567890, 123456789);
    assert_eq!(call("google.protobuf.Timestamp.getMilliseconds(string)", &[at.clone(), s("Mars/Olympus")]), i(123));
    assert_eq!(
        call("google.protobuf.Timestamp.getSeconds(string)", &[at, s("Mars/Olympus")]),
        err("invalid_argument", "\"Mars/Olympus\" is not a time zone")
    );
}

/// The engine's own answer: an implementation handed values its signature does not
/// take answers as a call that resolves to nothing does. Dispatch never hands one.
#[test]
fn refuses_values_its_signature_does_not_take() {
    assert_eq!(call("size(string)", &[i(1)]), err("no_matching_overload", "no overload of \"size\" takes (int)"));
    assert_eq!(call("+(int, int)", &[i(1)]), err("no_matching_overload", "no overload of \"+\" takes (int)"));
    assert_eq!(
        call("string.substring(int)", &[s("a"), CelValue::Host(CelHostValue::unnamed(std::sync::Arc::new(())))]),
        err("no_matching_overload", "substring was handed a value of no CEL type")
    );
    assert_eq!(call("<", &[i(1)]), err("no_matching_overload", "no overload of \"<\" takes (int)"));
}

#[test]
fn reads_json_as_cel_values_in_an_objects_own_order() {
    let read = |text: &str| json_as_cel_value(&read_json_text(text).expect("JSON"));
    assert_eq!(read("null"), null());
    assert_eq!(read("-0"), d(-0.0));
    assert_eq!(read("1e400"), d(f64::INFINITY));
    assert_eq!(read("[1,[2,{\"a\":[]}]]"), l(vec![d(1.0), l(vec![d(2.0), rec(vec![("a", l(vec![]))])])]));
    assert_eq!(read("\"\\u00e9\\ud83d\\ude00\""), s("é😀"));
    // Node: `{"9": 4, "10": 3, "b": 1, "a": 2, "__proto__": 5, "constructor": {}}`, in that
    // order, `__proto__` and `constructor` held as data.
    let CelValue::Record(object) = read("{\"b\":1,\"a\":2,\"10\":3,\"9\":4,\"__proto__\":5,\"constructor\":{}}") else {
        panic!("an object is a record")
    };
    assert_eq!(object.keys().collect::<Vec<_>>(), ["9", "10", "b", "a", "__proto__", "constructor"]);
    assert_eq!(object.get("__proto__"), Some(&d(5.0)));
    // A key written twice takes its last value at its first position.
    let CelValue::Record(twice) = read("{\"a\":1,\"b\":3,\"a\":2}") else { panic!("an object is a record") };
    assert_eq!(twice.iter().map(|(key, value)| (key, value.clone())).collect::<Vec<_>>(), [("a", d(2.0)), ("b", d(3.0))]);
}

#[test]
fn reads_the_library_constants_as_their_values() {
    for (optional, names) in [
        (false, &["bool", "bytes", "double", "int", "list", "map", "null_type", "string", "type", "uint", "google"][..]),
        (true, &["bool", "bytes", "double", "int", "list", "map", "null_type", "string", "type", "uint", "optional_type", "google"][..]),
    ] {
        let values = standard_constant_values(optional);
        assert_eq!(values.keys().collect::<Vec<_>>(), names);
        assert_eq!(values.get("int"), Some(&ty("int")));
        assert_eq!(
            values.get("google"),
            Some(&rec(vec![(
                "protobuf",
                rec(vec![("Duration", ty("google.protobuf.Duration")), ("Timestamp", ty("google.protobuf.Timestamp"))])
            )]))
        );
    }
    assert_eq!(standard_constant_values(true).get("optional_type"), Some(&ty("optional_type")));
}

#[test]
fn holds_a_value_unless_it_is_its_types_zero() {
    let rows = [
        (null(), none()),
        (b(false), none()),
        (b(true), some(b(true))),
        (s(""), none()),
        (s("a"), some(s("a"))),
        (i(0), none()),
        (i(1), some(i(1))),
        (d(0.0), none()),
        (d(-0.0), none()),
        (d(f64::NAN), some(d(f64::NAN))),
        (d(0.5), some(d(0.5))),
        (u(0), none()),
        (u(1), some(u(1))),
        (by(&[]), none()),
        (by(&[0]), some(by(&[0]))),
        (l(vec![]), none()),
        (l(vec![i(0)]), some(l(vec![i(0)]))),
        (m(vec![]), none()),
        (m(vec![(i(1), i(0))]), some(m(vec![(i(1), i(0))]))),
        (rec(vec![]), none()),
        (rec(vec![("a", null())]), some(rec(vec![("a", null())]))),
        (du(0, 0), none()),
        (du(0, 1), some(du(0, 1))),
        (ts(0, 0), some(ts(0, 0))),
        (ty("int"), some(ty("int"))),
        (none(), some(none())),
        (some(null()), some(some(null()))),
    ];
    for (held, expected) in rows {
        assert_eq!(CelValue::Optional(optional_of_non_zero(held.clone())), expected, "{held:?}");
    }
}

#[test]
fn names_types_and_writes_base64_as_node_does() {
    assert_eq!(["optional", "null_type", "int", "Money"].map(type_value_name), ["optional_type", "null_type", "int", "Money"]);
    let handle = CelValue::Host(CelHostValue::unnamed(std::sync::Arc::new(())));
    assert_eq!(
        cel_type_value_of(&handle, Some(RANGE)).map(CelValue::Type).unwrap_or_else(CelValue::Error),
        err("invalid_conversion", "this value is of no CEL type")
    );
    assert_eq!(cel_type_value_of(&some(i(1)), None).map(CelValue::Type), Ok(ty("optional_type")));
    assert_eq!(cel_type_value_of(&null(), None).map(CelValue::Type), Ok(ty("null_type")));
    let written: Vec<String> = ["", "f", "fo", "foo", "foob", "fooba", "foobar"].iter().map(|text| base64_text(text.as_bytes())).collect();
    assert_eq!(written, ["", "Zg==", "Zm8=", "Zm9v", "Zm9vYg==", "Zm9vYmE=", "Zm9vYmFy"]);
    assert_eq!(base64_text(&[0xfb, 0xff, 0xfe]), "+//+");
    // A context is the call's range alone.
    assert_eq!(CelCallContext::default().range, None);
}

/// The engine's own property: JSON is read into values on a heap list, so a text a
/// hundred thousand levels deep is read, compared and released on a 256 KiB stack.
#[test]
fn reads_json_of_any_depth_on_a_small_stack() {
    std::thread::Builder::new()
        .stack_size(256 * 1024)
        .spawn(|| {
            let text = format!("{}{}", "[{\"a\":".repeat(50_000), "}]".repeat(50_000)).replacen("}]", "1}]", 1);
            let read = call("bytes.json()", &[by(text.as_bytes())]);
            let built = (0..50_000).fold(d(1.0), |held, _| l(vec![rec(vec![("a", held)])]));
            assert_eq!(read, built);
        })
        .unwrap()
        .join()
        .unwrap();
}

/// Node's reading, reproduced and reported: a registration with no implementation answers
/// `no_matching_overload`, where Node's own docs say `unbound_function`.
#[test]
#[allow(unused_variables)]
fn leaves_a_hosts_own_function_to_the_host_and_fails_a_call_to_one_with_no_behaviour() {
    let mut environment = loose();
    environment
        .register_function("hostOnly(string): string", FunctionMetadata { host_backed: true, ..FunctionMetadata::default() })
        .unwrap();
    assert_eq!(
        source_answer(&environment, "hostOnly('x')", &()),
        "error no_matching_overload [0, 13] no overload of \"hostOnly\" takes (string)"
    );
    let implementation = Arc::new(|context: &CelCallContext, args: &[CelValue]| match args {
        [CelValue::String(held)] => CelValue::String(format!("{held}!").into()),
        _ => unreachable!("hostOnly is handed a string"),
    });
    environment
        .register_function(
            "hostOnly(string): string",
            FunctionMetadata { implementation: Some(implementation), ..FunctionMetadata::default() },
        )
        .unwrap();
    assert_eq!(source_answer(&environment, "hostOnly('x')", &()), "value string \"x!\"");
}

#[test]
fn answers_a_call_written_wider_than_any_signature_with_the_ordinary_refusal() {
    let environment = loose();
    assert_eq!(
        source_answer(&environment, "'42'.replace('2', '1', 1, false)", &()),
        "error no_matching_overload [0, 32] no overload of \"replace\" takes (string, string, string, int, bool)"
    );
    assert_eq!(
        source_answer(&environment, "size(1, 2, 3, 4, 5)", &()),
        "error no_matching_overload [0, 19] no overload of \"size\" takes (int, int, int, int, int)"
    );
}
