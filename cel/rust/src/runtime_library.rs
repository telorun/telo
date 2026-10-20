//! What every operator and standard function **does** — `runtime-library.ts`.
//!
//! The declarations are data (the standard library's signature data); this is the
//! behaviour behind them, keyed by the same dispatch key the registry resolves on, so
//! there is exactly one answer per operation. 119 implementations are keyed by
//! dispatch key, and seven — equality, ordering and `type` — by name, over every type
//! pair the library declares and every one a host adds.
//!
//! An implementation takes its arguments **already evaluated and already free of
//! errors** — the caller carries an error-valued operand through for the short-circuit
//! rules — and returns a value, which may itself be an error value.
//!
//! Where this file answers otherwise than Node, each a reading the crate's README lists:
//! - `bool(string)` reads its ten words and nothing else; Node looks the text up on a
//!   plain object, so `bool('constructor')` answers a JavaScript function there.
//! - `join` takes a list of strings; Node's coerces any element to text.
//! - `substring` and `split` refuse a result holding half a surrogate pair, which no
//!   Rust string holds; Node answers the half character.
//! - `bytes.json()` words its refusal by the engine's JSON scan, where Node quotes
//!   V8's `JSON.parse`, and refuses an escape naming an unpaired surrogate.
//! - `lowerAscii` / `upperAscii` case with the engine's Unicode 17.0 data, and a getter
//!   takes the zones of the engine's own database (`value_text.rs`, `timestamp_value.rs`).
//!
//! An implementation called directly with values its signature does not take answers
//! `no_matching_overload`, as a call that resolves to nothing does; through dispatch it
//! never is.

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, LazyLock};

use telorun_cel_value::{
    cel_duration_from_nanos, cel_error, cel_none, cel_some, cel_type_name_of, cel_type_value, duration_field,
    duration_nanos, duration_out_of_range, format_duration, parse_duration, CelDuration, CelError, CelEvaluationCode,
    CelList, CelOptional, CelRecord, CelTimestamp, CelTypeValue, CelValue, DurationField, PropertyMap, SourceRange,
};

use crate::integer_arithmetic::{
    decimal_result, int_divide, int_modulo, int_result, uint_divide, uint_modulo, uint_product, uint_result,
};
use crate::json_text_scan::{read_json_text, JsonTextError};
use crate::json_value::JsonValue;
use crate::member_read::{cel_lookup, cel_terms, Lookup};
use crate::regular_expression::cel_matches;
use crate::signature::{signature_key, CelSignature};
use crate::standard_library::google_type_names;
use crate::timestamp_value::{
    cel_timestamp, format_timestamp, parse_timestamp, timestamp_field, timestamp_nanos, TimestampField,
};
use crate::value_equality::{cel_compare, cel_equal};
use crate::value_text::{
    bytes_to_text, double_text, es_string_to_number, es_to_lower_case, es_to_upper_case, es_trim, json_quote,
    text_to_bytes,
};

/// What an implementation knows about the call it is answering.
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct CelCallContext {
    /// The span of the call, carried into any error value it produces.
    pub range: Option<SourceRange>,
}

/// What an implementation IS: its call context, then its arguments — the receiver of a
/// call written on a value first — as a slice as long as the call's arity, at most
/// [`CALL_SITE_DIRECT_ARITY`]. Shared and thread-safe; it serves a registered function
/// and a namespaced one alike.
pub type CelImplementation = Arc<dyn Fn(&CelCallContext, &[CelValue]) -> CelValue + Send + Sync>;

/// How many values an implementation receives — its arguments, and the receiver of a
/// call written on a value. A signature declaring more is refused where it is registered.
pub const CALL_SITE_DIRECT_ARITY: usize = 4;

type Implementation = fn(&CelCallContext, &[CelValue]) -> CelValue;

// --- reading arguments the dispatcher has already typed ---------------------

fn text(value: &CelValue) -> Option<&str> {
    match value {
        CelValue::String(held) => Some(held),
        _ => None,
    }
}

fn integer(value: &CelValue) -> Option<i64> {
    match value {
        CelValue::Int(held) => Some(*held),
        _ => None,
    }
}

fn unsigned(value: &CelValue) -> Option<u64> {
    match value {
        CelValue::Uint(held) => Some(*held),
        _ => None,
    }
}

fn double(value: &CelValue) -> Option<f64> {
    match value {
        CelValue::Double(held) => Some(*held),
        _ => None,
    }
}

fn boolean(value: &CelValue) -> Option<bool> {
    match value {
        CelValue::Bool(held) => Some(*held),
        _ => None,
    }
}

fn bytes(value: &CelValue) -> Option<&[u8]> {
    match value {
        CelValue::Bytes(held) => Some(held),
        _ => None,
    }
}

fn list(value: &CelValue) -> Option<&CelList> {
    match value {
        CelValue::List(held) => Some(held),
        _ => None,
    }
}

fn map(value: &CelValue) -> Option<&CelValue> {
    matches!(value, CelValue::Map(_) | CelValue::Record(_)).then_some(value)
}

fn instant(value: &CelValue) -> Option<CelTimestamp> {
    match value {
        CelValue::Timestamp(held) => Some(*held),
        _ => None,
    }
}

fn span(value: &CelValue) -> Option<CelDuration> {
    match value {
        CelValue::Duration(held) => Some(*held),
        _ => None,
    }
}

fn optional(value: &CelValue) -> Option<&CelOptional> {
    match value {
        CelValue::Optional(held) => Some(held),
        _ => None,
    }
}

/// The argument itself, where what is read of it is that the dispatcher resolved on it.
fn any(value: &CelValue) -> Option<&CelValue> {
    Some(value)
}

/// The refusal of values the implementation's signature does not take.
fn mismatch(ctx: &CelCallContext, name: &str, args: &[CelValue]) -> CelValue {
    let names: Option<Vec<&str>> = args.iter().map(cel_type_name_of).collect();
    let message = match names {
        Some(names) => format!("no overload of {} takes ({})", json_quote(name), names.join(", ")),
        None => format!("{name} was handed a value of no CEL type"),
    };
    cel_error(CelEvaluationCode::NoMatchingOverload, message, ctx.range).into()
}

