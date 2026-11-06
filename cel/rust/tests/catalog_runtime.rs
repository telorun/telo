//! What each function of the catalog answers, refuses and is handed by the host — the
//! behaviour behind `cel/nodejs/src/catalog-runtime.ts`, which Node pins only through its
//! conformance rows.
//!
//! Every expected answer is what Node's `CelEnvironment.evaluate` (or, for a call with
//! values its signature does not take, `catalogImplementation`) answered, executed —
//! `@telorun/cel 0.129.0 at 2ee5ef49` under Node v24.21.0 (V8 13.6.233.17-node.53, ICU
//! 78.3, tz 2026c), d3-format 3.1.2, `uuid` 14.0.1, re2js 2.8.3 — in an environment with
//! unlisted names `dyn`, optional types on and the stand-in handlers. The exceptions are
//! this crate's own, each a named test below holding Node's recorded answer beside this
//! crate's: where Node throws a host exception out of evaluation, or answers a string
//! holding half a surrogate pair, this crate answers an error value in the catalog's
//! words, an interim reading the crate's README and the conformance README list.

mod evaluation_support;
mod value_support;

use std::sync::Arc;

use evaluation_support::{answer, handlers, written};
use telorun_cel::{
    catalog_implementation, register_function_catalog, CatalogRefusal, CelCallContext, CelCatalogHandlers,
    CelEnvironment, CelEnvironmentOptions, CelEvaluationCode, CelValue, EvaluateOptions, RegisterCatalogOptions,
    SourceRange,
};
use value_support::{b, i, l, rec, s, u};

fn environment_with(handlers: CelCatalogHandlers) -> CelEnvironment {
    let mut environment = CelEnvironment::new(CelEnvironmentOptions {
        unlisted_variables_are_dyn: true,
        enable_optional_types: true,
        ..Default::default()
    });
    register_function_catalog(&mut environment, RegisterCatalogOptions { handlers });
    environment
}

fn answered(environment: &CelEnvironment, source: &str) -> String {
    answer(environment.evaluate(source, &(), &EvaluateOptions::default()))
}

/// `(source, Node's answer)`: up to six answers of a different shape per function, drawn
/// from the differential, and the rows written to pin a reading — every refusal the
/// catalog words, each empty-search and container rule, `Math.round`'s tie and the text
/// order of `sort`.
const ROWS: [(&str, &str); 471] = [
    ("sha256(',.2f')", "value string \"sha256:,.2f\""),
    ("sha256('%')", "value string \"sha256:%\""),
    ("sha256('$\\'')", "value string \"sha256:$'\""),
    ("sha256('a😀b')", "value string \"sha256:a😀b\""),
    ("sha256('😀>8')", "value string \"sha256:😀>8\""),
    ("sha256('max')", "value string \"sha256:max\""),
    ("bytesToBase64(b'\\xff')", "value string \"/w==\""),
    ("bytesToBase64(b'\\xef\\xbb\\xbfhi')", "value string \"77u/aGk=\""),
    ("bytesToBase64(b'hello world')", "value string \"aGVsbG8gd29ybGQ=\""),
    ("bytesToBase64(b'')", "value string \"\""),
    ("bytesToBase64(b'\\x00\\x01')", "value string \"AAE=\""),
    ("bytesToBase64(b'ab')", "value string \"YWI=\""),
    ("coalesce([2.675, -1234.5, 1439.6, 90.5, 1e-7, 1e-7])", "value double 2.675"),
    ("coalesce([3.0, 2u, 4])", "value double 3"),
    ("coalesce(['', -5, '-0', '-23:59', [-13, 4294967296, -1440]])", "value string \"\""),
    ("coalesce([parseJson('{\"-1\":2.5,\"a\":null}'), ['n', '05:00', '$\\'', 'ix', 'x*'], []])", "value record(-1: double 2.5, a: null)"),
    ("coalesce(['\\\\d+', 'a*', 'UTC'])", "value string \"\\\\d+\""),
    ("coalesce([null, 120000])", "value int 120000"),
    ("addMonths(timestamp('1850-06-01T12:00:00.5Z'), -5, '%zz')", "error invalid_argument [0, 57] addMonths: unknown IANA time zone \"%zz\""),
    ("addMonths(timestamp('9999-12-31T23:59:59.999999999Z'), 11)", "error invalid_conversion [0, 58] addMonths: the result is outside the range of a timestamp"),
    ("addMonths(timestamp('2026-09-06T04:00:00Z'), -13)", "value timestamp 2025-08-06T04:00:00Z"),
    ("addMonths(timestamp('1970-01-01T00:00:00Z'), 2, 'ΣΑΣ')", "error invalid_argument [0, 54] addMonths: unknown IANA time zone \"ΣΑΣ\""),
    ("addMonths(timestamp('2024-03-04T05:06:07.008009010Z'), 5)", "value timestamp 2024-08-04T05:06:07Z"),
    ("addMonths(timestamp('2024-01-31T12:00:00Z'), 10)", "value timestamp 2024-11-30T12:00:00Z"),
    ("dateIn(timestamp('2026-03-29T00:59:59Z'))", "value string \"2026-03-29\""),
    ("dateIn(timestamp('2024-02-29T23:30:00Z'), 'a%20b')", "error invalid_argument [0, 50] dateIn: unknown IANA time zone \"a%20b\""),
    ("dateIn(timestamp('0001-01-01T00:00:00Z'))", "value string \"0001-01-01\""),
    ("dateIn(timestamp('0050-06-15T12:34:56.789Z'))", "value string \"0050-06-15\""),
    ("dateIn(timestamp('2026-09-06T04:00:00Z'))", "value string \"2026-09-06\""),
    ("dateIn(timestamp('1850-06-01T12:00:00.5Z'))", "value string \"1850-06-01\""),
    ("join([1.0, 3u], '%E2%82')", "value string \"1%E2%823\""),
    ("join([3, 60, 100, 9007199254740991, 9007199254740991], 'c')", "value string \"3c60c100c9007199254740991c9007199254740991\""),
    ("join([123.456, 1.45, 1.45, 1234567.891, 1e21], 'america/new_york')", "value string \"123.456america/new_york1.45america/new_york1.45america/new_york1234567.891america/new_york1e+21\""),
    ("join([9223372036854775807, -1], '')", "value string \"9223372036854775807-1\""),
    ("join([1.45, double('Infinity'), -1234.5, 1e300, 1.45], 'max')", "value string \"1.45max+Infmax-1234.5max1e+300max1.45\""),
    ("join([-0.0, -1234.5], '6BA7B810-9DAD-41D1-80B4-00C04FD430C8')", "value string \"-06BA7B810-9DAD-41D1-80B4-00C04FD430C8-1234.5\""),
    ("lower('$0')", "value string \"$0\""),
    ("lower('p')", "value string \"p\""),
    ("lower('')", "value string \"\""),
    ("lower('(a)|(b)')", "value string \"(a)|(b)\""),
    ("lower('+24:00')", "value string \"+24:00\""),
    ("lower('😀')", "value string \"😀\""),
    ("regexExtractAll('😀', 'EST')", "value list()"),
    ("regexExtractAll('%ED%A0%80', '1_000', '\u{2028}>8')", "error invalid_argument [0, 44] regexExtractAll: unknown regex flag '\u{2028}' (supported: i, m, s)"),
    ("regexExtractAll('a', '(,.2f')", "error invalid_regular_expression [0, 29] regexExtractAll: invalid RE2 pattern \"(,.2f\": missing closing )"),
    ("regexExtractAll('ffffffff-ffff-ffff-ffff-ffffffffffff', 'a*')", "value list(string \"\", string \"\", string \"\", string \"\", string \"\", string \"\", string \"\", string \"\", string \"\", string \"\", string \"\", string \"\", string \"\", string \"\", string \"\", string \"\", string \"\", string \"\", string \"\", string \"\", string \"\", string \"\", string \"\", string \"\", string \"\", string \"\", string \"\", string \"\", string \"\", string \"\", string \"\", string \"\", string \"\", string \"\", string \"\", string \"\", string \"\")"),
    ("regexExtractAll('6ba7b810-9dad-91d1-80b4-00c04fd430c8', '6ba7b810-9dad-91d1-80b4-00c04fd430c8')", "value list(string \"6ba7b810-9dad-91d1-80b4-00c04fd430c8\")"),
    ("regexExtractAll('ix', '#o', 'YW Jj\\n')", "error invalid_argument [0, 38] regexExtractAll: unknown regex flag 'Y' (supported: i, m, s)"),
    ("parseJson('[1,2]')", "value list(double 1, double 2)"),
    ("parseJson('{\"a\":1,}')", "error invalid_conversion [0, 21] parseJson: invalid JSON at offset 7"),
    ("parseJson('\"\\\\u00e9\"')", "value string \"é\""),
    ("parseJson('-0')", "value double -0"),
    ("parseJson('{\"__proto__\": 1}')", "value record(__proto__: double 1)"),
    ("parseJson('\"\\\\ud83d\\\\ude00\"')", "value string \"😀\""),
    ("base64Encode('$0')", "value string \"base64:$0\""),
    ("base64Encode('ǅ')", "value string \"base64:ǅ\""),
    ("base64Encode('UTC')", "value string \"base64:UTC\""),
    ("base64Encode('g')", "value string \"base64:g\""),
    ("base64Encode('max')", "value string \"base64:max\""),
    ("base64Encode('md5')", "value string \"base64:md5\""),
    ("range(0)", "value list()"),
    ("range(5)", "value list(int 0, int 1, int 2, int 3, int 4)"),
    ("range(17)", "value list(int 0, int 1, int 2, int 3, int 4, int 5, int 6, int 7, int 8, int 9, int 10, int 11, int 12, int 13, int 14, int 15, int 16)"),
    ("range(1)", "value list(int 0)"),
    ("md5(' Hi there ')", "value string \"md5: Hi there \""),
    ("md5('..')", "value string \"md5:..\""),
    ("md5('Q')", "value string \"md5:Q\""),
    ("md5('.0%')", "value string \"md5:.0%\""),
    ("md5('ΣΑΣ')", "value string \"md5:ΣΑΣ\""),
    ("md5('Europe/Brussels')", "value string \"md5:Europe/Brussels\""),
    ("isoIn(timestamp('2026-09-06T04:00:00Z'))", "value string \"2026-09-06T04:00:00.000Z\""),
    ("isoIn(timestamp('2026-09-06T04:00:00Z'), '~s')", "error invalid_argument [0, 46] isoIn: unknown IANA time zone \"~s\""),
    ("isoIn(timestamp('9999-12-31T23:59:59.999999999Z'), 'EST')", "value string \"9999-12-31T18:59:59.999-05:00\""),
    ("isoIn(timestamp('1970-01-01T00:00:00Z'))", "value string \"1970-01-01T00:00:00.000Z\""),
    ("isoIn(timestamp('2024-02-29T23:30:00Z'), 'ß')", "error invalid_argument [0, 45] isoIn: unknown IANA time zone \"ß\""),
    ("isoIn(timestamp('2026-10-25T00:30:00Z'), 'ab')", "error invalid_argument [0, 46] isoIn: unknown IANA time zone \"ab\""),
    ("ceil('6BA7B810-9DAD-41D1-80B4-00C04FD430C8')", "value double NaN"),
    ("ceil(100)", "value double 100"),
    ("ceil(-9007199254740992)", "value double -9007199254740992"),
    ("ceil(11)", "value double 11"),
    ("ceil(10)", "value double 10"),
    ("ceil(false)", "value double 0"),
    ("compact(parseJson('{\"x y\":{\"k\":1},\"-1\":2.5}'))", "value record(x y: record(k: double 1), -1: double 2.5)"),
    ("compact(['', {'b': ''}, 'a-_b'])", "value list(map(string \"b\": string \"\"), string \"a-_b\")"),
    ("compact(parseJson('{\"x y\":{\"k\":1}}'))", "value record(x y: record(k: double 1))"),
    ("compact({2u: [1], 'a': 1, 'b': ['c', '😀>8']})", "value map(uint 2: list(int 1), string \"a\": int 1, string \"b\": list(string \"c\", string \"😀>8\"))"),
    ("compact({'1': 'v', 1u: {'k': 1}, true: 1})", "value map(string \"1\": string \"v\", uint 1: map(string \"k\": int 1), bool true: int 1)"),
    ("compact({2u: [1]})", "value map(uint 2: list(int 1))"),
    ("default(2.675, [1u, 0.1, 9223372036854775807])", "value double 2.675"),
    ("default(false, 'nil')", "value bool false"),
    ("default(timestamp('0001-01-01T00:00:00Z'), parseJson('{\"2\":{\"k\":1},\"10\":\"s\",\"-1\":[1]}'))", "value timestamp 0001-01-01T00:00:00Z"),
    ("default({}, '(?P<n>x)(y)?')", "value map()"),
    ("default({1: 'v', true: 'v'}, 123.456)", "value map(int 1: string \"v\", bool true: string \"v\")"),
    ("default([-9007199254740992], [])", "value list(int -9007199254740992)"),
    ("sha512('😀')", "value string \"sha512:😀\""),
    ("sha512('(a)|(b)')", "value string \"sha512:(a)|(b)\""),
    ("sha512('ix')", "value string \"sha512:ix\""),
    ("sha512('abc')", "value string \"sha512:abc\""),
    ("sha512('$,.2f')", "value string \"sha512:$,.2f\""),
    ("sha512(' Hi there ')", "value string \"sha512: Hi there \""),
    ("round(1e21, 1440)", "error invalid_argument [0, 17] round: decimal places must be an integer 0-10, got 1440"),
    ("round(60, 2)", "value double 60"),
    ("round(5, 0)", "value double 5"),
    ("round(100)", "value double 100"),
    ("round(1)", "value double 1"),
    ("round(1200)", "value double 1200"),
    ("regexReplace('GMT', '>10', 'b', 'gi')", "value string \"GMT\""),
    ("regexReplace('(?i)AB', ' 3.5 ', 'n')", "value string \"(?i)AB\""),
    ("regexReplace('$9', '', '$0', '12')", "error invalid_argument [0, 34] regexReplace: unknown regex flag '1' (supported: i, m, s)"),
    ("regexReplace('UTC', 'md5', ',.2f')", "value string \"UTC\""),
    ("regexReplace('(a)|(b)', 'gi', '=')", "value string \"(a)|(b)\""),
    ("regexReplace('[', 'ΣΑΣ', 'abcabc')", "value string \"[\""),
    ("sort([-double('Infinity'), double('Infinity'), 1.005, 1.7976931348623157e308])", "value list(double -Inf, double 1.005, double 1.7976931348623157e+308, double +Inf)"),
    ("sort([10, 2, 0, 11, 5, -9007199254740992, 11, 12, 60, 11, -13, -9007199254740992, -1])", "value list(int -9007199254740992, int -9007199254740992, int -13, int -1, int 0, int 2, int 5, int 10, int 11, int 11, int 11, int 12, int 60)"),
    ("sort([1, 2u, 4u, 0.0])", "value list(double 0, int 1, uint 2, uint 4)"),
    ("sort([])", "value list()"),
    ("sort([null, 'r'])", "value list(null, string \"r\")"),
    ("sort([5, 10, 1440, 9007199254740992])", "value list(int 5, int 10, int 1440, int 9007199254740992)"),
    ("trimSuffix('true', '#b')", "value string \"true\""),
    ("trimSuffix('İstanbul', '(?P<n>x)(y)?')", "value string \"İstanbul\""),
    ("trimSuffix('ß', '05:00')", "value string \"ß\""),
    ("trimSuffix('.2r', 'a')", "value string \".2r\""),
    ("trimSuffix('abc', '.2r')", "value string \"abc\""),
    ("trimSuffix('utc', 'Y')", "value string \"utc\""),
    ("trimPrefix('%F4%90%80%80', '')", "value string \"%F4%90%80%80\""),
    ("trimPrefix('ǅ', 'n')", "value string \"ǅ\""),
    ("trimPrefix('aGVsbG8gd29ybGQ=', '')", "value string \"aGVsbG8gd29ybGQ=\""),
    ("trimPrefix('%zz', 'ΣΑΣ')", "value string \"%zz\""),
    ("trimPrefix('#o', '%2')", "value string \"#o\""),
    ("trimPrefix('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'a,b,,c')", "value string \"6ba7b810-9dad-11d1-80b4-00c04fd430c8\""),
    ("regexGroups('$,.2f', 'c')", "value list()"),
    ("regexGroups('a-b-c', '{\"a\":1}', 'Y')", "error invalid_argument [0, 36] regexGroups: unknown regex flag 'Y' (supported: i, m, s)"),
    ("regexGroups('#b', 'abc', '-23:59')", "error invalid_argument [0, 34] regexGroups: unknown regex flag '-' (supported: i, m, s)"),
    ("regexGroups('010d', '+24:00', 'Nowhere/Zone')", "error invalid_argument [0, 45] regexGroups: unknown regex flag 'N' (supported: i, m, s)"),
    ("regexGroups('c', '.3s', 'a😀b')", "error invalid_argument [0, 31] regexGroups: unknown regex flag 'a' (supported: i, m, s)"),
    ("regexGroups('p', '%e2%82%ac', '$&')", "error invalid_argument [0, 35] regexGroups: unknown regex flag '$' (supported: i, m, s)"),
    ("abs({'__proto__': {'k': 1}})", "value double NaN"),
    ("abs(1440)", "value double 1440"),
    ("abs(100u)", "value double 100"),
    ("abs(1)", "value double 1"),
    ("abs(1200)", "value double 1200"),
    ("abs(13)", "value double 13"),
    ("urlEncode('.1p')", "value string \".1p\""),
    ("urlEncode('😀')", "value string \"%F0%9F%98%80\""),
    ("urlEncode('%')", "value string \"%25\""),
    ("urlEncode('>10')", "value string \"%3E10\""),
    ("urlEncode('1_000')", "value string \"1_000\""),
    ("urlEncode('a-_b')", "value string \"a-_b\""),
    ("values({})", "value list()"),
    ("values({'b': 1, 2u: 2.5, 1: 'v'})", "value list(int 1, double 2.5, string \"v\")"),
    ("values({true: 1, false: [-2, 1200, -2]})", "value list(int 1, list(int -2, int 1200, int -2))"),
    ("values({1u: [0.5, 1.45, -0.5]})", "value list(list(double 0.5, double 1.45, double -0.5))"),
    ("values({true: '', 2u: [1]})", "value list(string \"\", list(int 1))"),
    ("values({2: 'v', true: null, 'b': 2.5, '1': ''})", "value list(string \"v\", null, double 2.5, string \"\")"),
    ("regexExtract('..', '*^12.3e')", "error invalid_regular_expression [0, 29] regexExtract: invalid RE2 pattern \"*^12.3e\": missing argument to repetition operator"),
    ("regexExtract('%2', '0b11')", "value string \"\""),
    ("regexExtract('r', 'Y', '.10f')", "error invalid_argument [0, 30] regexExtract: unknown regex flag '.' (supported: i, m, s)"),
    ("regexExtract('i', 'x*', 'p')", "error invalid_argument [0, 28] regexExtract: unknown regex flag 'p' (supported: i, m, s)"),
    ("regexExtract(' =+10.1f', 'p', 'a')", "error invalid_argument [0, 34] regexExtract: unknown regex flag 'a' (supported: i, m, s)"),
    ("regexExtract('nil', 'İstanbul', 'ΣΑΣ')", "error invalid_argument [0, 38] regexExtract: unknown regex flag 'Σ' (supported: i, m, s)"),
    ("urlDecode('6ba7b810-9dad-91d1-80b4-00c04fd430c8')", "value string \"6ba7b810-9dad-91d1-80b4-00c04fd430c8\""),
    ("urlDecode('😀')", "value string \"😀\""),
    ("urlDecode('a*')", "value string \"a*\""),
    ("urlDecode('ß')", "value string \"ß\""),
    ("urlDecode('UTC')", "value string \"UTC\""),
    ("urlDecode('\u{2028}>8')", "value string \"\u{2028}>8\""),
    ("enumerate([',.2f'])", "value list(record(index: int 0, value: string \",.2f\"))"),
    ("enumerate([3])", "value list(record(index: int 0, value: int 3))"),
    ("enumerate(['', ['1', -5, 1, 1.45, '/abs', ''], 1, 9223372036854775807, 1.0])", "value list(record(index: int 0, value: string \"\"), record(index: int 1, value: list(string \"1\", int -5, int 1, double 1.45, string \"/abs\", string \"\")), record(index: int 2, value: int 1), record(index: int 3, value: int 9223372036854775807), record(index: int 4, value: double 1))"),
    ("enumerate([-0.0, 1.005, 1e21, 1.5, -1234.5, 2.675, double('NaN'), -double('Infinity'), 0.0, 0.5])", "value list(record(index: int 0, value: double -0), record(index: int 1, value: double 1.005), record(index: int 2, value: double 1e+21), record(index: int 3, value: double 1.5), record(index: int 4, value: double -1234.5), record(index: int 5, value: double 2.675), record(index: int 6, value: double NaN), record(index: int 7, value: double -Inf), record(index: int 8, value: double 0), record(index: int 9, value: double 0.5))"),
    ("enumerate([])", "value list()"),
    ("enumerate([9223372036854775807])", "value list(record(index: int 0, value: int 9223372036854775807))"),
    ("sha1('[')", "value string \"sha1:[\""),
    ("sha1('(a)|(b)')", "value string \"sha1:(a)|(b)\""),
    ("sha1('%')", "value string \"sha1:%\""),
    ("sha1('a%20b')", "value string \"sha1:a%20b\""),
    ("sha1('YQ')", "value string \"sha1:YQ\""),
    ("sha1('0x10')", "value string \"sha1:0x10\""),
    ("trim('x*')", "value string \"x*\""),
    ("trim('true')", "value string \"true\""),
    ("trim('YW Jj\\n')", "value string \"YW Jj\""),
    ("trim('%41%42')", "value string \"%41%42\""),
    ("trim('p')", "value string \"p\""),
    ("trim('aGVsbG8')", "value string \"aGVsbG8\""),
    ("max([' Hi there ', duration('0s'), timestamp('0050-06-15T12:34:56.789Z'), null])", "value string \" Hi there \""),
    ("max([])", "value null"),
    ("max([120000, -2, -9007199254740992, 2, -9223372036854775808])", "value int 120000"),
    ("max([1, 1u, 0, '', '$,.2f'])", "value int 1"),
    ("max(['x*', 9007199254740992, [['Etc/UTC'], '1'], 'GMT', 9007199254740992, 1u])", "value string \"x*\""),
    ("max([1440, 1, 9007199254740992, 60])", "value int 9007199254740992"),
    ("distinct([])", "value list()"),
    ("distinct([2u, 4.0, 2, 0.0, 2, 2.0])", "value list(uint 2, double 4, double 0)"),
    ("distinct([double('NaN'), double('NaN'), -0.5, 0.5, -double('Infinity')])", "value list(double NaN, double NaN, double -0.5, double 0.5, double -Inf)"),
    ("distinct([-9007199254740992, -9007199254740992, 2])", "value list(int -9007199254740992, int 2)"),
    ("distinct([[{'__proto__': 1, true: 2.5}, [3, 3, 1440], 1200], 1.0, {-1: 2.5, 1: [90.5, 123.456, 1.5, 1e300, 1.005], 2: [1]}, b'\\x00\\x01', parseJson('{}')])", "value list(list(map(string \"__proto__\": int 1, bool true: double 2.5), list(int 3, int 3, int 1440), int 1200), double 1, map(int -1: double 2.5, int 1: list(double 90.5, double 123.456, double 1.5, double 1e+300, double 1.005), int 2: list(int 1)), bytes 0001, record())"),
    ("distinct([1.0, '.0%', 1, {2u: [1, 'Europe/Brussels', null, 1234567.891]}, 5, 1u])", "value list(double 1, string \".0%\", map(uint 2: list(int 1, string \"Europe/Brussels\", null, double 1234567.891)), int 5)"),
    ("split('america/new_york', 'a')", "value list(string \"\", string \"meric\", string \"/new_york\")"),
    ("split('a-_b', '-')", "value list(string \"a\", string \"_b\")"),
    ("split('-0', '😀')", "value list(string \"-0\")"),
    ("split('1_000', 'a')", "value list(string \"1_000\")"),
    ("split('.2q', ',')", "value list(string \".2q\")"),
    ("split('1e3', 'a')", "value list(string \"1e3\")"),
    ("'😀>8'.joinPath('Factory')", "value string \"😀>8/Factory\""),
    ("'%41%42'.joinPath('a-_b')", "value string \"%41%42/a-_b\""),
    ("'6BA7B810-9DAD-41D1-80B4-00C04FD430C8'.joinPath('x>8.1f')", "value string \"6BA7B810-9DAD-41D1-80B4-00C04FD430C8/x>8.1f\""),
    ("'$'.joinPath('.11f')", "value string \"$/.11f\""),
    ("'YQ'.joinPath('null')", "value string \"YQ/null\""),
    ("'Asia/Kolkata'.joinPath(',d')", "value string \"Asia/Kolkata/,d\""),
    ("slice(['r', '.10f', '\\\\b\\\\w+\\\\b', '6ba7b810-9dad-91d1-80b4-00c04fd430c8', '.10f'], 0, -1)", "value list(string \"r\", string \".10f\", string \"\\\\b\\\\w+\\\\b\", string \"6ba7b810-9dad-91d1-80b4-00c04fd430c8\")"),
    ("slice('a*', 3, 5)", "value string \"\""),
    ("slice([2.675, 5e-324, double('NaN'), 123.456], 5, 3)", "value list()"),
    ("slice(b'\\xef\\xbb\\xbfhi', 1, 100)", "value bytes bbbf6869"),
    ("slice(b'\\x00\\x01', 0, 10)", "value bytes 0001"),
    ("slice([5e-324, 0.1, 1234567.891, 0.1, 1234567.891], 1, 10)", "value list(double 0.1, double 1234567.891, double 0.1, double 1234567.891)"),
    ("fixed(-13, 10)", "value string \"-13.0000000000\""),
    ("fixed(double('NaN'), -5)", "error invalid_argument [0, 24] fixed: decimal places must be an integer 0-10, got -5"),
    ("fixed(-0.5, 10)", "value string \"-0.5000000000\""),
    ("fixed(120000, 1)", "value string \"120000.0\""),
    ("fixed(123.456, 10)", "value string \"123.4560000000\""),
    ("fixed(-9007199254740992, 10)", "error invalid_argument [0, 28] fixed: integer -9007199254740992 exceeds 2^53-1 and cannot be formatted exactly as a double"),
    ("bytesFromBase64('')", "value bytes "),
    ("bytesFromBase64('.1.2f')", "error invalid_argument [0, 24] bytesFromBase64: input length is not valid base64"),
    ("bytesFromBase64('\\\\d+')", "error invalid_argument [0, 23] bytesFromBase64: '\\' is not a base64 character"),
    ("bytesFromBase64('İstanbul')", "error invalid_argument [0, 27] bytesFromBase64: 'İ' is not a base64 character"),
    ("bytesFromBase64('-$1$2-')", "error invalid_argument [0, 25] bytesFromBase64: '$' is not a base64 character"),
    ("bytesFromBase64('6BA7B810-9DAD-41D1-80B4-00C04FD430C8')", "value bytes e8103b07cd74fbd0c00fee350f5fbcd01e3ed340b4e050f8df40bc"),
    ("format(13, 'İstanbul')", "error invalid_argument [0, 22] format: unknown format type 'l' (one of efgrs%pbodxXcn)"),
    ("format(-double('Infinity'), '.10f')", "error invalid_argument [0, 35] format: expected a finite number, got double"),
    ("format(-9007199254740992, 'Q')", "error invalid_argument [0, 30] format: unknown format type 'Q' (one of efgrs%pbodxXcn)"),
    ("format(9007199254740992, 'a,b,,c')", "error invalid_argument [0, 34] format: invalid format specifier \"a,b,,c\""),
    ("format(dyn(-9007199254740992), '$1')", "error invalid_argument [0, 36] format: integer -9007199254740992 exceeds 2^53-1 and cannot be formatted exactly as a double"),
    ("format(-0.5, '\u{2028}>8')", "error invalid_argument [0, 19] format: invalid format specifier \"\u{2028}>8\""),
    ("avg(['=', 'nil', '$9', '+08x'])", "value double NaN"),
    ("avg([4294967296, 13])", "value double 2147483654.5"),
    ("avg([1.7976931348623157e308, 1234567.891, 1.005, 1.7976931348623157e308, 90.5, 1e-7])", "value double +Inf"),
    ("avg([])", "value null"),
    ("avg([5, 9007199254740991, 120000, 1200, -5, 3, 0])", "value double 1286742750694599.5"),
    ("avg([123.456, 0.5, -2.5])", "value double 40.48533333333334"),
    ("uuidv3('YW Jj\\n', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')", "value string \"07056bd1-4d23-378c-8904-3f3f137bca36\""),
    ("uuidv3('n', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')", "value string \"e5112aea-cd39-3532-b1b1-3035d19d4ae1\""),
    ("uuidv3('GMT', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')", "value string \"216890fa-0bc1-362b-9689-3acd1d906f53\""),
    ("uuidv3('010d', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')", "value string \"de1f52d3-9e67-3d76-bb65-ca2d404133f2\""),
    ("uuidv3('$`', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')", "value string \"9ccaeb74-aef2-3bc2-865c-c51000e5eab7\""),
    ("uuidv3('%ED%A0%80', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')", "value string \"dec3bfdf-dfb3-3ae5-9ebc-7da0c6edc0d4\""),
    ("uuidValidate('UTC')", "value bool false"),
    ("uuidValidate('ffffffff-ffff-ffff-ffff-ffffffffffff')", "value bool true"),
    ("uuidValidate('YW Jj\\n')", "value bool false"),
    ("replace('😀😀', '😀', '$,.2f')", "value string \"$,.2f$,.2f\""),
    ("replace('.3~g', '😀', 'max')", "value string \".3~g\""),
    ("replace('i', 'b', '%')", "value string \"i\""),
    ("replace('p', 'a', '[')", "value string \"p\""),
    ("replace('1_000', '.2f', 'Nowhere/Zone')", "value string \"1_000\""),
    ("replace('*^12.3e', '', 'Nowhere/Zone')", "value string \"*Nowhere/Zone^Nowhere/Zone1Nowhere/Zone2Nowhere/Zone.Nowhere/Zone3Nowhere/Zonee\""),
    ("size(reverse([11, 0.1, b'', 'not-a-uuid']))", "value int 4"),
    ("size(sort(['ffffffff-ffff-ffff-ffff-ffffffffffff']))", "value int 1"),
    ("size(reverse([1440, 120000, 9007199254740992, -13, 12, 5]))", "value int 6"),
    ("size(reverse([-13, 1, 0, 11, -9223372036854775808]))", "value int 5"),
    ("size(distinct([]))", "value int 0"),
    ("size(reverse(['aGVsbG8gd29ybGQ=', '%', '010d']))", "value int 3"),
    ("json('😀')", "value string \"json\""),
    ("json(-13u)", "error no_matching_overload [5, 9] no overload of \"-\" takes (uint)"),
    ("json(['b', 'a{1001}', ' 3.5 ', 'YW Jj\\n', '😀>8'])", "value string \"json\""),
    ("json('YW Jj\\n')", "value string \"json\""),
    ("formatDuration(2.675, 11)", "value string \"3m\""),
    ("formatDuration(2.5, 0)", "error invalid_argument [0, 22] formatDuration: minutesPerDay must be a positive number, got 0"),
    ("formatDuration(1234567.891, 10)", "value string \"123456d 8m\""),
    ("formatDuration(-1440, 1200)", "value string \"-1d 4h\""),
    ("formatDuration(-9007199254740992, -9007199254740992)", "error invalid_argument [0, 52] formatDuration: integer -9007199254740992 exceeds 2^53-1 and cannot be formatted exactly as a double"),
    ("formatDuration(0.000123, 12)", "value string \"0m\""),
    ("floor([1, 120000, '12', -9223372036854775808])", "value double NaN"),
    ("floor(1u)", "value double 1"),
    ("floor(5)", "value double 5"),
    ("floor(-0.5)", "value double -1"),
    ("floor(60)", "value double 60"),
    ("floor(1.7976931348623157e308)", "value double 1.7976931348623157e+308"),
    ("startOfMonth(timestamp('2024-02-29T23:30:00Z'))", "value timestamp 2024-02-01T00:00:00Z"),
    ("startOfMonth(timestamp('0001-01-01T00:00:00Z'), 'path/to')", "error invalid_argument [0, 58] startOfMonth: unknown IANA time zone \"path/to\""),
    ("startOfMonth(timestamp('2026-09-06T04:00:00Z'))", "value timestamp 2026-09-01T00:00:00Z"),
    ("startOfMonth(timestamp('9999-12-31T23:59:59.999999999Z'))", "value timestamp 9999-12-01T00:00:00Z"),
    ("startOfMonth(timestamp('1850-06-01T12:00:00.5Z'))", "value timestamp 1850-06-01T00:00:00Z"),
    ("startOfMonth(timestamp('2026-03-29T00:59:59Z'))", "value timestamp 2026-03-01T00:00:00Z"),
    ("base64Decode('(?i)AB')", "value string \"plain:(?i)AB\""),
    ("base64Decode('.1p')", "value string \"plain:.1p\""),
    ("base64Decode('nil')", "value string \"plain:nil\""),
    ("base64Decode('.1.2f')", "value string \"plain:.1.2f\""),
    ("base64Decode('%E0%A4%A8')", "value string \"plain:%E0%A4%A8\""),
    ("base64Decode('EST')", "value string \"plain:EST\""),
    ("uuidv5('\\\\d+', '6ba7b811-9dad-11d1-80b4-00c04fd430c8')", "value string \"2f02fcf5-f88a-50b6-acb5-5bb6f1d5a3c3\""),
    ("uuidv5('+05', '6ba7b811-9dad-11d1-80b4-00c04fd430c8')", "value string \"5e554462-6451-53f1-9b7f-cdb4ab6c9447\""),
    ("uuidv5('.2r', 'ffffffff-ffff-ffff-ffff-ffffffffffff')", "value string \"5e2de373-2be6-5254-89c6-422e6d51fdad\""),
    ("uuidv5('-23:59', '6ba7b811-9dad-11d1-80b4-00c04fd430c8')", "value string \"3dca2c13-6a07-5ce7-9f91-3691741da36b\""),
    ("uuidv5('{\"a\":1}', '6ba7b811-9dad-11d1-80b4-00c04fd430c8')", "value string \"2ab8674e-66f1-513f-a4d4-bf4c6fae40ea\""),
    ("hmac('max', 'max', 'p')", "value string \"hmac:max:max:p\""),
    ("hmac('.3~g', '.1p', '.0%')", "value string \"hmac:.3~g:.1p:.0%\""),
    ("hmac('', '$&', '%')", "value string \"hmac::$&:%\""),
    ("hmac('(a)|(b)', '(?i)AB', 'sha256')", "value string \"hmac:(a)|(b):(?i)AB:sha256\""),
    ("hmac('{\"a\":1}', 'p', 'md5')", "value string \"hmac:{\\\"a\\\":1}:p:md5\""),
    ("hmac('05:00', 'n', 'a😀')", "value string \"hmac:05:00:n:a😀\""),
    ("keys(parseJson('{}'))", "value list()"),
    ("keys({1: [1]})", "value list(int 1)"),
    ("keys(parseJson('{\"1\":2.5,\"-1\":\"\"}'))", "value list(string \"1\", string \"-1\")"),
    ("keys({'b': 2.5})", "value list(string \"b\")"),
    ("keys({-1: null})", "value list(int -1)"),
    ("keys(parseJson('{\"10\":null,\"b\":1}'))", "value list(string \"10\", string \"b\")"),
    ("upper('.1.2f')", "value string \".1.2F\""),
    ("upper('s')", "value string \"S\""),
    ("upper('\\\\b\\\\w+\\\\b')", "value string \"\\\\B\\\\W+\\\\B\""),
    ("upper('%C0%80')", "value string \"%C0%80\""),
    ("upper('ΣΑΣ')", "value string \"ΣΑΣ\""),
    ("upper('+24:00')", "value string \"+24:00\""),
    ("sum([])", "value double 0"),
    ("sum([{1: 2.5}, '%E0%A4%A8', optional.none(), double('NaN'), [true, optional.none()], '1'])", "value double NaN"),
    ("sum([-0.0, 1.5, 1.005, 90.5, 0.1])", "value double 93.10499999999999"),
    ("sum([-5, 1, 11])", "value double 7"),
    ("sum([2, 9007199254740991, -5, 60, 1])", "value double 9007199254741048"),
    ("sum([1200, -1440, 1440, 11, -1440, -1])", "value double -230"),
    ("merge({'a': {'k': 1}, 2: 1}, {'b': 2.5, '__proto__': 'v', 2u: {'k': 1}, false: 'v'})", "value map(string \"a\": map(string \"k\": int 1), uint 2: map(string \"k\": int 1), string \"b\": double 2.5, string \"__proto__\": string \"v\", bool false: string \"v\")"),
    ("merge({2: null, 1: [12]}, parseJson('{\"x y\":\"\",\"b\":\"\"}'))", "value map(int 2: null, int 1: list(int 12), string \"x y\": string \"\", string \"b\": string \"\")"),
    ("merge({'b': '', '__proto__': {'k': 1}}, {2: 2.5})", "value map(string \"b\": string \"\", string \"__proto__\": map(string \"k\": int 1), int 2: double 2.5)"),
    ("merge({'1': {'k': 1}}, {'b': ['YW Jj\\n']})", "value map(string \"1\": map(string \"k\": int 1), string \"b\": list(string \"YW Jj\\n\"))"),
    ("merge(parseJson('{\"a\":\"\",\"b\":\"s\",\"x y\":{\"k\":1}}'), {})", "value record(a: string \"\", b: string \"s\", x y: record(k: double 1))"),
    ("merge({'__proto__': [1]}, {-1: 1})", "value map(string \"__proto__\": list(int 1), int -1: int 1)"),
    ("min([{1u: {'k': 1}, '1': null}, '', '1'])", "value map(uint 1: map(string \"k\": int 1), string \"1\": null)"),
    ("min([['[', 'x>8.1f', 1u, 'a-_b'], 1200, 1.0, 'sha256', 0.5, 1u])", "value list(string \"[\", string \"x>8.1f\", uint 1, string \"a-_b\")"),
    ("min([1.0, null, [null, 0, 1u], 120000])", "value null"),
    ("min([1, -5, 1200])", "value int -5"),
    ("min([1.005, 1234567.891])", "value double 1.005"),
    ("min(['\\\\b\\\\w+\\\\b', b'ab', 120000, b'\\xff', 1.0])", "value string \"\\\\b\\\\w+\\\\b\""),
    ("nowIso('Z').size() > 0", "error invalid_argument [0, 11] nowIso: unknown IANA time zone \"Z\""),
    ("nowIso('Nowhere/Zone').size() > 0", "error invalid_argument [0, 22] nowIso: unknown IANA time zone \"Nowhere/Zone\""),
    ("reverse([])", "value list()"),
    ("reverse(['1', '4pyT'])", "value list(string \"4pyT\", string \"1\")"),
    ("reverse([1u, 1234567.891, '1', [1200, 1440, 9007199254740992, -5], '1'])", "value list(string \"1\", list(int 1200, int 1440, int 9007199254740992, int -5), string \"1\", double 1234567.891, uint 1)"),
    ("reverse([-2, 100])", "value list(int 100, int -2)"),
    ("reverse([optional.none(), [123.456, 1.5, -0.5, 1e300]])", "value list(list(double 123.456, double 1.5, double -0.5, double 1e+300), optional())"),
    ("reverse([1200, 5, 100])", "value list(int 100, int 5, int 1200)"),
    ("flatten([1200])", "value list(int 1200)"),
    ("flatten([])", "value list()"),
    ("flatten([1, -2])", "value list(int 1, int -2)"),
    ("flatten([true])", "value list(bool true)"),
    ("flatten(['a*', '.012f', '(?i)AB', '%ED%A0%80', '%ED%A0%80', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'])", "value list(string \"a*\", string \".012f\", string \"(?i)AB\", string \"%ED%A0%80\", string \"%ED%A0%80\", string \"6ba7b810-9dad-11d1-80b4-00c04fd430c8\")"),
    ("flatten([1, double('NaN'), timestamp('2024-01-31T12:00:00Z'), 1u, '.2q', 1])", "value list(int 1, double NaN, timestamp 2024-01-31T12:00:00Z, uint 1, string \".2q\", int 1)"),
    ("today('Nowhere/Zone').size() > 0", "error invalid_argument [0, 21] today: unknown IANA time zone \"Nowhere/Zone\""),
    ("today('Z').size() > 0", "error invalid_argument [0, 10] today: unknown IANA time zone \"Z\""),
    ("uuidVersion('00000000-0000-0000-0000-000000000000')", "value int 0"),
    ("uuidVersion('6ba7b811-9dad-11d1-80b4-00c04fd430c8')", "value int 1"),
    ("uuidVersion('6BA7B810-9DAD-41D1-80B4-00C04FD430C8')", "value int 4"),
    ("uuidVersion('ffffffff-ffff-ffff-ffff-ffffffffffff')", "value int 15"),
    ("replace('abc', '', '-')", "value string \"a-b-c\""),
    ("replace('', '', '-')", "value string \"\""),
    ("replace('aaa', 'a', 'b')", "value string \"bbb\""),
    ("split('', '')", "value list()"),
    ("split('abc', '')", "value list(string \"a\", string \"b\", string \"c\")"),
    ("split('a,,b', ',')", "value list(string \"a\", string \"\", string \"b\")"),
    ("merge({'a': 1}, {1: 2, true: 3})", "value map(string \"a\": int 1, int 1: int 2, bool true: int 3)"),
    ("merge(parseJson('{\"a\": 1}'), {1: 2, true: false})", "value record(1: int 2, a: double 1, true: bool false)"),
    ("merge({1: 'a', 'b': 2}, {1u: 'x'})", "value map(uint 1: string \"x\", string \"b\": int 2)"),
    ("merge(parseJson('{\"2\": 1, \"a\": 2}'), {1: 3, 'b': 4})", "value record(1: int 3, 2: double 1, a: double 2, b: int 4)"),
    ("compact(parseJson('{\"a\": null, \"b\": \"\", \"c\": 1}'))", "value record(c: double 1)"),
    ("compact({'a': null, 1: '', true: 0})", "value map(bool true: int 0)"),
    ("compact([null, '', 0, false, []])", "value list(int 0, bool false, list())"),
    ("round(2.5)", "value double 3"),
    ("round(-2.5)", "value double -2"),
    ("round(-0.5)", "value double -0"),
    ("round(0.49999999999999994)", "value double 0"),
    ("round(1.005, 2)", "value double 1"),
    ("round(2.675, 2)", "value double 2.67"),
    ("round(-1.5, 0)", "value double -2"),
    ("fixed(1.005, 2)", "value string \"1.00\""),
    ("fixed(-0.0001, 2)", "value string \"0.00\""),
    ("sort([1, 'a', 2.5, null])", "value list(int 1, string \"a\", null, double 2.5)"),
    ("sort([double('NaN'), 3, 1, 2])", "value list(double NaN, int 1, int 2, int 3)"),
    ("sort(['b', 'a', 'B', '😀', '\\uffff'])", "value list(string \"B\", string \"a\", string \"b\", string \"😀\", string \"￿\")"),
    ("sort([[2, 1], [1, 2], 1])", "value list(int 1, list(int 1, int 2), list(int 2, int 1))"),
    ("sort([2u, 1, 1.5, '0'])", "value list(string \"0\", int 1, double 1.5, uint 2)"),
    ("distinct([1, 1u, 1.0, '1', [1], [1.0], {'a': 1}, {'a': 1u}])", "value list(int 1, string \"1\", list(int 1), map(string \"a\": int 1))"),
    ("distinct([double('NaN'), double('NaN'), [double('NaN')], [double('NaN')]])", "value list(double NaN, double NaN, list(double NaN), list(double NaN))"),
    ("distinct([9007199254740993, 9007199254740992.0, 9007199254740992])", "value list(int 9007199254740993, int 9007199254740992)"),
    ("distinct([optional.of(1), optional.of(1u), optional.none(), optional.none()])", "value list(optional(int 1), optional())"),
    ("distinct([parseJson('{\"a\": 1}'), {'a': 1}, {'a': 1.0}])", "value list(record(a: double 1))"),
    ("join([[1, [2, []]], [], 'x'], '|')", "value string \"1,2,||x\""),
    ("join([timestamp('2024-01-01T00:00:00Z'), duration('90s'), b'hi', null, true, 1.5, 2u], ',')", "value string \"2024-01-01T00:00:00Z,90s,hi,null,true,1.5,2\""),
    ("formatDuration(90.5, 1440)", "value string \"1h 31m\""),
    ("formatDuration(-1441, 1440)", "value string \"-1d 1m\""),
    ("formatDuration(0.4, 60)", "value string \"0m\""),
    ("formatDuration(-0.4, 60)", "value string \"0m\""),
    ("formatDuration(1e300, 1)", "value string \"1e+300d\""),
    ("format(1234.5, ',.2f')", "value string \"1,234.50\""),
    ("format(-1.5, '.2f')", "value string \"-1.50\""),
    ("format(0.000123, '.2s')", "value string \"120µ\""),
    ("format(-0.0001, '.1f')", "value string \"0.0\""),
    ("format(42, 'x>8')", "value string \"xxxxxx42\""),
    ("format(255, '#x')", "value string \"0xff\""),
    ("format(1, '')", "value string \"1\""),
    ("range(0)", "value list()"),
    ("range(-3)", "value list()"),
    ("range(3)", "value list(int 0, int 1, int 2)"),
    ("enumerate(['a'])", "value list(record(index: int 0, value: string \"a\"))"),
    ("flatten([[1, [2]], 3, b'x'])", "value list(int 1, list(int 2), int 3, bytes 78)"),
    ("slice('abc', -2, 10)", "value string \"bc\""),
    ("slice([1, 2, 3], 2, 1)", "value list()"),
    ("slice(b'abc', -1, 3)", "value bytes 63"),
    ("bytesFromBase64(' YW Jj\\n')", "value bytes 616263"),
    ("bytesFromBase64('YQ=')", "value bytes 61"),
    ("bytesFromBase64('YQ==')", "value bytes 61"),
    ("bytesFromBase64('-_8')", "value bytes fbff"),
    ("bytesFromBase64('a=b')", "error invalid_argument [0, 22] bytesFromBase64: '=' is not a base64 character"),
    ("trimPrefix('abc', '')", "value string \"abc\""),
    ("trimSuffix('abc', '')", "value string \"abc\""),
    ("trimSuffix('abcbc', 'bc')", "value string \"abc\""),
    ("lower('İΣ')", "value string \"i̇ς\""),
    ("upper('ß')", "value string \"SS\""),
    ("trim('\\u00a0 x \\ufeff')", "value string \"x\""),
    ("regexReplace('a1b22', '(\\\\d)(\\\\d)?', '[$1|$2|$&|$$|$0|$3]')", "value string \"a[1||1|$|$0|$3]b[2|2|22|$|$0|$3]\""),
    ("regexReplace('😀😀', '', '-')", "value string \"-😀-😀-\""),
    ("regexGroups('ab', '(a)|(b)')", "value list(string \"a\", string \"\")"),
    ("regexExtractAll('a😀b', '')", "value list(string \"\", string \"\", string \"\", string \"\")"),
    ("regexReplace('ab', '(?P<n>a)', '$<n>$<m>')", "value string \"a$<m>b\""),
    ("min([3, '2', true])", "value bool true"),
    ("max(['a', 1])", "value string \"a\""),
    ("sum([1, '2', null, true])", "value double 4"),
    ("avg([])", "value null"),
    ("abs('-3')", "value double 3"),
    ("floor(' 2.5 ')", "value double 2"),
    ("ceil('0x10')", "value double 16"),
    ("abs([1])", "value double NaN"),
    ("default(null, 1)", "value int 1"),
    ("default(0, 1)", "value int 0"),
    ("coalesce([null, null])", "value null"),
    ("coalesce([null, 0])", "value int 0"),
    ("keys(parseJson('{\"b\": 1, \"1\": 2}'))", "value list(string \"1\", string \"b\")"),
    ("values({true: 1, 'a': 2})", "value list(int 1, int 2)"),
    ("uuidv5('example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')", "value string \"cfbff0d1-9375-5685-968c-48ce8b15ae17\""),
    ("uuidv3('', '6ba7b811-9dad-11d1-80b4-00c04fd430c8')", "value string \"14cdb9b4-de01-3faa-aff5-65bc2f771745\""),
    ("uuidValidate('NIL')", "value bool false"),
    ("uuidVersion('ffffffff-ffff-ffff-ffff-ffffffffffff')", "value int 15"),
    ("uuidValidate('6ba7b810-9dad-11d1-80b4-00c04fd430c8\\n')", "value bool false"),
    ("urlEncode('a b&c/😀')", "value string \"a%20b%26c%2F%F0%9F%98%80\""),
    ("urlDecode('%F0%9F%98%80%20')", "value string \"😀 \""),
    ("bytesToBase64(b'\\xff\\x00')", "value string \"/wA=\""),
    ("parseJson('{\"a\": [1, {\"b\": null}]}')", "value record(a: list(double 1, record(b: null)))"),
    ("parseJson('[1,')", "error invalid_conversion [0, 16] parseJson: invalid JSON at offset 3 (unexpected end of input)"),
    ("parseJson('[1 2]')", "error invalid_conversion [0, 18] parseJson: invalid JSON at offset 3"),
    ("dateIn(timestamp('0050-06-15T12:34:56.789Z'), 'Europe/Brussels')", "value string \"50-06-15\""),
    ("isoIn(timestamp('1850-06-01T12:00:00.5Z'), 'Europe/Brussels')", "value string \"1850-06-01T12:17:30.500+00:17\""),
    ("isoIn(timestamp('2026-03-29T01:30:00Z'), 'europe/brussels')", "value string \"2026-03-29T03:30:00.000+02:00\""),
    ("startOfMonth(timestamp('2026-09-06T04:00:00Z'), 'America/Santiago')", "value timestamp 2026-09-01T04:00:00Z"),
    ("addMonths(timestamp('2024-01-31T12:00:00Z'), 1)", "value timestamp 2024-02-29T12:00:00Z"),
    ("addMonths(timestamp('2024-03-31T12:00:00Z'), -13, 'Asia/Kolkata')", "value timestamp 2023-02-28T12:00:00Z"),
    ("addMonths(timestamp('9999-12-31T23:59:59Z'), 1)", "error invalid_conversion [0, 47] addMonths: the result is outside the range of a timestamp"),
    ("join([b'\\xff'], ',')", "error invalid_conversion [0, 20] join: the bytes are not UTF-8 text"),
    ("join([{'a': 1}], ',')", "error invalid_conversion [0, 21] join: a value of type map has no text"),
    ("join([optional.of(1)], ',')", "error invalid_conversion [0, 27] join: a value of type optional has no text"),
    ("join([int], ',')", "error invalid_conversion [0, 16] join: a value of type type has no text"),
    ("sort(['a', {'a': 1}])", "error invalid_conversion [0, 21] sort: a value of type map has no text"),
    ("round(9007199254740992)", "error invalid_argument [0, 23] round: integer 9007199254740992 exceeds 2^53-1 and cannot be formatted exactly as a double"),
    ("round(double('NaN'))", "error invalid_argument [0, 20] round: expected a finite number, got double"),
    ("format(1.0, '.2q')", "error invalid_argument [0, 18] format: unknown format type 'q' (one of efgrs%pbodxXcn)"),
    ("format(1.0, '.11f')", "error invalid_argument [0, 19] format: decimal places must be an integer 0-10, got 11"),
    ("format(1.0, '<<')", "value string \"1\""),
    ("fixed(1.0, 11)", "error invalid_argument [0, 14] fixed: decimal places must be an integer 0-10, got 11"),
    ("round(1.5, -1)", "error invalid_argument [0, 14] round: decimal places must be an integer 0-10, got -1"),
    ("formatDuration(10, 0)", "error invalid_argument [0, 21] formatDuration: minutesPerDay must be a positive number, got 0"),
    ("dateIn(timestamp('2024-01-01T00:00:00Z'), 'Nowhere/Zone')", "error invalid_argument [0, 57] dateIn: unknown IANA time zone \"Nowhere/Zone\""),
    ("nowIso('Z')", "error invalid_argument [0, 11] nowIso: unknown IANA time zone \"Z\""),
    ("today('x')", "error invalid_argument [0, 10] today: unknown IANA time zone \"x\""),
    ("regexExtract('a', 'a', 'q')", "error invalid_argument [0, 27] regexExtract: unknown regex flag 'q' (supported: i, m, s)"),
    ("regexExtract('a', '[')", "error invalid_regular_expression [0, 22] regexExtract: invalid RE2 pattern \"[\": missing closing ]"),
    ("bytesFromBase64('a')", "error invalid_argument [0, 20] bytesFromBase64: input length is not valid base64"),
    ("bytesFromBase64('a*bc')", "error invalid_argument [0, 23] bytesFromBase64: '*' is not a base64 character"),
    ("bytesFromBase64('😀a')", "error invalid_argument [0, 22] bytesFromBase64: '😀' is not a base64 character"),
];