/// Reads each argument with its reader, or answers the mismatch.
macro_rules! read {
    ($ctx:ident, $args:ident, $name:literal; $($var:ident: $reader:ident),+) => {
        if $args.len() != [$(stringify!($var)),+].len() {
            return mismatch($ctx, $name, $args);
        }
        let mut values = $args.iter();
        $(
            let Some($var) = values.next().and_then($reader) else {
                return mismatch($ctx, $name, $args);
            };
        )+
    };
}

/// An error a value-domain function answered with no range, about the call.
fn ranged(ctx: &CelCallContext, error: CelError) -> CelValue {
    match ctx.range {
        Some(range) => error.with_range(range),
        None => error,
    }
    .into()
}

fn answer<T>(ctx: &CelCallContext, result: Result<T, CelError>, value: impl FnOnce(T) -> CelValue) -> CelValue {
    match result {
        Ok(held) => value(held),
        Err(error) => ranged(ctx, error),
    }
}

// --- conversions -----------------------------------------------------------

/// The doubles at which an int64 ends in each direction: 2^63 and -2^63.
const INT_RANGE_ABOVE: f64 = 9223372036854775808.0;
const INT_RANGE_BELOW: f64 = -9223372036854775808.0;
/// 2^64, the first double past the uint64 range.
const UINT_RANGE_ABOVE: f64 = 18446744073709551616.0;

fn conversion_error(ctx: &CelCallContext, what: &str, value: &str) -> CelValue {
    cel_error(CelEvaluationCode::InvalidConversion, format!("{what} cannot convert {value}"), ctx.range).into()
}

/// `int(double)`. A double **at or beyond either int64 extreme** is refused, which is
/// cel-spec's rule and the only one under which the two ends behave alike.
fn int_from_double(ctx: &CelCallContext, value: f64) -> CelValue {
    if !value.is_finite() {
        return conversion_error(ctx, "int()", &double_text(value));
    }
    if value >= INT_RANGE_ABOVE || value <= INT_RANGE_BELOW {
        return cel_error(CelEvaluationCode::NumericOverflow, format!("integer overflow: {}", double_text(value)), ctx.range)
            .into();
    }
    CelValue::Int(value.trunc() as i64)
}

fn uint_from_double(ctx: &CelCallContext, value: f64) -> CelValue {
    if !value.is_finite() {
        return conversion_error(ctx, "uint()", &double_text(value));
    }
    let whole = value.trunc();
    if whole < 0.0 || whole >= UINT_RANGE_ABOVE {
        // A whole double written in full, as a `bigint` of it prints.
        return cel_error(CelEvaluationCode::NumericOverflow, format!("unsigned integer overflow: {whole:.0}"), ctx.range)
            .into();
    }
    CelValue::Uint(whole as u64)
}

fn digits(text: &str) -> &str {
    &text[text.bytes().position(|byte| !byte.is_ascii_digit()).unwrap_or(text.len())..]
}

/// `[+-]?\d+`, or with `signed` false `\+?\d+`.
fn is_decimal(text: &str, signed: bool) -> bool {
    let body = match text.as_bytes().first() {
        Some(b'+') => &text[1..],
        Some(b'-') if signed => &text[1..],
        _ => text,
    };
    !body.is_empty() && digits(body).is_empty()
}

/// `[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?`, the decimal a double is read from.
fn is_decimal_double(text: &str) -> bool {
    let body = text.strip_prefix(['+', '-']).unwrap_or(text);
    let after_whole = digits(body);
    let whole = body.len() - after_whole.len();
    let after_point = match after_whole.strip_prefix('.') {
        Some(fraction) => {
            let rest = digits(fraction);
            if whole == 0 && rest.len() == fraction.len() {
                return false;
            }
            rest
        }
        None if whole == 0 => return false,
        None => after_whole,
    };
    match after_point.strip_prefix(['e', 'E']) {
        None => after_point.is_empty(),
        Some(exponent) => {
            let exponent = exponent.strip_prefix(['+', '-']).unwrap_or(exponent);
            !exponent.is_empty() && digits(exponent).is_empty()
        }
    }
}

fn double_from_text(ctx: &CelCallContext, value: &str) -> CelValue {
    match value {
        "Inf" | "+Inf" | "Infinity" | "+Infinity" => CelValue::Double(f64::INFINITY),
        "-Inf" | "-Infinity" => CelValue::Double(f64::NEG_INFINITY),
        "NaN" => CelValue::Double(f64::NAN),
        _ if is_decimal_double(value) => CelValue::Double(es_string_to_number(value)),
        _ => conversion_error(ctx, "double()", &json_quote(value)),
    }
}

const BOOL_WORDS: [(&str, bool); 10] = [
    ("1", true),
    ("t", true),
    ("true", true),
    ("TRUE", true),
    ("True", true),
    ("0", false),
    ("f", false),
    ("false", false),
    ("FALSE", false),
    ("False", false),
];

/// The name a type value carries. A null's type and an optional's are named apart.
pub fn type_value_name(type_name: &str) -> &str {
    match type_name {
        "optional" => "optional_type",
        other => other,
    }
}

/// The type value of any value — `type()` must answer for anything, including `dyn`.
pub fn cel_type_value_of(value: &CelValue, range: Option<SourceRange>) -> Result<CelTypeValue, CelError> {
    match cel_type_name_of(value) {
        Some(name) => Ok(cel_type_value(type_value_name(name))),
        None => Err(cel_error(CelEvaluationCode::InvalidConversion, "this value is of no CEL type", range)),
    }
}

// --- text and bytes --------------------------------------------------------

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Bytes as base64 with the standard alphabet and padding.
pub fn base64_text(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let a = chunk[0];
        let b = chunk.get(1).copied();
        let c = chunk.get(2).copied();
        out.push(char::from(BASE64[usize::from(a >> 2)]));
        out.push(char::from(BASE64[usize::from(((a & 3) << 4) | (b.unwrap_or(0) >> 4))]));
        out.push(b.map_or('=', |b| char::from(BASE64[usize::from(((b & 15) << 2) | (c.unwrap_or(0) >> 6))])));
        out.push(c.map_or('=', |c| char::from(BASE64[usize::from(c & 63)])));
    }
    out
}