#[test]
fn answers_each_row_as_node_does() {
    let environment = environment_with(handlers());
    let differences: Vec<String> = ROWS
        .iter()
        .filter_map(|(source, node)| {
            let rust = answered(&environment, source);
            (rust != *node).then(|| format!("{source}: {rust}, Node {node}"))
        })
        .collect();
    assert_eq!(differences, Vec::<String>::new());
}

/// An implementation called with values its signature does not take, which dispatch never
/// does: the catalog's own refusal, as Node's `catalogImplementation` answers it.
#[test]
fn refuses_a_value_its_signature_does_not_take_in_the_catalogs_words() {
    let ctx = CelCallContext { range: Some(SourceRange { start: 0, end: 1 }) };
    let call = |key: &str, args: &[CelValue]| {
        let value = catalog_implementation(key, &CelCatalogHandlers::default()).unwrap()(&ctx, args);
        match &value {
            CelValue::Error(error) => format!("error {} [0, 1] {}", error.code.as_str(), error.message),
            other => format!("value {}", written(other)),
        }
    };
    let rows: [(&str, Vec<CelValue>, &str); 11] = [
        ("join(list<dyn>, string)", vec![i(1), s("a")], "error invalid_argument [0, 1] join: expected a list, got int"),
        ("keys(map<dyn, dyn>)", vec![l(vec![i(1)])], "error invalid_argument [0, 1] keys: expected a map, got a list — use '+' to join lists"),
        ("values(map<dyn, dyn>)", vec![i(1)], "error invalid_argument [0, 1] values: expected a map, got int"),
        ("compact(map<dyn, dyn>)", vec![i(1)], "error invalid_argument [0, 1] compact: expected a map, got int"),
        ("merge(map<dyn, dyn>, map<dyn, dyn>)", vec![l(vec![i(1)]), l(vec![i(1)])], "error invalid_argument [0, 1] merge: expected a map, got a list — use '+' to join lists"),
        ("slice(bytes, int, int)", vec![i(1), i(0), i(1)], "error invalid_argument [0, 1] slice: expected a string, bytes or a list, got int"),
        ("dateIn(google.protobuf.Timestamp)", vec![i(1)], "error invalid_argument [0, 1] dateIn: expected a timestamp"),
        ("sum(list<dyn>)", vec![b(true)], "error invalid_argument [0, 1] sum: expected a list, got bool"),
        ("format(int, string)", vec![u(1152921504606846976), s(".2f")], "error invalid_argument [0, 1] format: integer 1152921504606846976 exceeds 2^53-1 and cannot be formatted exactly as a double"),
        ("round(double)", vec![s("abc")], "error invalid_argument [0, 1] round: expected a finite number, got string"),
        ("sort(list<dyn>)", vec![rec(vec![("a", i(1))])], "error invalid_argument [0, 1] sort: expected a list, got map"),
    ];
    for (key, args, node) in rows {
        assert_eq!(call(key, &args), node, "{key}");
    }
}

// --- sort: V8's TimSort, comparison for comparison --------------------------------------

/// The list of a seed, exactly as the recorder generated it: xorshift32 over the seed, a
/// length that reaches binary insertion alone, one merge and galloping, and five kinds of
/// element — numbers with NaN, long runs with NaN, numbers among text and null, text, and
/// text among numbers, bytes and durations.
fn sort_source(seed: u32) -> String {
    let mut x = seed.wrapping_mul(0x9e37_79b1) | 1;
    let mut next = || {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        x
    };
    let n = [5u32, 33, 64, 65, 130, 257, 600, 999][(seed % 8) as usize];
    let kind = seed % 5;
    let mut items = Vec::new();
    for at in 0..n {
        let r = next();
        items.push(match kind {
            0 if r % 9 == 0 => "double('NaN')".to_string(),
            0 => (r % 50).to_string(),
            1 if r % 31 == 0 => "double('NaN')".to_string(),
            1 => ((if (at / 40) % 2 == 0 { at } else { n - at }) + r % 4).to_string(),
            2 => match r % 8 {
                0 => "double('NaN')".into(),
                1 => "'x'".into(),
                2 => "null".into(),
                3 => "true".into(),
                4 => "'3'".into(),
                5 => "2.5".into(),
                6 => "7u".into(),
                _ => (r % 20).to_string(),
            },
            3 => format!("'{}{}'", char::from(b'a' + (r % 26) as u8), r % 7),
            _ => ["'b'", "1", "b'ab'", "duration('1s')", "'😀'", "'\\uffff'", "2.5", "null", "'A'"][(r % 9) as usize].into(),
        });
    }
    format!("sort([{}])", items.join(", "))
}