fn hex_text(input: &[u8]) -> String {
    input.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// JSON as CEL values: an object is a record, in its own-property order, an array a
/// list, a number a double. The catalog's `parseJson` answers the same question, so the
/// two readings of what JSON becomes are one. Built on a heap list, at any depth.
pub fn json_as_cel_value(parsed: &JsonValue) -> CelValue {
    enum Task<'a> {
        Visit(&'a JsonValue),
        List(usize),
        Record(Vec<&'a str>),
    }
    let mut tasks = vec![Task::Visit(parsed)];
    let mut built: Vec<CelValue> = Vec::new();
    while let Some(task) = tasks.pop() {
        match task {
            Task::Visit(node) => match node {
                JsonValue::Null => built.push(CelValue::Null),
                JsonValue::Bool(held) => built.push(CelValue::Bool(*held)),
                JsonValue::Number(held) => built.push(CelValue::Double(*held)),
                JsonValue::String(held) => built.push(CelValue::String(held.as_str().into())),
                JsonValue::Array(items) => {
                    tasks.push(Task::List(items.len()));
                    tasks.extend(items.iter().rev().map(|item| Task::Visit(item)));
                }
                JsonValue::Object(entries) => {
                    let pairs: Vec<(&str, &JsonValue)> = entries.iter().map(|(key, value)| (key, &**value)).collect();
                    tasks.push(Task::Record(pairs.iter().map(|(key, _)| *key).collect()));
                    tasks.extend(pairs.into_iter().rev().map(|(_, value)| Task::Visit(value)));
                }
            },
            Task::List(count) => {
                let items = built.split_off(built.len() - count);
                built.push(CelValue::List(items.into()));
            }
            Task::Record(keys) => {
                let values = built.split_off(built.len() - keys.len());
                built.push(CelValue::Record(keys.into_iter().zip(values).collect::<CelRecord>()));
            }
        }
    }
    built.pop().expect("a JSON value is built")
}

/// A JSON text in bytes, as a value, or why it is none.
fn bytes_json(ctx: &CelCallContext, input: &[u8]) -> CelValue {
    let decoded = match bytes_to_text(input) {
        Ok(decoded) => decoded,
        Err(error) => return ranged(ctx, error),
    };
    match read_json_text(&decoded) {
        Ok(parsed) => json_as_cel_value(&parsed),
        Err(JsonTextError::NotJson(refusal)) => cel_error(
            CelEvaluationCode::InvalidConversion,
            format!(
                "the bytes are not JSON: invalid JSON at offset {}{}",
                refusal.offset,
                if refusal.end_of_input { " (unexpected end of input)" } else { "" }
            ),
            ctx.range,
        )
        .into(),
        Err(JsonTextError::UnpairedSurrogate { offset }) => cel_error(
            CelEvaluationCode::InvalidArgument,
            format!("json: unpaired surrogate at offset {offset}"),
            ctx.range,
        )
        .into(),
    }
}

// --- indexing a string by UTF-16 code unit ----------------------------------

fn unit_length(value: &str) -> usize {
    value.encode_utf16().count()
}

/// The UTF-16 offset of a byte offset on a character boundary.
fn units_before(value: &str, byte: usize) -> usize {
    unit_length(&value[..byte])
}

/// The byte offset of the first character boundary at or after a UTF-16 offset, or at
/// or before it.
fn byte_near(value: &str, unit: usize, after: bool) -> usize {
    let mut units = 0;
    for (byte, code) in value.char_indices() {
        if units >= unit {
            return byte;
        }
        let width = code.len_utf16();
        if units + width > unit {
            return if after { byte + code.len_utf8() } else { byte };
        }
        units += width;
    }
    value.len()
}

/// An index into a string, bounded by its length in code units; an out-of-range one
/// is refused.
fn bounded_index(ctx: &CelCallContext, at: i64, length: usize) -> Result<usize, CelValue> {
    if at < 0 || at as u64 > length as u64 {
        return Err(cel_error(CelEvaluationCode::InvalidArgument, format!("index {at} is outside the string"), ctx.range)
            .into());
    }
    Ok(at as usize)
}

fn index_of(value: &str, search: &str, from: usize) -> i64 {
    if search.is_empty() {
        return from as i64;
    }
    let start = byte_near(value, from, true);
    value[start..].find(search).map_or(-1, |found| units_before(value, start + found) as i64)
}

fn last_index_of(value: &str, search: &str, from: Option<usize>) -> i64 {
    let from = from.unwrap_or_else(|| unit_length(value));
    if search.is_empty() {
        return from as i64;
    }
    // A match starting at or before `from` ends at a character boundary at or before
    // this limit, and one starting after it ends past it.
    let mut limit = (byte_near(value, from, false) + search.len()).min(value.len());
    while !value.is_char_boundary(limit) {
        limit -= 1;
    }
    value[..limit].rfind(search).map_or(-1, |found| units_before(value, found) as i64)
}

fn is_low_surrogate(unit: u16) -> bool {
    (0xdc00..=0xdfff).contains(&unit)
}

/// Whether a code-unit offset falls between the two halves of a pair.
fn inside_pair(units: &[u16], at: usize) -> bool {
    at > 0 && at < units.len() && is_low_surrogate(units[at])
}

fn half_character(ctx: &CelCallContext, name: &str, offset: usize) -> CelValue {
    cel_error(
        CelEvaluationCode::InvalidArgument,
        format!("{name}: offset {offset} is inside a surrogate pair"),
        ctx.range,
    )
    .into()
}

/// The text of code units `[start, end)`, or the refusal of one holding half a pair.
fn unit_slice(ctx: &CelCallContext, name: &str, units: &[u16], start: usize, end: usize) -> Result<String, CelValue> {
    if start < end {
        for at in [start, end] {
            if inside_pair(units, at) {
                return Err(half_character(ctx, name, at));
            }
        }
    }
    Ok(String::from_utf16(&units[start..end]).expect("a slice between characters is text"))
}

/// A substring by **UTF-16 code unit**, as every index-taking member of this library is.
fn substring(ctx: &CelCallContext, value: &str, from: i64, to: Option<i64>) -> CelValue {
    let units: Vec<u16> = value.encode_utf16().collect();
    let start = match bounded_index(ctx, from, units.len()) {
        Ok(start) => start,
        Err(refused) => return refused,
    };
    let end = match to.map(|to| bounded_index(ctx, to, units.len())) {
        None => units.len(),
        Some(Ok(end)) => end,
        Some(Err(refused)) => return refused,
    };
    if start > end {
        let to = to.map_or_else(|| "undefined".to_string(), |to| to.to_string());
        return cel_error(
            CelEvaluationCode::InvalidArgument,
            format!("the substring starts at {from} and ends at {to}"),
            ctx.range,
        )
        .into();
    }
    match unit_slice(ctx, "substring", &units, start, end) {
        Ok(text) => CelValue::String(text.into()),
        Err(refused) => refused,
    }
}

/// `split` with a limit, as the engine being replaced answers it: a negative limit takes
/// every part, zero takes none, and a positive one keeps the remainder in the last part.
/// An empty separator splits between code units.
fn split_text(ctx: &CelCallContext, value: &str, separator: &str, limit: Option<i64>) -> CelValue {
    let strings = |parts: Vec<String>| CelValue::List(parts.into_iter().map(|part| CelValue::String(part.into())).collect());
    if limit == Some(0) {
        return CelValue::List(CelList::new());
    }
    let kept = limit.filter(|limit| *limit > 0).map(|limit| limit as u64);
    if !separator.is_empty() {
        let parts: Vec<&str> = value.split(separator).collect();
        return match kept {
            Some(kept) if (parts.len() as u64) > kept => {
                let kept = kept as usize;
                let mut out: Vec<String> = parts[..kept - 1].iter().map(|part| part.to_string()).collect();
                out.push(parts[kept - 1..].join(separator));
                strings(out)
            }
            _ => strings(parts.into_iter().map(str::to_string).collect()),
        };
    }
    let units: Vec<u16> = value.encode_utf16().collect();
    let mut bounds: Vec<(usize, usize)> = (0..units.len()).map(|at| (at, at + 1)).collect();
    if let Some(kept) = kept.filter(|kept| (units.len() as u64) > *kept).map(|kept| kept as usize) {
        bounds.truncate(kept);
        bounds[kept - 1].1 = units.len();
    }
    let mut out = Vec::with_capacity(bounds.len());
    for (start, end) in bounds {
        match unit_slice(ctx, "split", &units, start, end) {
            Ok(part) => out.push(part),
            Err(refused) => return refused,
        }
    }
    strings(out)
}

fn join(ctx: &CelCallContext, items: &CelList, separator: &str) -> CelValue {
    let mut parts = Vec::with_capacity(items.len());
    for item in items {
        match item {
            CelValue::String(part) => parts.push(&**part),
            other => {
                return cel_error(
                    CelEvaluationCode::NoMatchingOverload,
                    format!("no overload of \"join\" takes a list holding {}", cel_terms(other)),
                    ctx.range,
                )
                .into()
            }
        }
    }
    CelValue::String(parts.join(separator).into())
}

fn size_of_map(value: &CelValue) -> usize {
    match value {
        CelValue::Map(map) => map.len(),
        CelValue::Record(record) => record.len(),
        _ => 0,
    }
}

fn count(length: usize) -> CelValue {
    CelValue::Int(length as i64)
}

// --- timestamps and durations ------------------------------------------------

fn timestamp_value(ctx: &CelCallContext, result: Result<CelTimestamp, CelError>) -> CelValue {
    answer(ctx, result, CelValue::Timestamp)
}

fn duration_value(ctx: &CelCallContext, result: Result<CelDuration, CelError>) -> CelValue {
    answer(ctx, result, CelValue::Duration)
}

/// An instant moved by a duration, which is refused first when CEL's range does not
/// hold it.
fn shifted(ctx: &CelCallContext, at: CelTimestamp, by: CelDuration, sign: i128) -> CelValue {
    if let Err(error) = duration_out_of_range(by) {
        return ranged(ctx, error);
    }
    timestamp_value(ctx, cel_timestamp(0, timestamp_nanos(at) + sign * duration_nanos(by)))
}

/// One implementation under both arities: the zone is absent where the call omits it.
fn timestamp_getter(ctx: &CelCallContext, args: &[CelValue], name: &str, field: TimestampField) -> CelValue {
    let (at, zone) = match args {
        [at] => (instant(at), Some(None)),
        [at, zone] => (instant(at), text(zone).map(Some)),
        _ => (None, None),
    };
    let (Some(at), Some(zone)) = (at, zone) else {
        return mismatch(ctx, name, args);
    };
    answer(ctx, timestamp_field(at, field, zone, ctx.range), CelValue::Int)
}

fn duration_getter(ctx: &CelCallContext, args: &[CelValue], name: &str, field: DurationField) -> CelValue {
    match args {
        [CelValue::Duration(held)] => CelValue::Int(duration_field(*held, field)),
        _ => mismatch(ctx, name, args),
    }
}

// --- the table -------------------------------------------------------------

fn entry(key: &'static str, implementation: Implementation) -> (&'static str, Implementation) {
    (key, implementation)
}

macro_rules! getters {
    ($($key:literal, $zoned:literal => $name:literal, $field:ident;)+) => {
        [$(
            entry($key, |ctx, args| timestamp_getter(ctx, args, $name, TimestampField::$field)),
            entry($zoned, |ctx, args| timestamp_getter(ctx, args, $name, TimestampField::$field)),
        )+]
    };
}

fn keyed_table() -> Vec<(&'static str, Implementation)> {
    let mut table = vec![
        // conversions
        entry("bool(bool)", |ctx, args| {
            read!(ctx, args, "bool"; a: boolean);
            CelValue::Bool(a)
        }),
        entry("bool(string)", |ctx, args| {
            read!(ctx, args, "bool"; a: text);
            match BOOL_WORDS.iter().find(|(word, _)| *word == a) {
                Some((_, held)) => CelValue::Bool(*held),
                None => conversion_error(ctx, "bool()", &json_quote(a)),
            }
        }),
        entry("bytes(bytes)", |ctx, args| {
            read!(ctx, args, "bytes"; a: bytes);
            CelValue::Bytes(a.into())
        }),
        entry("bytes(string)", |ctx, args| {
            read!(ctx, args, "bytes"; a: text);
            CelValue::Bytes(text_to_bytes(a).into())
        }),
        entry("double(double)", |ctx, args| {
            read!(ctx, args, "double"; a: double);
            CelValue::Double(a)
        }),
        entry("double(int)", |ctx, args| {
            read!(ctx, args, "double"; a: integer);
            CelValue::Double(a as f64)
        }),
        entry("double(uint)", |ctx, args| {
            read!(ctx, args, "double"; a: unsigned);
            CelValue::Double(a as f64)
        }),
        entry("double(string)", |ctx, args| {
            read!(ctx, args, "double"; a: text);
            double_from_text(ctx, a)
        }),
        entry("duration(string)", |ctx, args| {
            read!(ctx, args, "duration"; a: text);
            duration_value(ctx, parse_duration(a))
        }),
        entry("duration(google.protobuf.Duration)", |ctx, args| {
            read!(ctx, args, "duration"; a: span);
            CelValue::Duration(a)
        }),
        entry("dyn(A)", |ctx, args| {
            read!(ctx, args, "dyn"; a: any);
            a.clone()
        }),
        entry("int(int)", |ctx, args| {
            read!(ctx, args, "int"; a: integer);
            CelValue::Int(a)
        }),
        entry("int(uint)", |ctx, args| {
            read!(ctx, args, "int"; a: unsigned);
            int_result(i128::from(a), ctx.range)
        }),
        entry("int(double)", |ctx, args| {
            read!(ctx, args, "int"; a: double);
            int_from_double(ctx, a)
        }),
        entry("int(string)", |ctx, args| {
            read!(ctx, args, "int"; a: text);
            if !is_decimal(a, true) {
                return conversion_error(ctx, "int()", &json_quote(a));
            }
            decimal_result(a, false, ctx.range)
        }),
        entry("int(google.protobuf.Timestamp)", |ctx, args| {
            read!(ctx, args, "int"; a: instant);
            CelValue::Int(a.seconds())
        }),
        // A duration's whole seconds, truncated toward zero — no row pins it, cel-spec does.
        entry("int(google.protobuf.Duration)", |ctx, args| {
            read!(ctx, args, "int"; a: span);
            CelValue::Int(duration_field(a, DurationField::GetSeconds))
        }),
        entry("matches(string, string)", |ctx, args| {
            read!(ctx, args, "matches"; a: text, b: text);
            cel_matches(a, b, ctx.range)
        }),
        entry("size(string)", |ctx, args| {
            read!(ctx, args, "size"; a: text);
            count(a.chars().count())
        }),
        entry("size(bytes)", |ctx, args| {
            read!(ctx, args, "size"; a: bytes);
            count(a.len())
        }),
        entry("size(list<A>)", |ctx, args| {
            read!(ctx, args, "size"; a: list);
            count(a.len())
        }),
        entry("size(map<K, V>)", |ctx, args| {
            read!(ctx, args, "size"; a: map);
            count(size_of_map(a))
        }),
        entry("string(string)", |ctx, args| {
            read!(ctx, args, "string"; a: any);
            match a {
                CelValue::String(_) => a.clone(),
                _ => mismatch(ctx, "string", args),
            }
        }),
        entry("string(bool)", |ctx, args| {
            read!(ctx, args, "string"; a: boolean);
            CelValue::String(a.to_string().into())
        }),
        entry("string(int)", |ctx, args| {
            read!(ctx, args, "string"; a: integer);
            CelValue::String(a.to_string().into())
        }),
        entry("string(uint)", |ctx, args| {
            read!(ctx, args, "string"; a: unsigned);
            CelValue::String(a.to_string().into())
        }),
        entry("string(double)", |ctx, args| {
            read!(ctx, args, "string"; a: double);
            CelValue::String(double_text(a).into())
        }),
        entry("string(bytes)", |ctx, args| {
            read!(ctx, args, "string"; a: bytes);
            answer(ctx, bytes_to_text(a), |text| CelValue::String(text.into()))
        }),
        entry("string(google.protobuf.Timestamp)", |ctx, args| {
            read!(ctx, args, "string"; a: instant);
            CelValue::String(format_timestamp(a).into())
        }),
        entry("string(google.protobuf.Duration)", |ctx, args| {
            read!(ctx, args, "string"; a: span);
            CelValue::String(format_duration(a).into())
        }),
        entry("timestamp(string)", |ctx, args| {
            read!(ctx, args, "timestamp"; a: text);
            timestamp_value(ctx, parse_timestamp(a))
        }),
        entry("timestamp(int)", |ctx, args| {
            read!(ctx, args, "timestamp"; a: integer);
            timestamp_value(ctx, cel_timestamp(i128::from(a), 0))
        }),
        entry("timestamp(google.protobuf.Timestamp)", |ctx, args| {
            read!(ctx, args, "timestamp"; a: instant);
            CelValue::Timestamp(a)
        }),
        entry("uint(uint)", |ctx, args| {
            read!(ctx, args, "uint"; a: unsigned);
            CelValue::Uint(a)
        }),
        entry("uint(int)", |ctx, args| {
            read!(ctx, args, "uint"; a: integer);
            uint_result(i128::from(a), ctx.range)
        }),
        entry("uint(double)", |ctx, args| {
            read!(ctx, args, "uint"; a: double);
            uint_from_double(ctx, a)
        }),
        entry("uint(string)", |ctx, args| {
            read!(ctx, args, "uint"; a: text);
            if !is_decimal(a, false) {
                return conversion_error(ctx, "uint()", &json_quote(a));
            }
            decimal_result(a, true, ctx.range)
        }),
        // string members
        entry("string.size()", |ctx, args| {
            read!(ctx, args, "size"; a: text);
            count(a.chars().count())
        }),
        entry("bytes.size()", |ctx, args| {
            read!(ctx, args, "size"; a: bytes);
            count(a.len())
        }),
        entry("list<A>.size()", |ctx, args| {
            read!(ctx, args, "size"; a: list);
            count(a.len())
        }),
        entry("map<K, V>.size()", |ctx, args| {
            read!(ctx, args, "size"; a: map);
            count(size_of_map(a))
        }),
        entry("string.startsWith(string)", |ctx, args| {
            read!(ctx, args, "startsWith"; a: text, b: text);
            CelValue::Bool(a.starts_with(b))
        }),
        entry("string.endsWith(string)", |ctx, args| {
            read!(ctx, args, "endsWith"; a: text, b: text);
            CelValue::Bool(a.ends_with(b))
        }),
        entry("string.contains(string)", |ctx, args| {
            read!(ctx, args, "contains"; a: text, b: text);
            CelValue::Bool(a.contains(b))
        }),
        entry("string.matches(string)", |ctx, args| {
            read!(ctx, args, "matches"; a: text, b: text);
            cel_matches(a, b, ctx.range)
        }),
        // Named for ASCII and not limited to it — see the declaration's own `spec: false` reason.
        entry("string.lowerAscii()", |ctx, args| {
            read!(ctx, args, "lowerAscii"; a: text);
            CelValue::String(es_to_lower_case(a).into())
        }),
        entry("string.upperAscii()", |ctx, args| {
            read!(ctx, args, "upperAscii"; a: text);
            CelValue::String(es_to_upper_case(a).into())
        }),
        entry("string.trim()", |ctx, args| {
            read!(ctx, args, "trim"; a: text);
            CelValue::String(es_trim(a).into())
        }),
        entry("string.indexOf(string)", |ctx, args| {
            read!(ctx, args, "indexOf"; a: text, b: text);
            CelValue::Int(index_of(a, b, 0))
        }),
        entry("string.indexOf(string, int)", |ctx, args| {
            read!(ctx, args, "indexOf"; a: text, b: text, c: integer);
            match bounded_index(ctx, c, unit_length(a)) {
                Ok(from) => CelValue::Int(index_of(a, b, from)),
                Err(refused) => refused,
            }
        }),
        entry("string.lastIndexOf(string)", |ctx, args| {
            read!(ctx, args, "lastIndexOf"; a: text, b: text);
            CelValue::Int(last_index_of(a, b, None))
        }),
        entry("string.lastIndexOf(string, int)", |ctx, args| {
            read!(ctx, args, "lastIndexOf"; a: text, b: text, c: integer);
            match bounded_index(ctx, c, unit_length(a)) {
                Ok(from) => CelValue::Int(last_index_of(a, b, Some(from))),
                Err(refused) => refused,
            }
        }),
        entry("string.substring(int)", |ctx, args| {
            read!(ctx, args, "substring"; a: text, b: integer);
            substring(ctx, a, b, None)
        }),
        entry("string.substring(int, int)", |ctx, args| {
            read!(ctx, args, "substring"; a: text, b: integer, c: integer);
            substring(ctx, a, b, Some(c))
        }),
        entry("string.split(string)", |ctx, args| {
            read!(ctx, args, "split"; a: text, b: text);
            split_text(ctx, a, b, None)
        }),
        entry("string.split(string, int)", |ctx, args| {
            read!(ctx, args, "split"; a: text, b: text, c: integer);
            split_text(ctx, a, b, Some(c))
        }),
        entry("list<string>.join()", |ctx, args| {
            read!(ctx, args, "join"; a: list);
            join(ctx, a, "")
        }),
        entry("list<string>.join(string)", |ctx, args| {
            read!(ctx, args, "join"; a: list, b: text);
            join(ctx, a, b)
        }),
        // bytes members, each a compatibility member rather than CEL's
        entry("bytes.string()", |ctx, args| {
            read!(ctx, args, "string"; a: bytes);
            answer(ctx, bytes_to_text(a), |text| CelValue::String(text.into()))
        }),
        entry("bytes.hex()", |ctx, args| {
            read!(ctx, args, "hex"; a: bytes);
            CelValue::String(hex_text(a).into())
        }),
        entry("bytes.base64()", |ctx, args| {
            read!(ctx, args, "base64"; a: bytes);
            CelValue::String(base64_text(a).into())
        }),
        entry("bytes.json()", |ctx, args| {
            read!(ctx, args, "json"; a: bytes);
            bytes_json(ctx, a)
        }),
        entry("bytes.at(int)", |ctx, args| {
            read!(ctx, args, "at"; a: bytes, b: integer);
            match usize::try_from(b).ok().and_then(|at| a.get(at)) {
                Some(held) => CelValue::Int(i64::from(*held)),
                None => {
                    cel_error(CelEvaluationCode::IndexOutOfRange, format!("index out of range: {b}"), ctx.range).into()
                }
            }
        }),
        // arithmetic
        entry("!(bool)", |ctx, args| {
            read!(ctx, args, "!"; a: boolean);
            CelValue::Bool(!a)
        }),
        entry("-(int)", |ctx, args| {
            read!(ctx, args, "-"; a: integer);
            int_result(-i128::from(a), ctx.range)
        }),
        entry("-(double)", |ctx, args| {
            read!(ctx, args, "-"; a: double);
            CelValue::Double(-a)
        }),
        entry("+(int, int)", |ctx, args| {
            read!(ctx, args, "+"; a: integer, b: integer);
            int_result(i128::from(a) + i128::from(b), ctx.range)
        }),
        entry("+(uint, uint)", |ctx, args| {
            read!(ctx, args, "+"; a: unsigned, b: unsigned);
            uint_result(i128::from(a) + i128::from(b), ctx.range)
        }),
        entry("+(double, double)", |ctx, args| {
            read!(ctx, args, "+"; a: double, b: double);
            CelValue::Double(a + b)
        }),
        entry("+(string, string)", |ctx, args| {
            read!(ctx, args, "+"; a: text, b: text);
            CelValue::String([a, b].concat().into())
        }),
        entry("+(bytes, bytes)", |ctx, args| {
            read!(ctx, args, "+"; a: bytes, b: bytes);
            CelValue::Bytes([a, b].concat().into())
        }),
        entry("+(list<A>, list<A>)", |ctx, args| {
            read!(ctx, args, "+"; a: list, b: list);
            CelValue::List(a.iter().chain(b.iter()).cloned().collect())
        }),
        entry("+(google.protobuf.Timestamp, google.protobuf.Duration)", |ctx, args| {
            read!(ctx, args, "+"; a: instant, b: span);
            shifted(ctx, a, b, 1)
        }),
        entry("+(google.protobuf.Duration, google.protobuf.Timestamp)", |ctx, args| {
            read!(ctx, args, "+"; a: span, b: instant);
            shifted(ctx, b, a, 1)
        }),
        entry("+(google.protobuf.Duration, google.protobuf.Duration)", |ctx, args| {
            read!(ctx, args, "+"; a: span, b: span);
            duration_value(ctx, cel_duration_from_nanos(duration_nanos(a) + duration_nanos(b)))
        }),
        entry("-(int, int)", |ctx, args| {
            read!(ctx, args, "-"; a: integer, b: integer);
            int_result(i128::from(a) - i128::from(b), ctx.range)
        }),
        entry("-(uint, uint)", |ctx, args| {
            read!(ctx, args, "-"; a: unsigned, b: unsigned);
            uint_result(i128::from(a) - i128::from(b), ctx.range)
        }),
        entry("-(double, double)", |ctx, args| {
            read!(ctx, args, "-"; a: double, b: double);
            CelValue::Double(a - b)
        }),
        entry("-(google.protobuf.Timestamp, google.protobuf.Timestamp)", |ctx, args| {
            read!(ctx, args, "-"; a: instant, b: instant);
            duration_value(ctx, cel_duration_from_nanos(timestamp_nanos(a) - timestamp_nanos(b)))
        }),
        entry("-(google.protobuf.Timestamp, google.protobuf.Duration)", |ctx, args| {
            read!(ctx, args, "-"; a: instant, b: span);
            shifted(ctx, a, b, -1)
        }),
        entry("-(google.protobuf.Duration, google.protobuf.Duration)", |ctx, args| {
            read!(ctx, args, "-"; a: span, b: span);
            duration_value(ctx, cel_duration_from_nanos(duration_nanos(a) - duration_nanos(b)))
        }),
        entry("*(int, int)", |ctx, args| {
            read!(ctx, args, "*"; a: integer, b: integer);
            int_result(i128::from(a) * i128::from(b), ctx.range)
        }),
        entry("*(uint, uint)", |ctx, args| {
            read!(ctx, args, "*"; a: unsigned, b: unsigned);
            uint_product(a, b, ctx.range)
        }),
        entry("*(double, double)", |ctx, args| {
            read!(ctx, args, "*"; a: double, b: double);
            CelValue::Double(a * b)
        }),
        entry("/(int, int)", |ctx, args| {
            read!(ctx, args, "/"; a: integer, b: integer);
            int_divide(a, b, ctx.range)
        }),
        entry("/(uint, uint)", |ctx, args| {
            read!(ctx, args, "/"; a: unsigned, b: unsigned);
            uint_divide(a, b, ctx.range)
        }),
        // A double divided by zero is an infinity, as IEEE 754 says; only the integers refuse.
        entry("/(double, double)", |ctx, args| {
            read!(ctx, args, "/"; a: double, b: double);
            CelValue::Double(a / b)
        }),
        entry("%(int, int)", |ctx, args| {
            read!(ctx, args, "%"; a: integer, b: integer);
            int_modulo(a, b, ctx.range)
        }),
        entry("%(uint, uint)", |ctx, args| {
            read!(ctx, args, "%"; a: unsigned, b: unsigned);
            uint_modulo(a, b, ctx.range)
        }),
        entry("in(A, list<A>)", |ctx, args| {
            read!(ctx, args, "in"; a: any, b: list);
            CelValue::Bool(b.iter().any(|held| cel_equal(held, a)))
        }),
        entry("in(K, map<K, V>)", |ctx, args| {
            read!(ctx, args, "in"; a: any, b: map);
            CelValue::Bool(matches!(cel_lookup(b, a, None), Lookup::Found(_)))
        }),
        // the optional library
        entry("optional<A>.hasValue()", |ctx, args| {
            read!(ctx, args, "hasValue"; a: optional);
            CelValue::Bool(a.is_present())
        }),
        entry("optional<A>.value()", |ctx, args| {
            read!(ctx, args, "value"; a: optional);
            match a.held() {
                Some(held) => held.clone(),
                None => cel_error(CelEvaluationCode::OptionalValueMissing, "the optional holds no value", ctx.range).into(),
            }
        }),
        entry("optional<A>.or(optional<A>)", |ctx, args| {
            read!(ctx, args, "or"; a: optional, b: any);
            if a.is_present() {
                args[0].clone()
            } else {
                b.clone()
            }
        }),
        entry("optional<A>.orValue(A)", |ctx, args| {
            read!(ctx, args, "orValue"; a: optional, b: any);
            a.held().unwrap_or(b).clone()
        }),
    ];
    table.extend(getters! {
        "google.protobuf.Timestamp.getDate()",
        "google.protobuf.Timestamp.getDate(string)" => "getDate", GetDate;
        "google.protobuf.Timestamp.getDayOfMonth()",
        "google.protobuf.Timestamp.getDayOfMonth(string)" => "getDayOfMonth", GetDayOfMonth;
        "google.protobuf.Timestamp.getDayOfWeek()",
        "google.protobuf.Timestamp.getDayOfWeek(string)" => "getDayOfWeek", GetDayOfWeek;
        "google.protobuf.Timestamp.getDayOfYear()",
        "google.protobuf.Timestamp.getDayOfYear(string)" => "getDayOfYear", GetDayOfYear;
        "google.protobuf.Timestamp.getFullYear()",
        "google.protobuf.Timestamp.getFullYear(string)" => "getFullYear", GetFullYear;
        "google.protobuf.Timestamp.getHours()",
        "google.protobuf.Timestamp.getHours(string)" => "getHours", GetHours;
        "google.protobuf.Timestamp.getMilliseconds()",
        "google.protobuf.Timestamp.getMilliseconds(string)" => "getMilliseconds", GetMilliseconds;
        "google.protobuf.Timestamp.getMinutes()",
        "google.protobuf.Timestamp.getMinutes(string)" => "getMinutes", GetMinutes;
        "google.protobuf.Timestamp.getMonth()",
        "google.protobuf.Timestamp.getMonth(string)" => "getMonth", GetMonth;
        "google.protobuf.Timestamp.getSeconds()",
        "google.protobuf.Timestamp.getSeconds(string)" => "getSeconds", GetSeconds;
    });
    table.extend([
        entry("google.protobuf.Duration.getHours()", |ctx, args| {
            duration_getter(ctx, args, "getHours", DurationField::GetHours)
        }),
        entry("google.protobuf.Duration.getMinutes()", |ctx, args| {
            duration_getter(ctx, args, "getMinutes", DurationField::GetMinutes)
        }),
        entry("google.protobuf.Duration.getSeconds()", |ctx, args| {
            duration_getter(ctx, args, "getSeconds", DurationField::GetSeconds)
        }),
        entry("google.protobuf.Duration.getMilliseconds()", |ctx, args| {
            duration_getter(ctx, args, "getMilliseconds", DurationField::GetMilliseconds)
        }),
    ]);
    table
}

/// Values that do not order at all — unrelated types, or a NaN. NaN orders with
/// nothing, including itself, so every comparison against it is false.
fn ordering(ctx: &CelCallContext, args: &[CelValue], name: &str, holds: fn(std::cmp::Ordering) -> bool) -> CelValue {
    let [a, b] = args else {
        return mismatch(ctx, name, args);
    };
    match cel_compare(a, b) {
        Some(compared) => CelValue::Bool(holds(compared)),
        None if [a, b].iter().any(|value| matches!(value, CelValue::Double(held) if held.is_nan())) => {
            CelValue::Bool(false)
        }
        None => cel_error(
            CelEvaluationCode::NoMatchingOverload,
            format!(
                "{} and {} do not order",
                cel_type_name_of(a).unwrap_or("this value"),
                cel_type_name_of(b).unwrap_or("this value")
            ),
            ctx.range,
        )
        .into(),
    }
}

/// Equality and ordering are answered by **name**, over every type pair the library
/// declares and every one a host adds.
fn by_name_table() -> Vec<(&'static str, Implementation)> {
    vec![
        entry("==", |ctx, args| {
            read!(ctx, args, "=="; a: any, b: any);
            CelValue::Bool(cel_equal(a, b))
        }),
        entry("!=", |ctx, args| {
            read!(ctx, args, "!="; a: any, b: any);
            CelValue::Bool(!cel_equal(a, b))
        }),
        entry("<", |ctx, args| ordering(ctx, args, "<", std::cmp::Ordering::is_lt)),
        entry("<=", |ctx, args| ordering(ctx, args, "<=", std::cmp::Ordering::is_le)),
        entry(">", |ctx, args| ordering(ctx, args, ">", std::cmp::Ordering::is_gt)),
        entry(">=", |ctx, args| ordering(ctx, args, ">=", std::cmp::Ordering::is_ge)),
        entry("type", |ctx, args| {
            read!(ctx, args, "type"; a: any);
            answer(ctx, cel_type_value_of(a, ctx.range), CelValue::Type)
        }),
    ]
}

struct Table {
    keyed: Vec<(&'static str, CelImplementation)>,
    index: HashMap<&'static str, usize>,
    by_name: HashMap<&'static str, CelImplementation>,
}

impl fmt::Debug for Table {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Table").field("keyed", &self.keyed.len()).field("by_name", &self.by_name.len()).finish()
    }
}

fn shared(implementation: Implementation) -> CelImplementation {
    Arc::new(implementation)
}

static TABLE: LazyLock<Table> = LazyLock::new(|| {
    let keyed: Vec<(&'static str, CelImplementation)> =
        keyed_table().into_iter().map(|(key, implementation)| (key, shared(implementation))).collect();
    let index = keyed.iter().enumerate().map(|(at, (key, _))| (*key, at)).collect();
    let by_name = by_name_table().into_iter().map(|(name, implementation)| (name, shared(implementation))).collect();
    Table { keyed, index, by_name }
});

/// The implementation of a registered signature, or nothing where the registration has
/// none — a host's own function, which the host supplies itself.
pub fn implementation_of(signature: &CelSignature) -> Option<CelImplementation> {
    let table = &*TABLE;
    match table.index.get(signature_key(signature).as_str()) {
        Some(&at) => Some(table.keyed[at].1.clone()),
        None => table.by_name.get(signature.name.as_str()).cloned(),
    }
}

/// Every dispatch key this file answers for, in its own order, for a completeness check.
pub fn implemented_keys() -> Vec<&'static str> {
    TABLE.keyed.iter().map(|(key, _)| *key).collect()
}

/// The values the library's own constants read as: each type name as a type value, and
/// `google`, through which the two well-known type names are reached.
pub fn standard_constant_values(optional_types: bool) -> PropertyMap<CelValue> {
    let mut values = PropertyMap::new();
    for name in ["bool", "bytes", "double", "int", "list", "map", "null_type", "string", "type", "uint"] {
        values.insert(name, CelValue::Type(cel_type_value(name)));
    }
    if optional_types {
        values.insert("optional_type", CelValue::Type(cel_type_value("optional_type")));
    }
    let google: CelRecord = google_type_names()
        .iter()
        .map(|(namespace, names)| {
            let held: CelRecord = names
                .iter()
                .map(|name| (*name, CelValue::Type(cel_type_value(format!("google.{namespace}.{name}")))))
                .collect();
            (*namespace, CelValue::Record(held))
        })
        .collect();
    values.insert("google", CelValue::Record(google));
    values
}

/// `optional.ofNonZeroValue(v)`: present unless the value is its type's zero.
pub fn optional_of_non_zero(held: CelValue) -> CelOptional {
    if is_zero_value(&held) {
        cel_none()
    } else {
        cel_some(held)
    }
}

/// Whether a value is its type's zero. **An instant, a type value, an optional and a
/// host's named type have no zero in CEL**, because nothing in the language names one.
fn is_zero_value(value: &CelValue) -> bool {
    match value {
        CelValue::Null => true,
        CelValue::Bool(held) => !held,
        CelValue::String(held) => held.is_empty(),
        CelValue::Int(held) => *held == 0,
        CelValue::Double(held) => *held == 0.0,
        CelValue::Uint(held) => *held == 0,
        CelValue::Bytes(held) => held.is_empty(),
        CelValue::List(held) => held.is_empty(),
        CelValue::Map(held) => held.is_empty(),
        CelValue::Record(held) => held.is_empty(),
        CelValue::Duration(held) => duration_nanos(*held) == 0,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::function_registry::FunctionRegistry;
    use crate::standard_library::{register_standard_library, StandardLibraryOptions};

    /// Node's `BY_NAME` is not exported, so its reverse direction is pinned here: every
    /// entry names a function the library registers, and there are seven.
    #[test]
    fn answers_by_name_only_for_functions_the_library_registers() {
        let mut registry = FunctionRegistry::new();
        register_standard_library(&mut registry, StandardLibraryOptions { optional_types: true, resolve_nominal: None });
        let names: Vec<&str> = by_name_table().into_iter().map(|(name, _)| name).collect();
        assert_eq!(names, ["==", "!=", "<", "<=", ">", ">=", "type"]);
        for name in names {
            assert!(registry.has(name), "{name}");
        }
    }
}