fn fnv(text: &str) -> u64 {
    text.bytes().fold(0xcbf2_9ce4_8422_2325, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x100_0000_01b3))
}

/// The FNV-1a 64 digest of Node's answer for each seed's list. A comparator that is not a
/// total order — NaN equal to everything, numbers beside text — makes the answer V8's
/// algorithm's own, so a step that diverges from V8's changes a digest.
const SORT_DIGESTS: [u64; 200] = [
    0x898a7abeaee2afd0, 0x5edb1c63c600b386, 0x9575129aee02eb2f, 0x2ad4058e7a4059c3, 0xa45cc7564402c22f, 0x823c6b721b4f5100,
    0x27b900f63621621b, 0x1bc446bb71080854, 0xebe298c243fa8d68, 0x7bdfb4ec2e8f43f8, 0x5e9ec4160547cbc9, 0x32284a0d65b9fa72,
    0x7ddcd6612028caeb, 0xa69aab84140945cf, 0x8370783ec99a9d4c, 0x520a2c370fdf961b, 0x00ac30df9d3cceb8, 0xc5bae21eebc09f59,
    0x6ea227fefa0b7c9c, 0x0b8fb4c391cd3067, 0xe4226dce2eb8b8e4, 0x836b6efc620751d3, 0xae685a294d40bd1b, 0xbaf1606c4e9de201,
    0x68743311c89e7258, 0x74297d246dfb298a, 0x4511973bb5ed1b6e, 0x866c362d07ed5236, 0x55620ac3dae5f4af, 0x6b89a3ea7a0ba6ac,
    0xd1a0f96549686fa3, 0xfe9cd0c1b49b2c8a, 0xdac1187d5e1436b2, 0xfa4be813c9757645, 0xa8c30df4a6652a8f, 0x48ce2459c740794b,
    0xde2e864f1b5f0a53, 0xb86a726e0ae05a0a, 0xa10995477d64760c, 0x202171f26a261468, 0xccb52655587db6f4, 0x83d0b65265b186d8,
    0x81325db873552dd5, 0x1190d37e766b54f6, 0xbd1a9b78b84b4823, 0xd471b81a871c77db, 0xa69c471ea94e3c28, 0x2dc6e781eefbd150,
    0x1d725a29d3dd9b3c, 0x750a7ce38d8dc2f7, 0xfcc48b35a21d3d08, 0x0946b7641010ebc0, 0x024e1198e62801f8, 0x9689fdc14a2b7175,
    0xfbd89cc10b351de9, 0x44555d38ed43b7f5, 0xe3f4a38258301977, 0x90dc16b56eaf2781, 0xfe2df4d9e1822bed, 0xebb8b5cacbd4e26a,
    0x0e697f2b2eedae29, 0xdb22c042ba54c4e9, 0x4020cba71effecfd, 0x43edb1bbc46e4e37, 0xc93ecfd49a05578c, 0x7bfd467e3fb277b4,
    0xd5e033b3c479c8fc, 0x3ceb5f3784fcee17, 0x0e1ff5dddab4db9a, 0x8316486bcaf1afd3, 0x13aad11621344ba6, 0x162cbf03acba8fd3,
    0x514e74e3b6fcf144, 0x4472c61c627ef5ca, 0xba9b79c67ad8904d, 0xb441afe38ff8bf2c, 0xc1079f66a29df7d6, 0x9a80da7557d4917f,
    0xfad83fb355f8f5bb, 0x7ed938d2746055cd, 0xc8f12ea9d28f2b3e, 0x67d7fc7bb3f741c0, 0xe927fd91bdbfa74f, 0x5a51154131b92308,
    0x30d7164346895c3c, 0xf37cebf0b3143273, 0xe25e297abecfbf08, 0x9270e8d6fb0be2cb, 0x4d92a41af6b8c4d0, 0xe1798669c0c4e4cc,
    0xac7fbb1e96455420, 0x926876167c224584, 0x66464bbff31e08d0, 0x06690e1ac69f0aaa, 0x29b1f7faffb411c7, 0xe916f490807e00e9,
    0xd522866b59031316, 0x5f7baaabf4b00e5a, 0xdd620c1bab40897a, 0xa08667dd0ec4c208, 0x30704689f701c2b9, 0xe90ebe002f960b94,
    0x95b73791923fef96, 0xd6d343454ade3aee, 0xeb4622dbffeff0b0, 0x86658ae01d03cd14, 0x9ab99a9cf4546f1a, 0xdf6eb207907d7f4e,
    0xb2fbf70cbdbdea0b, 0xdf95e72cd090e7c2, 0x091768632aa3714b, 0xab16561d067e68aa, 0xe11b94cd050a1ec0, 0x4b5af3d03b247e35,
    0x0f8695cdbbdd976b, 0x1c032b33f90ccd1b, 0x3b0784d3b7e466bf, 0x7e0147dc62fc1401, 0x43e3fbadedc908e6, 0xce1d20902fbc308c,
    0x2c6496b4987ce6ce, 0x0666c4c464fd58c3, 0xa0f42554be6a7411, 0xa56680dafe14b254, 0xb1e39e0c0197fa57, 0xf8d80da6bebf0e59,
    0x4c69882dc8c55609, 0xe2d3a41299b092dd, 0x73d5be65462782a6, 0x81c95370b954f5dc, 0xc12c5e61936a50fc, 0xe42a38c6a5c8bb7f,
    0x3eaa2bd825ac7883, 0xcc0e27bb20f26b75, 0x9cae402cc2807322, 0x7d3821ed0e412f75, 0xeba89989d97fb5c0, 0xa6b9f03f59bbc833,
    0x5cca958f92fa29c5, 0x1b3c185fd5669d6b, 0x521cbae5fdfff90e, 0xf15516102017cd9c, 0x106e94194fb4a1bd, 0xdc3c4f8bdc365643,
    0x39a0abe4e0fc76eb, 0x09efcdc1910c0628, 0x36f8c24d5361b5bf, 0x637efc34e5ae94eb, 0x736c89c780e8ea91, 0xaf608db0b7b3d44d,
    0x4dc28096357c74b0, 0x9979dcb299a10001, 0x0c9f1bab5af78071, 0x734a3d78c47f3b98, 0x6f940aa7f3c622db, 0x4afa70d107a254ed,
    0x2866953a89d0d437, 0x0afda746ef62b76e, 0x58f63b33552b7951, 0x30ae0b8abb06b425, 0x21ccc0f985ceef68, 0xb851be38941b0793,
    0x998610087ab52914, 0x64dc0c2b592a1876, 0x205da9588066c6be, 0xcbf4ac66657c2c72, 0x25bf481fd61e4e18, 0xa690428ef65582bb,
    0x87ad9e638c59d675, 0x6ce615df83360a9d, 0x215c5f75dbc7a3db, 0x280be425d970fd15, 0xd481f0060c3ac1b5, 0x4773f205b5be3d2f,
    0x68074c72c0afd7f1, 0x72108e6a919d617a, 0x7ecfc970a7b01cd7, 0x601c375ba258a783, 0x31b28bf7dbe71ce7, 0xf18c0ef6a89a18fb,
    0xfe996a97280113d8, 0xf693c5336bfa49d1, 0x8141b48a7cb6d528, 0xc25692321aef6c4e, 0x4d434b1b82343fbe, 0x07175eb1c850e36d,
    0x7620a4f82bb756e7, 0xffd732dc2288cc37, 0x720d2363591295dc, 0x9d4f1b8f1bbdde9e, 0xb5d8f877e07cd34a, 0x6f522782f0c51f24,
    0x80d03bad3f6779dd, 0x8d211f40cb81f9c4, 0x09145361e43e354c, 0xb95d137a9791d974, 0xb1eacd461bf6a48a, 0xfa12ece47129ae6e,
    0x8c60db9313b365f4, 0x56f81976624a0d4f,
];

/// The list of an error seed, 200 to 299, exactly as the recorder generated it: a third of
/// its elements have no text, under four refusals — a map, bytes that are not UTF-8, an
/// optional and a type — so which one a list answers is decided by which element V8's
/// comparisons reach first, and by which of a comparison's two texts is computed first.
fn error_sort_source(seed: u32) -> String {
    let mut x = seed.wrapping_mul(0x9e37_79b1) | 1;
    let mut next = || {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        x
    };
    let n = [2u32, 3, 5, 33, 64, 65, 130, 257][(seed % 8) as usize];
    let pool = ["{'k': 1}", "b'\\xff'", "optional.of(1)", "int", "'b'", "'a'", "'😀'", "1", "null", "true", "2.5", "'c1'"];
    let items: Vec<&str> = (0..n)
        .map(|at| match pool[(next() % pool.len() as u32) as usize] {
            "1" | "2.5" if at == 0 => "'z'",
            picked => picked,
        })
        .collect();
    format!("sort([{}])", items.join(", "))
}

/// Node's answers for seeds 200 to 299, 87 of them a refusal.
const ERROR_SORT_DIGESTS: [u64; 100] = [
    0x730c8cd971d2591b, 0x603847fae0fafbba, 0x77879d33a54718df, 0x1fa1fb045b47d34c, 0x24becb6a3060ab6e, 0x782d4ba2218129e1,
    0xd5c4de7bed6d5993, 0x6b5072e24786576e, 0xdd45562b9a8c9b91, 0x8c11f53a9c820670, 0xa106ef173539e0d1, 0xe1d0bfd90091cf1b,
    0x9cdd88f259ad8f00, 0x6a3c6f2313203fa6, 0x2199dbe724db92d1, 0x71cabed7e0b07322, 0x7fb6699582a532b7, 0x094b103ca02979b5,
    0xf73c4dfd465d957d, 0xdd450d76e2f7466b, 0xb1c1aaa7145b06de, 0x1cc9ca08c50fb622, 0xb9b459811e035355, 0x79307e8af416d3ef,
    0xc2f11165ad657864, 0xb8359dca404d267d, 0xb9155cae88945298, 0xa8f69f809b5077c1, 0xa68963ba54761fc7, 0xe202040dfdffc37a,
    0x9777349ace73f0fc, 0xb0f86c036765ca5b, 0x26c56c7ac7eda9c0, 0xf88fed550f0ada81, 0x66a18693299bffdb, 0x675b7cd412059883,
    0x71b874c23fda0213, 0xe9417ee9afc861ea, 0xb6029c93bdaed4b7, 0x5d629c39b089e2cd, 0x4da425b138b8633a, 0x6ee1d0cc80df4fa0,
    0x5b8f5692da5e196d, 0xeb44ef93b5e2054d, 0x1be7ccd99cffcb79, 0xd0926a5427024ac7, 0xfa5db63c13f05788, 0x3c2cb2af457dc386,
    0x7c3a2765cc6cc3e9, 0xb77de600368404a2, 0xf186e1ced9d459ac, 0x021bae69ce457f5e, 0xdf68b0724a6e6128, 0xa24e85293adb0d1e,
    0x642421ac1b050d07, 0xa1be739e329ff9b7, 0x71034af668d9a89a, 0xe9a981a4db368cf2, 0x389c333155b55c56, 0x591e572aa780a0dc,
    0xf25e3111cdeb0135, 0x50f6d36d15ed31ec, 0x931ac8359781164d, 0xc6bed93207cf74b4, 0xecb2eba772623a9c, 0xfdf7e8df15eb0ea3,
    0x97470c3afb2852d6, 0x620e042a3835dd3a, 0x1ecff39371ef422a, 0xe66529ad37ef7702, 0x658bf88822141c5b, 0x55642d8bb36676ee,
    0x54e0c476aac3a35b, 0x2034900798db3e84, 0x9f1a3278b70171c4, 0x1c6a6cc59a0470a9, 0x0095aea02dfb0cbf, 0xe58c5ad1222ec4ac,
    0x159a9668ed470f39, 0x0b0181eff0138b24, 0x83de61e43b4a6ae7, 0x839b760300cffb48, 0x5b8f5692da5e196d, 0x7dbc43d7ff768146,
    0xa7b97f75409df50f, 0x72470b60492ddac4, 0x3f49e81a19ada063, 0xbfe91bb0624d35e9, 0xecb2eba772623a9c, 0x62557b60d577f1c7,
    0xcb8e4dff25e7fab2, 0x572be404b57d8eb9, 0xd55b87f95fb7771b, 0x0095aea02dfb0cbf, 0x088d4288dc0ae49b, 0x6b8459370c0e043e,
    0xc2bb6666810ee6cd, 0xb8359dca404d267d, 0x1e8e02b57b6f8d80, 0x531277bb53976e59,
];

#[test]
fn sorts_as_v8s_timsort_does_where_the_comparator_is_not_an_order() {
    let environment = environment_with(handlers());
    let differing: Vec<u32> =
        (0..200).filter(|seed| fnv(&answered(&environment, &sort_source(*seed))) != SORT_DIGESTS[*seed as usize]).collect();
    assert_eq!(differing, Vec::<u32>::new());
}

/// The refusal a list answers is the first one V8's comparisons meet, the left operand's
/// text computed before the right's.
#[test]
fn refuses_a_list_at_the_element_v8s_comparisons_reach_first() {
    let environment = environment_with(handlers());
    for (source, node) in [
        ("sort([{'a': 1}, b'\\xff'])", "error invalid_conversion [0, 25] sort: the bytes are not UTF-8 text"),
        ("sort([b'\\xff', {'a': 1}])", "error invalid_conversion [0, 25] sort: a value of type map has no text"),
        ("sort(['a', {'a': 1}, b'\\xff'])", "error invalid_conversion [0, 30] sort: a value of type map has no text"),
    ] {
        assert_eq!(answered(&environment, source), node, "{source}");
    }
    let differing: Vec<u32> = (200..300)
        .filter(|seed| fnv(&answered(&environment, &error_sort_source(*seed))) != ERROR_SORT_DIGESTS[(*seed - 200) as usize])
        .collect();
    assert_eq!(differing, Vec::<u32>::new());
}

// --- the host's nine ----------------------------------------------------------------------

#[test]
fn answers_a_host_call_with_no_handler_by_naming_the_function() {
    let environment = environment_with(CelCatalogHandlers::default());
    for (source, node) in [
        ("sha256('abc')", "error unbound_function [0, 13] sha256() is supplied by the host, and this environment was given no implementation for it"),
        ("md5('a')", "error unbound_function [0, 8] md5() is supplied by the host, and this environment was given no implementation for it"),
        ("sha1('a')", "error unbound_function [0, 9] sha1() is supplied by the host, and this environment was given no implementation for it"),
        ("sha512('a')", "error unbound_function [0, 11] sha512() is supplied by the host, and this environment was given no implementation for it"),
        ("hmac('a','b','c')", "error unbound_function [0, 17] hmac() is supplied by the host, and this environment was given no implementation for it"),
        ("base64Encode('a')", "error unbound_function [0, 17] base64Encode() is supplied by the host, and this environment was given no implementation for it"),
        ("base64Decode('a')", "error unbound_function [0, 17] base64Decode() is supplied by the host, and this environment was given no implementation for it"),
        ("json(1)", "error unbound_function [0, 7] json() is supplied by the host, and this environment was given no implementation for it"),
        ("'a'.joinPath('b')", "error unbound_function [0, 17] joinPath() is supplied by the host, and this environment was given no implementation for it"),
    ] {
        assert_eq!(answered(&environment, source), node, "{source}");
    }
}

#[test]
fn answers_a_host_call_with_what_its_handler_answers() {
    let environment = environment_with(handlers());
    assert_eq!(answered(&environment, "sha256('abc') + md5('a')"), "value string \"sha256:abcmd5:a\"");
    assert_eq!(answered(&environment, "'/a'.joinPath('b')"), "value string \"/a/b\"");
    // The handler is handed the value itself, whatever its type.
    let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
    let held = Arc::clone(&seen);
    let json = CelCatalogHandlers {
        json: Some(Arc::new(move |value: &CelValue| {
            held.lock().unwrap().push(value.clone());
            Ok("{}".into())
        })),
        ..Default::default()
    };
    assert_eq!(answered(&environment_with(json), "json({'a': [1u]})"), "value string \"{}\"");
    assert_eq!(seen.lock().unwrap().len(), 1);
}

/// Pinned difference (Q4): a handler's refusal is the call's error value, of the
/// refusal's own code, ranged over the call, its message as the handler wrote it — where
/// Node lets anything but its private refusal class propagate out of evaluation.
#[test]
fn difference_answers_a_refusing_handler_as_an_error_value_of_its_own_code() {
    let refusing = CelCatalogHandlers {
        hmac: Some(Arc::new(|algorithm, _, _| Err(CatalogRefusal::new(format!("hmac: unknown algorithm {algorithm:?}"))))),
        join_path: Some(Arc::new(|_, relative| {
            Err(CatalogRefusal { message: format!("joinPath: {relative:?} leaves the base"), code: CelEvaluationCode::InvalidConversion })
        })),
        ..Default::default()
    };
    let environment = environment_with(refusing);
    assert_eq!(
        answered(&environment, "1 + size(hmac('md4', 'k', 'm'))"),
        "error invalid_argument [9, 30] hmac: unknown algorithm \"md4\""
    );
    assert_eq!(
        answered(&environment, "'/a'.joinPath('../b')"),
        "error invalid_conversion [0, 21] joinPath: \"../b\" leaves the base"
    );
    // An error value short-circuits as any other.
    assert_eq!(answered(&environment, "true || hmac('md4', 'k', 'm') == ''"), "value bool true");
}

// --- the interim readings: an error value where Node throws or splits a pair -------------

/// Each `(source, Node's recorded answer, this crate's)`.
fn difference(rows: &[(&str, &str, &str)]) {
    let environment = environment_with(handlers());
    for (source, node, rust) in rows {
        assert_ne!(node, rust, "{source}");
        assert_eq!(answered(&environment, source), *rust, "{source}");
    }
}

#[test]
fn interim_range_refuses_a_count_past_the_longest_array() {
    difference(&[(
        "range(4294967296)",
        "threw RangeError: Invalid array length",
        "error invalid_argument [0, 17] range: count must be at most 4294967295, got 4294967296",
    )]);
}

/// Node, asked for this list, exhausts its heap and aborts the process (observed on the
/// recording Node), so no answer of its is recorded here. The refusal is the allocator's:
/// a host that overcommits memory grants the reservation and the process is killed building
/// the list, so the test runs itself again under an address-space limit of 1 GiB, which
/// Linux enforces. The child fails, and with it this test, wherever the limit is not
/// enforced or the list is built.
#[cfg(target_os = "linux")]
#[test]
fn interim_range_refuses_a_list_the_process_cannot_allocate() {
    const LIMITED: &str = "TELORUN_CEL_TEST_ADDRESS_SPACE_LIMITED";
    if std::env::var_os(LIMITED).is_some() {
        let environment = environment_with(handlers());
        assert_eq!(
            answered(&environment, "range(4294967295)"),
            "error invalid_argument [0, 17] range: a list of 4294967295 elements is more than this process can allocate"
        );
        assert_eq!(
            answered(&environment, "range(100000000)"),
            "error invalid_argument [0, 16] range: a list of 100000000 elements is more than this process can allocate"
        );
        return;
    }
    let status = std::process::Command::new("sh")
        .args(["-c", "ulimit -v 1048576 && exec \"$0\" \"$@\""])
        .arg(std::env::current_exe().unwrap())
        .args(["--exact", "interim_range_refuses_a_list_the_process_cannot_allocate", "--test-threads", "1"])
        .env(LIMITED, "1")
        .status()
        .unwrap();
    assert!(status.success(), "the test under an address-space limit failed: {status}");
}

#[test]
fn interim_format_refuses_a_width_past_the_longest_string() {
    difference(&[(
        "format(1, '>600000000')",
        "threw RangeError: Invalid string length",
        "error invalid_argument [0, 23] format: width 600000000 exceeds the longest text a string can hold (536870888 UTF-16 code units)",
    )]);
}

#[test]
fn interim_url_decode_names_a_percent_not_followed_by_two_hexadecimal_digits() {
    difference(&[(
        "urlDecode('%zz')",
        "threw URIError: URI malformed",
        "error invalid_argument [0, 16] urlDecode: '%' at offset 0 is not followed by two hexadecimal digits",
    )]);
}

#[test]
fn interim_url_decode_names_the_first_byte_of_a_sequence_that_is_not_utf8() {
    difference(&[
        (
            "urlDecode('%C0%80')",
            "threw URIError: URI malformed",
            "error invalid_argument [0, 19] urlDecode: the bytes percent-encoded at offset 0 are not valid UTF-8",
        ),
        (
            "urlDecode('%E2%82')",
            "threw URIError: URI malformed",
            "error invalid_argument [0, 19] urlDecode: the bytes percent-encoded at offset 0 are not valid UTF-8",
        ),
    ]);
}

#[test]
fn interim_uuid_names_a_namespace_that_is_not_a_uuid() {
    difference(&[
        ("uuidv3('a', 'zz')", "threw TypeError: Invalid UUID", "error invalid_argument [0, 17] uuidv3: invalid namespace UUID \"zz\""),
        ("uuidv5('a', 'nil ')", "threw TypeError: Invalid UUID", "error invalid_argument [0, 19] uuidv5: invalid namespace UUID \"nil \""),
        ("uuidv5('a😀b', 'YW Jj\\n')", "threw TypeError: Invalid UUID", "error invalid_argument [0, 25] uuidv5: invalid namespace UUID \"YW Jj\\n\""),
    ]);
}

#[test]
fn interim_uuid_version_names_a_text_that_is_not_a_uuid() {
    difference(&[
        ("uuidVersion('nope')", "threw TypeError: Invalid UUID", "error invalid_argument [0, 19] uuidVersion: invalid UUID \"nope\""),
        ("uuidVersion('max')", "threw TypeError: Invalid UUID", "error invalid_argument [0, 18] uuidVersion: invalid UUID \"max\""),
        ("uuidVersion('YW Jj\\n')", "threw TypeError: Invalid UUID", "error invalid_argument [0, 22] uuidVersion: invalid UUID \"YW Jj\\n\""),
    ]);
}

#[test]
fn interim_parse_json_refuses_an_unpaired_surrogate_at_its_escape() {
    difference(&[(
        "parseJson('\"\\\\ud800\"')",
        "value string \"\\ud800\"",
        "error invalid_argument [0, 22] parseJson: unpaired surrogate at offset 1",
    )]);
}

#[test]
fn interim_slice_split_and_replace_refuse_a_cut_inside_a_surrogate_pair() {
    difference(&[
        ("slice('a😀b', 0, 2)", "value string \"a\\ud83d\"", "error invalid_argument [0, 19] slice: offset 2 is inside a surrogate pair"),
        (
            "split('a😀b', '')",
            "value list(string \"a\", string \"\\ud83d\", string \"\\ude00\", string \"b\")",
            "error invalid_argument [0, 17] split: offset 2 is inside a surrogate pair",
        ),
        (
            "replace('a😀b', '', '-')",
            "value string \"a-\\ud83d-\\ude00-b\"",
            "error invalid_argument [0, 24] replace: offset 2 is inside a surrogate pair",
        ),
    ]);
}

#[test]
fn interim_merge_refuses_a_uint_key_into_a_record() {
    difference(&[(
        "merge(parseJson('{\"a\": 1}'), {1u: 2})",
        "value record(a: double 1, [object Object]: int 2)",
        "error invalid_argument [0, 37] merge: a key of type uint cannot be held by a map with string keys",
    )]);
}

#[test]
fn difference_a_calendar_result_outside_the_time_range_is_the_settled_refusal() {
    difference(&[(
        "addMonths(timestamp('2024-01-01T00:00:00Z'), 9000000000000000)",
        "threw RangeError: Invalid time value",
        "error invalid_conversion [0, 62] addMonths: the result is outside the range of a timestamp",
    )]);
}
