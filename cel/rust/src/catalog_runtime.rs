//! What every function of the catalog **does** — `catalog-runtime.ts`.
//!
//! The declarations are data (`cel/nodejs/src/signatures/function-catalog.json`); this is
//! the behaviour behind them, keyed by the same dispatch key the registry resolves on, as
//! `runtime_library.rs` is for CEL's own library. Recorded against `@telorun/cel` 0.129.0
//! at `2ee5ef49` under Node v24.21.0 (V8 13.6.233.17-node.53, ICU 78.3, tz 2026c), with
//! d3-format 3.1.2, `uuid` 14.0.1 and re2js 2.8.3.
//!
//! **Nine functions are the host's** — the four hashes, `hmac`, the two base64 string
//! conversions, `json` and `joinPath` — supplied through [`CelCatalogHandlers`]. One left
//! out still registers, and a call answers `unbound_function` naming the function. A
//! handler answers its text or a [`CatalogRefusal`], which becomes an error value of the
//! refusal's own code, ranged over the call, its message as the handler wrote it.
//!
//! **A refusal is worded here, in one voice** — `<function>: <what is wrong>` — and turned
//! into an error value at one place. An implementation handed values its signature does
//! not take, which dispatch never does, answers `no_matching_overload` as the runtime
//! library's do.
//!
//! **Where this file answers otherwise than Node**, each held by a named test and listed in
//! the crate's README: Node throws a host exception out of evaluation where this file
//! answers an error value — `range` past 4,294,967,295 or past what the process can
//! allocate, `urlDecode`, `uuidv3` / `uuidv5` / `uuidVersion` over a text that is not a
//! UUID, a huge `format` width, a calendar result outside ECMAScript's time range, a random
//! source that answers nothing, and a host handler's failure; a string holding half a
//! surrogate pair, which Node answers from `slice`, `split`, `replace` and `parseJson`, is
//! refused; and `merge` refuses a uint key into a record, where Node writes a JavaScript
//! artifact as its key. `slice` over bytes copies them, where Node answers a view.
//!
//! `sort` is V8's TimSort, comparison for comparison, so a comparator that is not a total
//! order — NaN equal to everything, numbers beside text — answers the list Node answers.
//! `distinct` keeps Node's predicate (a value is dropped exactly when a value kept equals
//! it) over buckets of a hash CEL equality agrees with, so it runs in linear time where
//! Node's is quadratic. Nothing recurses on the depth of a value.
//!
//! Node items with no twin: `CatalogImplementation`, the function from handlers to an
//! implementation — [`catalog_implementation`] takes the handlers itself.

use std::cmp::Ordering;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hash, Hasher};
use std::sync::{Arc, LazyLock};

use telorun_cel_value::{
    bytes_to_text, cel_error, cel_map_from_entries, cel_timestamp, cel_type_name_of, double_text, es_number,
    es_string_to_number, es_trim, format_duration, format_timestamp, json_quote, map_key_identity, timestamp_nanos,
    duration_nanos, CelEvaluationCode, CelList, CelMapKey, CelRecord, CelTimestamp, CelValue,
};

use crate::d3_format::{d3_formatter, D3Format, TooLong};
use crate::es_number_text::{math_round, to_fixed};
use crate::host_clock::now_millis;
use crate::json_text_scan::{read_json_text, JsonTextError};
use crate::re2_matcher::{replace_all, Re2Matcher};
use crate::re2_program::Re2Program;
use crate::regular_expression::{re2_pattern, Re2Flags, RE2_FLAG_LETTERS};
use crate::runtime_library::{base64_text, json_as_cel_value, mismatch, CelCallContext, CelImplementation};
use crate::signature::LiteralArgumentCheck;
use crate::uri_component::{decode_uri_component, encode_uri_component, UriDecodeFault};
use crate::uuid::{uuid_v1, uuid_v3, uuid_v4, uuid_v5, uuid_v6, uuid_v7, uuid_validate, uuid_version};
use crate::value_equality::cel_equal;
use crate::value_text::{es_to_lower_case, es_to_upper_case};
use crate::zoned_calendar::{
    civil_time_in, date_text_in, days_in_month, instant_of_civil_time, iso_text_in, known_time_zone, CivilTime,
};

/// A refusal a catalog function, or a host's handler, makes of its arguments: the message
/// an author reads and the evaluation code it answers with.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct CatalogRefusal {
    pub message: String,
    pub code: CelEvaluationCode,
}

impl CatalogRefusal {
    /// A refusal of an argument, `invalid_argument`.
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into(), code: CelEvaluationCode::InvalidArgument }
    }

    fn coded(message: impl Into<String>, code: CelEvaluationCode) -> Self {
        Self { message: message.into(), code }
    }
}

impl std::fmt::Display for CatalogRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CatalogRefusal {}

/// The nine functions the host answers for, each optional. A refusal a handler answers is
/// the call's error value, so its message is written in the catalog's voice.
#[derive(Clone, Default)]
#[allow(clippy::type_complexity)]
pub struct CelCatalogHandlers {
    pub sha256: Option<Arc<dyn Fn(&str) -> Result<String, CatalogRefusal> + Send + Sync>>,
    pub md5: Option<Arc<dyn Fn(&str) -> Result<String, CatalogRefusal> + Send + Sync>>,
    pub sha1: Option<Arc<dyn Fn(&str) -> Result<String, CatalogRefusal> + Send + Sync>>,
    pub sha512: Option<Arc<dyn Fn(&str) -> Result<String, CatalogRefusal> + Send + Sync>>,
    /// The algorithm, the key and the message.
    pub hmac: Option<Arc<dyn Fn(&str, &str, &str) -> Result<String, CatalogRefusal> + Send + Sync>>,
    pub base64_encode: Option<Arc<dyn Fn(&str) -> Result<String, CatalogRefusal> + Send + Sync>>,
    pub base64_decode: Option<Arc<dyn Fn(&str) -> Result<String, CatalogRefusal> + Send + Sync>>,
    pub json: Option<Arc<dyn Fn(&CelValue) -> Result<String, CatalogRefusal> + Send + Sync>>,
    /// Joins a relative path onto a base with the host's path rules.
    pub join_path: Option<Arc<dyn Fn(&str, &str) -> Result<String, CatalogRefusal> + Send + Sync>>,
}

impl std::fmt::Debug for CelCatalogHandlers {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let held = |present: bool| if present { "handler" } else { "none" };
        f.debug_struct("CelCatalogHandlers")
            .field("sha256", &held(self.sha256.is_some()))
            .field("md5", &held(self.md5.is_some()))
            .field("sha1", &held(self.sha1.is_some()))
            .field("sha512", &held(self.sha512.is_some()))
            .field("hmac", &held(self.hmac.is_some()))
            .field("base64_encode", &held(self.base64_encode.is_some()))
            .field("base64_decode", &held(self.base64_decode.is_some()))
            .field("json", &held(self.json.is_some()))
            .field("join_path", &held(self.join_path.is_some()))
            .finish()
    }
}

/// Why an implementation gives no value: its refusal, or values its signature does not take.
enum Failure {
    Refused(CatalogRefusal),
    Mismatch,
}

impl From<CatalogRefusal> for Failure {
    fn from(refusal: CatalogRefusal) -> Self {
        Failure::Refused(refusal)
    }
}

type Outcome = Result<CelValue, Failure>;

fn refuse<T>(message: impl Into<String>) -> Result<T, CatalogRefusal> {
    Err(CatalogRefusal::new(message))
}

// --- reading arguments ------------------------------------------------------

fn arity(args: &[CelValue], count: usize) -> Result<(), Failure> {
    if args.len() == count {
        Ok(())
    } else {
        Err(Failure::Mismatch)
    }
}

fn text(value: &CelValue) -> Result<&str, Failure> {
    match value {
        CelValue::String(held) => Ok(held),
        _ => Err(Failure::Mismatch),
    }
}

fn integer(value: &CelValue) -> Result<i64, Failure> {
    match value {
        CelValue::Int(held) => Ok(*held),
        _ => Err(Failure::Mismatch),
    }
}

fn type_name(value: &CelValue) -> &str {
    cel_type_name_of(value).unwrap_or("error")
}

/// A list argument, named in the catalog's voice where a `dyn` slot carried something else.
fn list<'a>(what: &str, value: &'a CelValue) -> Result<&'a CelList, CatalogRefusal> {
    match value {
        CelValue::List(items) => Ok(items),
        other => refuse(format!("{what}: expected a list, got {}", type_name(other))),
    }
}

/// A value as a number, as every arithmetic and formatting entry reads one.
fn number_of(value: &CelValue) -> f64 {
    match value {
        CelValue::Double(held) => *held,
        CelValue::Int(held) => *held as f64,
        CelValue::Uint(held) => *held as f64,
        CelValue::Bool(held) => f64::from(u8::from(*held)),
        CelValue::Null => 0.0,
        CelValue::String(held) => es_string_to_number(held),
        _ => f64::NAN,
    }
}

/// The text of a value that is not a list, or its refusal.
fn scalar_text(what: &str, value: &CelValue) -> Result<String, CatalogRefusal> {
    Ok(match value {
        CelValue::String(held) => held.to_string(),
        CelValue::Int(held) => held.to_string(),
        CelValue::Uint(held) => held.to_string(),
        CelValue::Double(held) => double_text(*held),
        CelValue::Bool(held) => held.to_string(),
        CelValue::Null => "null".into(),
        CelValue::Timestamp(held) => format_timestamp(*held),
        CelValue::Duration(held) => format_duration(*held),
        CelValue::Bytes(held) => match bytes_to_text(held) {
            Ok(decoded) => decoded,
            Err(_) => {
                return Err(CatalogRefusal::coded(
                    format!("{what}: the bytes are not UTF-8 text"),
                    CelEvaluationCode::InvalidConversion,
                ))
            }
        },
        other => {
            return Err(CatalogRefusal::coded(
                format!("{what}: a value of type {} has no text", type_name(other)),
                CelEvaluationCode::InvalidConversion,
            ))
        }
    })
}

/// A value as text, for `join`, a specifier, a zone and ordering text: the text `string()`
/// answers, a list its elements' texts joined by commas at every depth, and a value with no
/// single written form refused. Walked on a work list.
fn text_of(what: &str, value: &CelValue) -> Result<String, CatalogRefusal> {
    let CelValue::List(items) = value else {
        return scalar_text(what, value);
    };
    let mut out = String::new();
    let mut stack: Vec<(&[CelValue], usize)> = vec![(items.as_slice(), 0)];
    while let Some(top) = stack.last_mut() {
        let (items, at) = *top;
        let Some(item) = items.get(at) else {
            stack.pop();
            continue;
        };
        top.1 += 1;
        if at > 0 {
            out.push(',');
        }
        match item {
            CelValue::List(inner) => stack.push((inner.as_slice(), 0)),
            scalar => out.push_str(&scalar_text(what, scalar)?),
        }
    }
    Ok(out)
}

/// A map's entries, whichever container holds them. A list is named rather than joined.
fn map_entries(what: &str, value: &CelValue) -> Result<Vec<(CelValue, CelValue)>, CatalogRefusal> {
    match value {
        CelValue::Map(map) => Ok(map.iter().map(|(key, value)| (key.clone(), value.clone())).collect()),
        CelValue::Record(record) => {
            Ok(record.iter().map(|(key, value)| (CelValue::String(key.into()), value.clone())).collect())
        }
        CelValue::List(_) => refuse(format!("{what}: expected a map, got a list — use '+' to join lists")),
        other => refuse(format!("{what}: expected a map, got {}", type_name(other))),
    }
}

/// A map of the container `like` is, from entries in order: a key met again takes the
/// later key and value at its first place. A record takes a key as JavaScript writes it as
/// a property name.
fn map_of_entries(what: &str, like: &CelValue, pairs: Vec<(CelValue, CelValue)>) -> Result<CelValue, CatalogRefusal> {
    if let CelValue::Map(_) = like {
        let mut entries: Vec<(CelValue, CelValue)> = Vec::with_capacity(pairs.len());
        let mut index: HashMap<CelMapKey, usize> = HashMap::with_capacity(pairs.len());
        for (key, value) in pairs {
            let Some(identity) = map_key_identity(&key) else { continue };
            match index.get(&identity) {
                Some(&at) => entries[at] = (key, value),
                None => {
                    index.insert(identity, entries.len());
                    entries.push((key, value));
                }
            }
        }
        let map = cel_map_from_entries(entries).expect("entries of one identity each make a map");
        return Ok(CelValue::Map(map));
    }
    let mut record = CelRecord::new();
    for (key, value) in pairs {
        let name = match &key {
            CelValue::String(held) => held.to_string(),
            CelValue::Int(held) => held.to_string(),
            CelValue::Bool(held) => held.to_string(),
            CelValue::Uint(_) => {
                return refuse(format!("{what}: a key of type uint cannot be held by a map with string keys"))
            }
            _ => continue,
        };
        record.insert(name, value);
    }
    Ok(CelValue::Record(record))
}

fn instant_arg(what: &str, value: &CelValue) -> Result<CelTimestamp, CatalogRefusal> {
    match value {
        CelValue::Timestamp(held) => Ok(*held),
        _ => refuse(format!("{what}: expected a timestamp")),
    }
}

/// An instant as milliseconds, the granularity the calendar works at.
fn millis_of(value: CelTimestamp) -> i64 {
    value.seconds() * 1000 + i64::from(value.subsec_nanos() / 1_000_000)
}

fn outside_range(what: &str) -> CatalogRefusal {
    CatalogRefusal::coded(
        format!("{what}: the result is outside the range of a timestamp"),
        CelEvaluationCode::InvalidConversion,
    )
}

/// An instant from milliseconds; out of CEL's range, or no instant at all, it is refused.
fn instant_of_millis(what: &str, millis: Option<i64>) -> Result<CelValue, CatalogRefusal> {
    let millis = millis.ok_or_else(|| outside_range(what))?;
    let whole = millis.div_euclid(1000);
    let rest = millis.rem_euclid(1000);
    cel_timestamp(i128::from(whole), i128::from(rest) * 1_000_000)
        .map(CelValue::Timestamp)
        .map_err(|_| outside_range(what))
}

// --- formatting -------------------------------------------------------------

const MAX_EXACT_INT: u64 = 9_007_199_254_740_991;

/// A number d3 can format: an integer past 2^53 − 1 or a value that is not a finite
/// number is refused.
fn formattable(what: &str, value: &CelValue) -> Result<f64, CatalogRefusal> {
    match value {
        CelValue::Int(held) => {
            if held.unsigned_abs() > MAX_EXACT_INT {
                return refuse(format!("{what}: integer {held} exceeds 2^53-1 and cannot be formatted exactly as a double"));
            }
            Ok(*held as f64)
        }
        CelValue::Uint(held) => {
            if *held > MAX_EXACT_INT {
                return refuse(format!("{what}: integer {held} exceeds 2^53-1 and cannot be formatted exactly as a double"));
            }
            Ok(*held as f64)
        }
        other => {
            let number = number_of(other);
            if !number.is_finite() {
                return refuse(format!("{what}: expected a finite number, got {}", type_name(other)));
            }
            Ok(number)
        }
    }
}

const FORMAT_TYPES: &str = "efgrs%pbodxXcn";

const MAX_DECIMALS: f64 = 10.0;

fn is_integer(number: f64) -> bool {
    number.is_finite() && number.trunc() == number
}

/// Decimal places, bounded to 0–10, wherever a precision is written.
fn digit_count(what: &str, digits: &CelValue) -> Result<usize, CatalogRefusal> {
    let count = number_of(digits);
    if !is_integer(count) || count < 0.0 || count > MAX_DECIMALS {
        let written = text_of(what, digits)?;
        return refuse(format!("{what}: decimal places must be an integer 0-10, got {written}"));
    }
    Ok(count as usize)
}

/// The `.precision` group of a specifier: the digits after its first `.` followed by one.
fn precision_digits(written: &str) -> Option<&str> {
    let bytes = written.as_bytes();
    let dot = (0..bytes.len()).find(|&at| bytes[at] == b'.' && bytes.get(at + 1).is_some_and(u8::is_ascii_digit))?;
    let digits = &written[dot + 1..];
    let end = digits.bytes().position(|byte| !byte.is_ascii_digit()).unwrap_or(digits.len());
    Some(&digits[..end])
}

/// The formatter for a specifier: an unknown type letter and a precision out of range are
/// the catalog's own refusals, then d3 reads it.
fn formatter(what: &str, specifier: &CelValue) -> Result<Arc<D3Format>, CatalogRefusal> {
    let written = text_of(what, specifier)?;
    if let Some(last) = written.chars().next_back() {
        if (last.is_ascii_alphabetic() || last == '%') && !FORMAT_TYPES.contains(last) {
            return refuse(format!("{what}: unknown format type '{last}' (one of {FORMAT_TYPES})"));
        }
    }
    if let Some(digits) = precision_digits(&written) {
        digit_count(what, &CelValue::String(digits.into()))?;
    }
    d3_formatter(&written).map_err(|_| CatalogRefusal::new(format!("{what}: invalid format specifier {}", json_quote(&written))))
}

fn formatted(what: &str, formatter: &D3Format, value: f64) -> Result<String, CatalogRefusal> {
    formatter.format(value).map_err(|TooLong { width }| {
        CatalogRefusal::new(format!(
            "{what}: width {} exceeds the longest text a string can hold (536870888 UTF-16 code units)",
            es_number(width)
        ))
    })
}

/// A minute count against a declared day length.
fn duration_text(minutes: &CelValue, minutes_per_day: &CelValue) -> Result<String, CatalogRefusal> {
    let per_day = math_round(formattable("formatDuration", minutes_per_day)?);
    if !per_day.is_finite() || per_day <= 0.0 {
        return refuse(format!("formatDuration: minutesPerDay must be a positive number, got {}", es_number(per_day)));
    }
    let total = math_round(formattable("formatDuration", minutes)?);
    let magnitude = total.abs();
    let days = (magnitude / per_day).floor();
    let within_day = magnitude % per_day;
    let hours = (within_day / 60.0).floor();
    let minutes_left = within_day % 60.0;
    let mut parts = Vec::new();
    for (count, unit) in [(days, "d"), (hours, "h"), (minutes_left, "m")] {
        if count != 0.0 {
            parts.push(format!("{}{unit}", es_number(count)));
        }
    }
    if parts.is_empty() {
        parts.push("0m".into());
    }
    Ok(format!("{}{}", if total < 0.0 { "-" } else { "" }, parts.join(" ")))
}

// --- time zones -------------------------------------------------------------

fn zone_arg(what: &str, value: Option<&CelValue>) -> Result<String, CatalogRefusal> {
    let zone = match value {
        None => "UTC".to_string(),
        Some(value) => text_of(what, value)?,
    };
    if !known_time_zone(&zone) {
        return refuse(format!("{what}: unknown IANA time zone {}", json_quote(&zone)));
    }
    Ok(zone)
}

// --- regular expressions ----------------------------------------------------

fn re2_flags(what: &str, flags: Option<&CelValue>) -> Result<Re2Flags, CatalogRefusal> {
    let mut bits = Re2Flags::NONE;
    let Some(flags) = flags else { return Ok(bits) };
    for letter in text_of(what, flags)?.chars() {
        if letter == 'g' {
            continue;
        }
        match RE2_FLAG_LETTERS.iter().find(|(held, _)| *held == letter) {
            Some((_, bit)) => bits = bits | *bit,
            None => {
                let supported: Vec<String> = RE2_FLAG_LETTERS.iter().map(|(held, _)| held.to_string()).collect();
                return refuse(format!("{what}: unknown regex flag '{letter}' (supported: {})", supported.join(", ")));
            }
        }
    }
    Ok(bits)
}

fn pattern_or_refusal(what: &str, written: &str, flags: Re2Flags) -> Result<Arc<Re2Program>, CatalogRefusal> {
    re2_pattern(written, flags).map_err(|refused| {
        CatalogRefusal::coded(
            format!("{what}: invalid RE2 pattern {}: {}", json_quote(written), refused.kind.as_str()),
            CelEvaluationCode::InvalidRegularExpression,
        )
    })
}

fn pattern(what: &str, source: &CelValue, flags: Option<&CelValue>) -> Result<Arc<Re2Program>, CatalogRefusal> {
    let bits = re2_flags(what, flags)?;
    let written = text_of(what, source)?;
    pattern_or_refusal(what, &written, bits)
}

fn strings(parts: Vec<String>) -> CelValue {
    CelValue::List(parts.into_iter().map(|part| CelValue::String(part.into())).collect())
}

fn first_match(what: &str, subject: &str, source: &CelValue, flags: Option<&CelValue>) -> Result<CelValue, CatalogRefusal> {
    let program = pattern(what, source, flags)?;
    let mut matcher = Re2Matcher::new(&program, subject);
    let found = if matcher.find() { matcher.group(0).unwrap_or("") } else { "" };
    Ok(CelValue::String(found.into()))
}

fn every_match(what: &str, subject: &str, source: &CelValue, flags: Option<&CelValue>) -> Result<CelValue, CatalogRefusal> {
    let program = pattern(what, source, flags)?;
    let mut matcher = Re2Matcher::new(&program, subject);
    let mut out = Vec::new();
    while matcher.find() {
        out.push(matcher.group(0).unwrap_or("").to_string());
    }
    Ok(strings(out))
}

fn match_groups(what: &str, subject: &str, source: &CelValue, flags: Option<&CelValue>) -> Result<CelValue, CatalogRefusal> {
    let program = pattern(what, source, flags)?;
    let mut matcher = Re2Matcher::new(&program, subject);
    if !matcher.find() {
        return Ok(CelValue::List(CelList::new()));
    }
    let count = matcher.group_count();
    let groups = (1..=count).map(|at| matcher.group(at).unwrap_or("").to_string()).collect();
    Ok(strings(groups))
}

// --- strings by UTF-16 code unit ----------------------------------------------

fn pair_cut(what: &str, offset: usize) -> CatalogRefusal {
    CatalogRefusal::new(format!("{what}: offset {offset} is inside a surrogate pair"))
}

/// The UTF-16 offset of the first cut between every two code units that falls inside a
/// pair: just after the high half of the first character outside the basic plane.
fn first_unit_cut_inside_pair(value: &str) -> Option<usize> {
    let mut units = 0;
    for character in value.chars() {
        if character.len_utf16() == 2 {
            return Some(units + 1);
        }
        units += 1;
    }
    None
}

/// `split` with an empty separator: one part per code unit.
fn split_units(value: &str) -> Result<CelValue, CatalogRefusal> {
    if let Some(offset) = first_unit_cut_inside_pair(value) {
        return Err(pair_cut("split", offset));
    }
    Ok(CelValue::List(value.chars().map(character_value).collect()))
}

/// Every one-character ASCII string, made once and shared, as a JavaScript engine shares them.
static ASCII_CHARACTERS: LazyLock<Vec<Arc<str>>> =
    LazyLock::new(|| (0u8..128).map(|byte| Arc::from(char::from(byte).to_string())).collect());

fn character_value(character: char) -> CelValue {
    match ASCII_CHARACTERS.get(character as usize) {
        Some(shared) => CelValue::String(Arc::clone(shared)),
        None => CelValue::String(character.to_string().into()),
    }
}

/// `replace`: the text split at every occurrence and joined around the replacement. An
/// empty search splits between code units, so the replacement goes between them only.
fn replaced(value: &str, search: &str, replacement: &str) -> Result<CelValue, CatalogRefusal> {
    if !search.is_empty() {
        return Ok(CelValue::String(value.replace(search, replacement).into()));
    }
    if let Some(offset) = first_unit_cut_inside_pair(value) {
        return Err(pair_cut("replace", offset));
    }
    let mut out = String::with_capacity(value.len() + replacement.len() * value.len());
    for (at, character) in value.chars().enumerate() {
        if at > 0 {
            out.push_str(replacement);
        }
        out.push(character);
    }
    Ok(CelValue::String(out.into()))
}

/// A relative index as `slice` resolves it: from the end where negative, clamped to the length.
fn resolved_index(index: i64, length: usize) -> usize {
    let length = length as i128;
    let index = i128::from(index);
    (if index < 0 { (length + index).max(0) } else { index.min(length) }) as usize
}

/// The byte offset of a UTF-16 offset, or nothing where it falls inside a pair.
fn byte_of_unit(value: &str, unit: usize) -> Option<usize> {
    let mut units = 0;
    for (byte, character) in value.char_indices() {
        if units == unit {
            return Some(byte);
        }
        units += character.len_utf16();
        if units > unit {
            return None;
        }
    }
    Some(value.len())
}

fn sliced(value: &CelValue, start: i64, end: i64) -> Result<CelValue, CatalogRefusal> {
    match value {
        CelValue::String(held) => {
            let length: usize = held.chars().map(char::len_utf16).sum();
            let (from, to) = (resolved_index(start, length), resolved_index(end, length));
            if from >= to {
                return Ok(CelValue::String("".into()));
            }
            let first = byte_of_unit(held, from).ok_or_else(|| pair_cut("slice", from))?;
            let last = byte_of_unit(held, to).ok_or_else(|| pair_cut("slice", to))?;
            Ok(CelValue::String(held[first..last].into()))
        }
        CelValue::Bytes(held) => {
            let (from, to) = (resolved_index(start, held.len()), resolved_index(end, held.len()));
            Ok(CelValue::Bytes(if from < to { held[from..to].into() } else { Arc::from(&[][..]) }))
        }
        CelValue::List(items) => {
            let (from, to) = (resolved_index(start, items.len()), resolved_index(end, items.len()));
            Ok(CelValue::List(if from < to { items[from..to].iter().cloned().collect() } else { CelList::new() }))
        }
        other => refuse(format!("slice: expected a string, bytes or a list, got {}", type_name(other))),
    }
}

// --- base64 and JSON --------------------------------------------------------

const BASE64_ALPHABET: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Base64 to bytes: line breaks, tabs and spaces dropped, the URL-safe alphabet read, the
/// trailing padding optional, and a character outside the alphabet refused. The length
/// rule is judged on code units and the characters by code point, as Node judges them.
fn bytes_from_base64(input: &str) -> Result<CelValue, CatalogRefusal> {
    let mut clean: String = input
        .chars()
        .filter(|character| !matches!(character, '\r' | '\n' | '\t' | ' '))
        .map(|character| match character {
            '-' => '+',
            '_' => '/',
            other => other,
        })
        .collect();
    let kept = clean.trim_end_matches('=').len();
    clean.truncate(kept);
    let units: usize = clean.chars().map(char::len_utf16).sum();
    if units % 4 == 1 {
        return refuse("bytesFromBase64: input length is not valid base64");
    }
    let mut out = Vec::with_capacity(units * 3 / 4);
    let mut bits = 0;
    let mut accumulated: u32 = 0;
    for character in clean.chars() {
        let Some(value) = BASE64_ALPHABET.find(character) else {
            return refuse(format!("bytesFromBase64: '{character}' is not a base64 character"));
        };
        accumulated = (accumulated << 6) | value as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((accumulated >> bits) as u8);
        }
    }
    Ok(CelValue::Bytes(out.into()))
}

fn parse_json_text(written: &str) -> Result<CelValue, CatalogRefusal> {
    match read_json_text(written) {
        Ok(parsed) => Ok(json_as_cel_value(&parsed)),
        Err(JsonTextError::NotJson(refusal)) => Err(CatalogRefusal::coded(
            format!(
                "parseJson: invalid JSON at offset {}{}",
                refusal.offset,
                if refusal.end_of_input { " (unexpected end of input)" } else { "" }
            ),
            CelEvaluationCode::InvalidConversion,
        )),
        Err(JsonTextError::UnpairedSurrogate { offset }) => {
            refuse(format!("parseJson: unpaired surrogate at offset {offset}"))
        }
    }
}

// --- collections ------------------------------------------------------------

fn smallest(values: &[CelValue], want_smallest: bool) -> CelValue {
    let Some(first) = values.first() else { return CelValue::Null };
    let mut best = first;
    let mut best_number = number_of(first);
    for held in values {
        let number = number_of(held);
        if if want_smallest { number < best_number } else { number > best_number } {
            best = held;
            best_number = number;
        }
    }
    best.clone()
}

/// The order of two strings by UTF-16 code unit, decided at their first differing character.
fn code_unit_order(left: &str, right: &str) -> Ordering {
    let common = left.bytes().zip(right.bytes()).take_while(|(a, b)| a == b).count();
    let mut at = common;
    while !left.is_char_boundary(at) {
        at -= 1;
    }
    let units = |character: char| {
        let mut buffer = [0u16; 2];
        let written = character.encode_utf16(&mut buffer);
        (written[0], written.get(1).copied().unwrap_or(0))
    };
    match (left[at..].chars().next(), right[at..].chars().next()) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Less,
        (Some(_), None) => Ordering::Greater,
        (Some(a), Some(b)) => units(a).cmp(&units(b)),
    }
}

/// A sorted copy: numerically where the first element is a number, else by text, by V8's
/// TimSort. A text is computed when a comparison first needs it, so the first refusal is
/// the one Node's comparator throws.
fn sorted(what: &str, values: &[CelValue]) -> Result<CelValue, CatalogRefusal> {
    let numeric = matches!(values.first(), Some(CelValue::Double(_) | CelValue::Int(_) | CelValue::Uint(_)));
    let mut order: Vec<usize> = (0..values.len()).collect();
    if numeric {
        let numbers: Vec<f64> = values.iter().map(number_of).collect();
        tim_sort(&mut order, |left, right| {
            let difference = numbers[left] - numbers[right];
            Ok::<_, CatalogRefusal>(if difference < 0.0 {
                Ordering::Less
            } else if difference > 0.0 {
                Ordering::Greater
            } else {
                Ordering::Equal
            })
        })?;
    } else {
        let mut texts: Vec<Option<String>> = vec![None; values.len()];
        tim_sort(&mut order, |left, right| -> Result<Ordering, CatalogRefusal> {
            if texts[left].is_none() {
                texts[left] = Some(text_of(what, &values[left])?);
            }
            if texts[right].is_none() {
                texts[right] = Some(text_of(what, &values[right])?);
            }
            Ok(code_unit_order(texts[left].as_deref().unwrap_or(""), texts[right].as_deref().unwrap_or("")))
        })?;
    }
    Ok(CelValue::List(order.into_iter().map(|at| values[at].clone()).collect()))
}

const MIN_GALLOP: usize = 7;

/// V8's `Array.prototype.sort`, comparison for comparison (`third_party/v8/builtins/array-sort.tq`,
/// a port of CPython's listsort): runs found and extended by binary insertion to the minimum
/// run, merged under the stack invariants, galloping past an adaptive threshold. `compare`
/// answers `Less` where V8's comparator answers a negative number.
fn tim_sort<E>(work: &mut [usize], compare: impl FnMut(usize, usize) -> Result<Ordering, E>) -> Result<(), E> {
    let length = work.len();
    if length < 2 {
        return Ok(());
    }
    let mut sort = TimSort { work, temp: Vec::new(), runs: Vec::new(), min_gallop: MIN_GALLOP, compare };
    let min_run = {
        let mut n = length;
        let mut r = 0;
        while n >= 64 {
            r |= n & 1;
            n >>= 1;
        }
        n + r
    };
    let mut low = 0;
    let mut remaining = length;
    while remaining != 0 {
        let mut run = sort.count_and_make_run(low, low + remaining)?;
        if run < min_run {
            let forced = min_run.min(remaining);
            sort.binary_insertion_sort(low, low + run, low + forced)?;
            run = forced;
        }
        sort.runs.push((low, run));
        sort.merge_collapse()?;
        low += run;
        remaining -= run;
    }
    while sort.runs.len() > 1 {
        let mut n = sort.runs.len() - 2;
        if n > 0 && sort.runs[n - 1].1 < sort.runs[n + 1].1 {
            n -= 1;
        }
        sort.merge_at(n)?;
    }
    Ok(())
}

struct TimSort<'w, C> {
    work: &'w mut [usize],
    temp: Vec<usize>,
    runs: Vec<(usize, usize)>,
    min_gallop: usize,
    compare: C,
}

/// Which array a gallop searches.
#[derive(Clone, Copy)]
enum Side {
    Work,
    Temp,
}

impl<E, C: FnMut(usize, usize) -> Result<Ordering, E>> TimSort<'_, C> {
    fn less(&mut self, left: usize, right: usize) -> Result<bool, E> {
        Ok((self.compare)(left, right)? == Ordering::Less)
    }

    fn at(&self, side: Side, index: usize) -> usize {
        match side {
            Side::Work => self.work[index],
            Side::Temp => self.temp[index],
        }
    }

    fn count_and_make_run(&mut self, low_arg: usize, high: usize) -> Result<usize, E> {
        let low = low_arg + 1;
        if low == high {
            return Ok(1);
        }
        let mut run = 2;
        let element_low = self.work[low];
        let descending = self.less(element_low, self.work[low - 1])?;
        let mut previous = element_low;
        for index in low + 1..high {
            let current = self.work[index];
            let order_less = self.less(current, previous)?;
            if descending {
                if !order_less {
                    break;
                }
            } else if order_less {
                break;
            }
            previous = current;
            run += 1;
        }
        if descending {
            self.work[low_arg..low_arg + run].reverse();
        }
        Ok(run)
    }

    fn binary_insertion_sort(&mut self, low: usize, start_arg: usize, high: usize) -> Result<(), E> {
        let mut start = if low == start_arg { start_arg + 1 } else { start_arg };
        while start < high {
            let mut left = low;
            let mut right = start;
            let pivot = self.work[start];
            while left < right {
                let middle = left + ((right - left) >> 1);
                if self.less(pivot, self.work[middle])? {
                    right = middle;
                } else {
                    left = middle + 1;
                }
            }
            self.work.copy_within(left..start, left + 1);
            self.work[left] = pivot;
            start += 1;
        }
        Ok(())
    }

    fn run_invariant_established(&self, n: usize) -> bool {
        if n < 2 {
            return true;
        }
        self.runs[n - 2].1 > self.runs[n - 1].1 + self.runs[n].1
    }

    fn merge_collapse(&mut self) -> Result<(), E> {
        while self.runs.len() > 1 {
            let mut n = self.runs.len() - 2;
            if !self.run_invariant_established(n + 1) || !self.run_invariant_established(n) {
                if self.runs[n - 1].1 < self.runs[n + 1].1 {
                    n -= 1;
                }
                self.merge_at(n)?;
            } else if self.runs[n].1 <= self.runs[n + 1].1 {
                self.merge_at(n)?;
            } else {
                break;
            }
        }
        Ok(())
    }

    fn merge_at(&mut self, i: usize) -> Result<(), E> {
        let (mut base_a, mut length_a) = self.runs[i];
        let (base_b, mut length_b) = self.runs[i + 1];
        self.runs[i].1 = length_a + length_b;
        self.runs.remove(i + 1);
        let key_right = self.work[base_b];
        let k = self.gallop_right(Side::Work, key_right, base_a, length_a, 0)?;
        base_a += k;
        length_a -= k;
        if length_a == 0 {
            return Ok(());
        }
        let key_left = self.work[base_a + length_a - 1];
        length_b = self.gallop_left(Side::Work, key_left, base_b, length_b, length_b - 1)?;
        if length_b == 0 {
            return Ok(());
        }
        if length_a <= length_b {
            self.merge_low(base_a, length_a, base_b, length_b)
        } else {
            self.merge_high(base_a, length_a, base_b, length_b)
        }
    }

    fn gallop_left(&mut self, side: Side, key: usize, base: usize, length: usize, hint: usize) -> Result<usize, E> {
        let mut last_ofs: isize = 0;
        let mut offset: isize = 1;
        let hint_i = hint as isize;
        let base_hint = self.at(side, base + hint);
        if self.less(base_hint, key)? {
            let max_ofs = (length - hint) as isize;
            while offset < max_ofs {
                let element = self.at(side, base + hint + offset as usize);
                if !self.less(element, key)? {
                    break;
                }
                last_ofs = offset;
                offset = (offset << 1) + 1;
            }
            offset = offset.min(max_ofs);
            last_ofs += hint_i;
            offset += hint_i;
        } else {
            let max_ofs = hint_i + 1;
            while offset < max_ofs {
                let element = self.at(side, base + (hint_i - offset) as usize);
                if self.less(element, key)? {
                    break;
                }
                last_ofs = offset;
                offset = (offset << 1) + 1;
            }
            offset = offset.min(max_ofs);
            let tmp = last_ofs;
            last_ofs = hint_i - offset;
            offset = hint_i - tmp;
        }
        last_ofs += 1;
        while last_ofs < offset {
            let middle = last_ofs + ((offset - last_ofs) >> 1);
            let element = self.at(side, base + middle as usize);
            if self.less(element, key)? {
                last_ofs = middle + 1;
            } else {
                offset = middle;
            }
        }
        Ok(offset as usize)
    }

    fn gallop_right(&mut self, side: Side, key: usize, base: usize, length: usize, hint: usize) -> Result<usize, E> {
        let mut last_ofs: isize = 0;
        let mut offset: isize = 1;
        let hint_i = hint as isize;
        let base_hint = self.at(side, base + hint);
        if self.less(key, base_hint)? {
            let max_ofs = hint_i + 1;
            while offset < max_ofs {
                let element = self.at(side, base + (hint_i - offset) as usize);
                if !self.less(key, element)? {
                    break;
                }
                last_ofs = offset;
                offset = (offset << 1) + 1;
            }
            offset = offset.min(max_ofs);
            let tmp = last_ofs;
            last_ofs = hint_i - offset;
            offset = hint_i - tmp;
        } else {
            let max_ofs = (length - hint) as isize;
            while offset < max_ofs {
                let element = self.at(side, base + hint + offset as usize);
                if self.less(key, element)? {
                    break;
                }
                last_ofs = offset;
                offset = (offset << 1) + 1;
            }
            offset = offset.min(max_ofs);
            last_ofs += hint_i;
            offset += hint_i;
        }
        last_ofs += 1;
        while last_ofs < offset {
            let middle = last_ofs + ((offset - last_ofs) >> 1);
            let element = self.at(side, base + middle as usize);
            if self.less(key, element)? {
                offset = middle;
            } else {
                last_ofs = middle + 1;
            }
        }
        Ok(offset as usize)
    }

    fn merge_low(&mut self, base_a: usize, length_a: usize, base_b: usize, length_b: usize) -> Result<(), E> {
        let (mut length_a, mut length_b) = (length_a, length_b);
        self.temp.clear();
        self.temp.extend_from_slice(&self.work[base_a..base_a + length_a]);
        let mut dest = base_a;
        let mut cursor_temp = 0;
        let mut cursor_b = base_b;
        self.work[dest] = self.work[cursor_b];
        dest += 1;
        cursor_b += 1;
        enum End {
            Succeed,
            CopyB,
        }
        let end = 'merge: {
            length_b -= 1;
            if length_b == 0 {
                break 'merge End::Succeed;
            }
            if length_a == 1 {
                break 'merge End::CopyB;
            }
            let mut min_gallop = self.min_gallop;
            loop {
                let mut wins_a = 0;
                let mut wins_b = 0;
                loop {
                    if self.less(self.work[cursor_b], self.temp[cursor_temp])? {
                        self.work[dest] = self.work[cursor_b];
                        dest += 1;
                        cursor_b += 1;
                        wins_b += 1;
                        length_b -= 1;
                        wins_a = 0;
                        if length_b == 0 {
                            break 'merge End::Succeed;
                        }
                        if wins_b >= min_gallop {
                            break;
                        }
                    } else {
                        self.work[dest] = self.temp[cursor_temp];
                        dest += 1;
                        cursor_temp += 1;
                        wins_a += 1;
                        length_a -= 1;
                        wins_b = 0;
                        if length_a == 1 {
                            break 'merge End::CopyB;
                        }
                        if wins_a >= min_gallop {
                            break;
                        }
                    }
                }
                min_gallop += 1;
                let mut first = true;
                while wins_a >= MIN_GALLOP || wins_b >= MIN_GALLOP || first {
                    first = false;
                    min_gallop = min_gallop.saturating_sub(1).max(1);
                    self.min_gallop = min_gallop;
                    let key = self.work[cursor_b];
                    wins_a = self.gallop_right(Side::Temp, key, cursor_temp, length_a, 0)?;
                    if wins_a > 0 {
                        self.work[dest..dest + wins_a].copy_from_slice(&self.temp[cursor_temp..cursor_temp + wins_a]);
                        dest += wins_a;
                        cursor_temp += wins_a;
                        length_a -= wins_a;
                        if length_a == 1 {
                            break 'merge End::CopyB;
                        }
                        if length_a == 0 {
                            break 'merge End::Succeed;
                        }
                    }
                    self.work[dest] = self.work[cursor_b];
                    dest += 1;
                    cursor_b += 1;
                    length_b -= 1;
                    if length_b == 0 {
                        break 'merge End::Succeed;
                    }
                    let key = self.temp[cursor_temp];
                    wins_b = self.gallop_left(Side::Work, key, cursor_b, length_b, 0)?;
                    if wins_b > 0 {
                        self.work.copy_within(cursor_b..cursor_b + wins_b, dest);
                        dest += wins_b;
                        cursor_b += wins_b;
                        length_b -= wins_b;
                        if length_b == 0 {
                            break 'merge End::Succeed;
                        }
                    }
                    self.work[dest] = self.temp[cursor_temp];
                    dest += 1;
                    cursor_temp += 1;
                    length_a -= 1;
                    if length_a == 1 {
                        break 'merge End::CopyB;
                    }
                }
                min_gallop += 1;
                self.min_gallop = min_gallop;
            }
        };
        match end {
            End::Succeed => {
                if length_a > 0 {
                    self.work[dest..dest + length_a].copy_from_slice(&self.temp[cursor_temp..cursor_temp + length_a]);
                }
            }
            End::CopyB => {
                self.work.copy_within(cursor_b..cursor_b + length_b, dest);
                self.work[dest + length_b] = self.temp[cursor_temp];
            }
        }
        Ok(())
    }

    fn merge_high(&mut self, base_a: usize, length_a: usize, base_b: usize, length_b: usize) -> Result<(), E> {
        let (mut length_a, mut length_b) = (length_a as isize, length_b as isize);
        self.temp.clear();
        self.temp.extend_from_slice(&self.work[base_b..base_b + length_b as usize]);
        let base_a_i = base_a as isize;
        let mut dest: isize = base_b as isize + length_b - 1;
        let mut cursor_temp: isize = length_b - 1;
        let mut cursor_a: isize = base_a_i + length_a - 1;
        self.work[dest as usize] = self.work[cursor_a as usize];
        dest -= 1;
        cursor_a -= 1;
        enum End {
            Succeed,
            CopyA,
        }
        let end = 'merge: {
            length_a -= 1;
            if length_a == 0 {
                break 'merge End::Succeed;
            }
            if length_b == 1 {
                break 'merge End::CopyA;
            }
            let mut min_gallop = self.min_gallop;
            loop {
                let mut wins_a: isize = 0;
                let mut wins_b: isize = 0;
                loop {
                    if self.less(self.temp[cursor_temp as usize], self.work[cursor_a as usize])? {
                        self.work[dest as usize] = self.work[cursor_a as usize];
                        dest -= 1;
                        cursor_a -= 1;
                        wins_a += 1;
                        length_a -= 1;
                        wins_b = 0;
                        if length_a == 0 {
                            break 'merge End::Succeed;
                        }
                        if wins_a >= min_gallop as isize {
                            break;
                        }
                    } else {
                        self.work[dest as usize] = self.temp[cursor_temp as usize];
                        dest -= 1;
                        cursor_temp -= 1;
                        wins_b += 1;
                        length_b -= 1;
                        wins_a = 0;
                        if length_b == 1 {
                            break 'merge End::CopyA;
                        }
                        if wins_b >= min_gallop as isize {
                            break;
                        }
                    }
                }
                min_gallop += 1;
                let mut first = true;
                while wins_a >= MIN_GALLOP as isize || wins_b >= MIN_GALLOP as isize || first {
                    first = false;
                    min_gallop = min_gallop.saturating_sub(1).max(1);
                    self.min_gallop = min_gallop;
                    let key = self.temp[cursor_temp as usize];
                    let k = self.gallop_right(Side::Work, key, base_a, length_a as usize, length_a as usize - 1)? as isize;
                    wins_a = length_a - k;
                    if wins_a > 0 {
                        dest -= wins_a;
                        cursor_a -= wins_a;
                        let from = (cursor_a + 1) as usize;
                        self.work.copy_within(from..from + wins_a as usize, (dest + 1) as usize);
                        length_a -= wins_a;
                        if length_a == 0 {
                            break 'merge End::Succeed;
                        }
                    }
                    self.work[dest as usize] = self.temp[cursor_temp as usize];
                    dest -= 1;
                    cursor_temp -= 1;
                    length_b -= 1;
                    if length_b == 1 {
                        break 'merge End::CopyA;
                    }
                    let key = self.work[cursor_a as usize];
                    let k = self.gallop_left(Side::Temp, key, 0, length_b as usize, length_b as usize - 1)? as isize;
                    wins_b = length_b - k;
                    if wins_b > 0 {
                        dest -= wins_b;
                        cursor_temp -= wins_b;
                        let from = (cursor_temp + 1) as usize;
                        let to = (dest + 1) as usize;
                        let moved = wins_b as usize;
                        self.work[to..to + moved].copy_from_slice(&self.temp[from..from + moved]);
                        length_b -= wins_b;
                        if length_b == 1 {
                            break 'merge End::CopyA;
                        }
                        if length_b == 0 {
                            break 'merge End::Succeed;
                        }
                    }
                    self.work[dest as usize] = self.work[cursor_a as usize];
                    dest -= 1;
                    cursor_a -= 1;
                    length_a -= 1;
                    if length_a == 0 {
                        break 'merge End::Succeed;
                    }
                }
                min_gallop += 1;
                self.min_gallop = min_gallop;
            }
        };
        match end {
            End::Succeed => {
                if length_b > 0 {
                    let to = (dest - (length_b - 1)) as usize;
                    let moved = length_b as usize;
                    self.work[to..to + moved].copy_from_slice(&self.temp[..moved]);
                }
            }
            End::CopyA => {
                dest -= length_a;
                cursor_a -= length_a;
                let from = (cursor_a + 1) as usize;
                self.work.copy_within(from..from + length_a as usize, (dest + 1) as usize);
                self.work[dest as usize] = self.temp[cursor_temp as usize];
            }
        }
        Ok(())
    }
}

// --- distinct ---------------------------------------------------------------

fn hashed(tag: u8, value: impl Hash) -> u64 {
    let mut hasher = DefaultHasher::new();
    tag.hash(&mut hasher);
    value.hash(&mut hasher);
    hasher.finish()
}

fn mixed(accumulated: u64, next: u64) -> u64 {
    (accumulated ^ next).wrapping_mul(0x9e37_79b9_7f4a_7c15).rotate_left(29)
}

/// A number's hash by its value as a double, the one comparison CEL equality makes across
/// the numeric types; nothing for NaN, which equals nothing.
fn number_hash(number: f64) -> Option<u64> {
    if number.is_nan() {
        return None;
    }
    Some(hashed(1, if number == 0.0 { 0 } else { number.to_bits() }))
}

/// The hash of a value that is not a container, or nothing where it equals nothing.
fn scalar_hash(value: &CelValue) -> Option<u64> {
    match value {
        CelValue::Null => Some(hashed(0, 0u8)),
        CelValue::Int(held) => number_hash(*held as f64),
        CelValue::Uint(held) => number_hash(*held as f64),
        CelValue::Double(held) => number_hash(*held),
        CelValue::Bool(held) => Some(hashed(2, held)),
        CelValue::String(held) => Some(hashed(3, &**held)),
        CelValue::Bytes(held) => Some(hashed(4, &**held)),
        CelValue::Timestamp(held) => Some(hashed(5, timestamp_nanos(*held))),
        CelValue::Duration(held) => Some(hashed(6, duration_nanos(*held))),
        CelValue::Type(held) => Some(hashed(7, held.name())),
        other => Some(hashed(8, cel_type_name_of(other))),
    }
}

const LIST_TAG: u64 = 0x6c69_7374;
const MAP_TAG: u64 = 0x6d61_70;
const PRESENT_TAG: u64 = 0x736f_6d65;
const ABSENT_TAG: u64 = 0x6e6f_6e65;

enum HashFrame<'a> {
    List { items: &'a [CelValue], at: usize, accumulated: u64 },
    Map { entries: Vec<(u64, &'a CelValue)>, at: usize, accumulated: u64 },
    Present,
}

/// A hash CEL equality agrees with — two values it calls equal hash alike — or nothing for
/// a value holding a NaN, which equals nothing. A list hashes in order, a map's entries in
/// any order, a map and a record holding the same pairs alike. Walked on a work list.
fn equality_hash<'a>(value: &'a CelValue) -> Option<u64> {
    let mut frames: Vec<HashFrame<'a>> = Vec::new();
    let mut pending: Option<&'a CelValue> = Some(value);
    let mut finished: Option<u64> = None;
    loop {
        if let Some(value) = pending.take() {
            match value {
                CelValue::List(items) => {
                    frames.push(HashFrame::List { items: items.as_slice(), at: 0, accumulated: LIST_TAG })
                }
                CelValue::Map(map) => frames.push(HashFrame::Map {
                    entries: map
                        .iter()
                        .map(|(key, value)| (map_key_identity(key).map_or(0, |identity| hashed(9, identity)), value))
                        .collect(),
                    at: 0,
                    accumulated: MAP_TAG,
                }),
                CelValue::Record(record) => frames.push(HashFrame::Map {
                    entries: record
                        .iter()
                        .map(|(key, value)| (hashed(9, CelMapKey::String(key.into())), value))
                        .collect(),
                    at: 0,
                    accumulated: MAP_TAG,
                }),
                CelValue::Optional(optional) => match optional.held() {
                    Some(held) => {
                        frames.push(HashFrame::Present);
                        pending = Some(held);
                        continue;
                    }
                    None => finished = Some(ABSENT_TAG),
                },
                scalar => finished = Some(scalar_hash(scalar)?),
            }
        }
        let Some(top) = frames.last_mut() else {
            return finished;
        };
        if let Some(hash) = finished.take() {
            match top {
                HashFrame::List { accumulated, .. } => *accumulated = mixed(*accumulated, hash),
                HashFrame::Map { entries, at, accumulated } => {
                    *accumulated = accumulated.wrapping_add(mixed(entries[*at - 1].0, hash))
                }
                HashFrame::Present => {
                    frames.pop();
                    finished = Some(mixed(PRESENT_TAG, hash));
                    continue;
                }
            }
        }
        match top {
            HashFrame::List { items, at, accumulated } => {
                let items: &'a [CelValue] = items;
                if let Some(item) = items.get(*at) {
                    *at += 1;
                    pending = Some(item);
                } else {
                    finished = Some(mixed(*accumulated, items.len() as u64));
                    frames.pop();
                }
            }
            HashFrame::Map { entries, at, accumulated } => {
                if let Some(&(_, value)) = entries.get(*at) {
                    *at += 1;
                    pending = Some(value);
                } else {
                    finished = Some(mixed(*accumulated, entries.len() as u64));
                    frames.pop();
                }
            }
            HashFrame::Present => unreachable!("a present optional's frame is left once its value is hashed"),
        }
    }
}

/// A hasher for keys that are already hashes.
#[derive(Default)]
struct HashedKey(u64);

impl Hasher for HashedKey {
    fn finish(&self) -> u64 {
        self.0
    }

    fn write(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.0 = self.0.rotate_left(8) ^ u64::from(byte);
        }
    }

    fn write_u64(&mut self, value: u64) {
        self.0 = value;
    }
}

/// Duplicates removed by CEL equality: a value is dropped exactly when a value already kept
/// equals it, looked for only among the kept values of its hash, each hash's kept values
/// chained through the list of them.
fn distinct(values: &[CelValue]) -> CelValue {
    let mut kept: Vec<CelValue> = Vec::new();
    // For each kept value, the kept value before it of the same hash.
    let mut earlier: Vec<Option<usize>> = Vec::new();
    let mut latest: HashMap<u64, usize, BuildHasherDefault<HashedKey>> = HashMap::default();
    for held in values {
        let Some(hash) = equality_hash(held) else {
            kept.push(held.clone());
            earlier.push(None);
            continue;
        };
        let head = latest.get(&hash).copied();
        let mut at = head;
        let mut found = false;
        while let Some(index) = at {
            if cel_equal(&kept[index], held) {
                found = true;
                break;
            }
            at = earlier[index];
        }
        if found {
            continue;
        }
        latest.insert(hash, kept.len());
        earlier.push(head);
        kept.push(held.clone());
    }
    CelValue::List(kept.into())
}

fn compacted(value: &CelValue) -> Result<CelValue, CatalogRefusal> {
    let keep = |held: &CelValue| !matches!(held, CelValue::Null) && !matches!(held, CelValue::String(text) if text.is_empty());
    if let CelValue::List(items) = value {
        return Ok(CelValue::List(items.iter().filter(|held| keep(held)).cloned().collect()));
    }
    let entries = map_entries("compact", value)?.into_iter().filter(|(_, held)| keep(held)).collect();
    map_of_entries("compact", value, entries)
}

fn range_of(count: i64) -> Result<CelValue, CatalogRefusal> {
    const MAX_ARRAY_LENGTH: i64 = 4_294_967_295;
    if count > MAX_ARRAY_LENGTH {
        return refuse(format!("range: count must be at most 4294967295, got {count}"));
    }
    let length = count.max(0) as usize;
    let mut items: Vec<CelValue> = Vec::new();
    if items.try_reserve_exact(length).is_err() {
        return refuse(format!("range: a list of {length} elements is more than this process can allocate"));
    }
    items.extend((0..length as i64).map(CelValue::Int));
    Ok(CelValue::List(items.into()))
}

// --- the table --------------------------------------------------------------

type Own = fn(&[CelValue]) -> Outcome;

fn string_value(text: impl Into<Arc<str>>) -> Outcome {
    Ok(CelValue::String(text.into()))
}

fn round_to(value: &CelValue, digits: &CelValue) -> Outcome {
    let number = formattable("round", value)?;
    let count = digit_count("round", digits)?;
    Ok(CelValue::Double(es_string_to_number(&to_fixed(number, count))))
}

fn fixed_text(value: &CelValue, digits: &CelValue) -> Outcome {
    let count = digit_count("fixed", digits)?;
    let formatter = formatter("fixed", &CelValue::String(format!(".{count}f").into()))?;
    let number = formattable("fixed", value)?;
    string_value(formatted("fixed", &formatter, number)?)
}

fn format_text(value: &CelValue, specifier: &CelValue) -> Outcome {
    let formatter = formatter("format", specifier)?;
    let number = formattable("format", value)?;
    string_value(formatted("format", &formatter, number)?)
}

fn date_in(args: &[CelValue]) -> Outcome {
    let millis = millis_of(instant_arg("dateIn", &args[0])?);
    let zone = zone_arg("dateIn", args.get(1))?;
    string_value(date_text_in(millis, &zone).ok_or_else(|| outside_range("dateIn"))?)
}

fn iso_in(args: &[CelValue]) -> Outcome {
    let millis = millis_of(instant_arg("isoIn", &args[0])?);
    let zone = zone_arg("isoIn", args.get(1))?;
    string_value(iso_text_in(millis, &zone).ok_or_else(|| outside_range("isoIn"))?)
}

fn start_of_month(args: &[CelValue]) -> Outcome {
    let zone = zone_arg("startOfMonth", args.get(1))?;
    let millis = millis_of(instant_arg("startOfMonth", &args[0])?);
    let fields = civil_time_in(millis, &zone).ok_or_else(|| outside_range("startOfMonth"))?;
    let first = CivilTime { day: 1, hour: 0, minute: 0, second: 0, ..fields };
    Ok(instant_of_millis("startOfMonth", instant_of_civil_time(&first, &zone))?)
}

fn add_months(args: &[CelValue]) -> Outcome {
    let months = integer(&args[1])?;
    let zone = zone_arg("addMonths", args.get(2))?;
    let millis = millis_of(instant_arg("addMonths", &args[0])?);
    let fields = civil_time_in(millis, &zone).ok_or_else(|| outside_range("addMonths"))?;
    // Node's number arithmetic: the month count is a double, and `%` takes the dividend's sign.
    let shifted = fields.year as f64 * 12.0 + (fields.month - 1) as f64 + months as f64;
    let year = (shifted / 12.0).floor();
    let month = ((shifted % 12.0) + 12.0) % 12.0 + 1.0;
    let (year, month) = (year as i64, month as i64);
    let last = days_in_month(year, month).ok_or_else(|| outside_range("addMonths"))?;
    let target = CivilTime { year, month, day: fields.day.min(last), ..fields };
    Ok(instant_of_millis("addMonths", instant_of_civil_time(&target, &zone))?)
}

fn random(name: &str, made: Result<String, crate::host_random::RandomSourceUnavailable>) -> Outcome {
    made.map(|text| CelValue::String(text.into())).map_err(|_| {
        Failure::Refused(CatalogRefusal::coded(
            format!("{name}() needs the host's random source, which is unavailable here"),
            CelEvaluationCode::UnboundFunction,
        ))
    })
}

fn named_uuid(name: &str, made: Result<String, crate::uuid::InvalidUuid>, namespace: &str) -> Outcome {
    made.map(|text| CelValue::String(text.into()))
        .map_err(|_| Failure::Refused(CatalogRefusal::new(format!("{name}: invalid namespace UUID {}", json_quote(namespace)))))
}

/// The implementations needing nothing of the host, by dispatch key, in Node's order.
const OWN: [(&str, Own); 77] = [
    // collections
    ("join(list<dyn>, string)", |args| {
        arity(args, 2)?;
        let separator = text(&args[1])?;
        let items = list("join", &args[0])?;
        let parts = items.iter().map(|held| text_of("join", held)).collect::<Result<Vec<_>, _>>()?;
        string_value(parts.join(separator))
    }),
    ("keys(map<dyn, dyn>)", |args| {
        arity(args, 1)?;
        Ok(CelValue::List(map_entries("keys", &args[0])?.into_iter().map(|(key, _)| key).collect()))
    }),
    ("values(map<dyn, dyn>)", |args| {
        arity(args, 1)?;
        Ok(CelValue::List(map_entries("values", &args[0])?.into_iter().map(|(_, value)| value).collect()))
    }),
    ("distinct(list<dyn>)", |args| {
        arity(args, 1)?;
        Ok(distinct(list("distinct", &args[0])?))
    }),
    ("reverse(list<dyn>)", |args| {
        arity(args, 1)?;
        Ok(CelValue::List(list("reverse", &args[0])?.iter().rev().cloned().collect()))
    }),
    ("flatten(list<dyn>)", |args| {
        arity(args, 1)?;
        let mut out = Vec::new();
        for held in list("flatten", &args[0])?.iter() {
            match held {
                CelValue::List(inner) => out.extend(inner.iter().cloned()),
                other => out.push(other.clone()),
            }
        }
        Ok(CelValue::List(out.into()))
    }),
    ("sort(list<dyn>)", |args| {
        arity(args, 1)?;
        Ok(sorted("sort", list("sort", &args[0])?)?)
    }),
    ("range(int)", |args| {
        arity(args, 1)?;
        Ok(range_of(integer(&args[0])?)?)
    }),
    ("enumerate(list<dyn>)", |args| {
        arity(args, 1)?;
        let items = list("enumerate", &args[0])?;
        Ok(CelValue::List(
            items
                .iter()
                .enumerate()
                .map(|(at, value)| {
                    let mut entry = CelRecord::new();
                    entry.insert("index", CelValue::Int(at as i64));
                    entry.insert("value", value.clone());
                    CelValue::Record(entry)
                })
                .collect(),
        ))
    }),
    ("compact(list<dyn>)", |args| {
        arity(args, 1)?;
        Ok(compacted(&args[0])?)
    }),
    ("compact(map<dyn, dyn>)", |args| {
        arity(args, 1)?;
        Ok(compacted(&args[0])?)
    }),
    ("merge(map<dyn, dyn>, map<dyn, dyn>)", |args| {
        arity(args, 2)?;
        let mut pairs = map_entries("merge", &args[0])?;
        pairs.extend(map_entries("merge", &args[1])?);
        Ok(map_of_entries("merge", &args[0], pairs)?)
    }),
    // One body over the three: a `dyn` receiver reaches whichever resolved, so the value decides.
    ("slice(bytes, int, int)", |args| slice_call(args)),
    ("slice(string, int, int)", |args| slice_call(args)),
    ("slice(list<dyn>, int, int)", |args| slice_call(args)),
    // strings
    ("lower(string)", |args| {
        arity(args, 1)?;
        string_value(es_to_lower_case(text(&args[0])?))
    }),
    ("upper(string)", |args| {
        arity(args, 1)?;
        string_value(es_to_upper_case(text(&args[0])?))
    }),
    ("trim(string)", |args| {
        arity(args, 1)?;
        string_value(es_trim(text(&args[0])?))
    }),
    ("replace(string, string, string)", |args| {
        arity(args, 3)?;
        Ok(replaced(text(&args[0])?, text(&args[1])?, text(&args[2])?)?)
    }),
    ("split(string, string)", |args| {
        arity(args, 2)?;
        let (value, separator) = (text(&args[0])?, text(&args[1])?);
        if separator.is_empty() {
            return Ok(split_units(value)?);
        }
        Ok(CelValue::List(value.split(separator).map(|part| CelValue::String(part.into())).collect()))
    }),
    ("trimPrefix(string, string)", |args| {
        arity(args, 2)?;
        let value = text(&args[0])?;
        string_value(value.strip_prefix(text(&args[1])?).unwrap_or(value))
    }),
    ("trimSuffix(string, string)", |args| {
        arity(args, 2)?;
        let (value, suffix) = (text(&args[0])?, text(&args[1])?);
        string_value(if suffix.is_empty() { value } else { value.strip_suffix(suffix).unwrap_or(value) })
    }),
    ("regexReplace(string, string, string)", |args| {
        arity(args, 3)?;
        let (subject, replacement) = (text(&args[0])?, text(&args[2])?);
        let program = pattern("regexReplace", &args[1], None)?;
        string_value(replace_all(&program, subject, replacement))
    }),
    ("regexReplace(string, string, string, string)", |args| {
        arity(args, 4)?;
        let (subject, replacement) = (text(&args[0])?, text(&args[2])?);
        let program = pattern("regexReplace", &args[1], Some(&args[3]))?;
        string_value(replace_all(&program, subject, replacement))
    }),
    ("regexExtract(string, string)", |args| {
        arity(args, 2)?;
        Ok(first_match("regexExtract", text(&args[0])?, &args[1], None)?)
    }),
    ("regexExtract(string, string, string)", |args| {
        arity(args, 3)?;
        Ok(first_match("regexExtract", text(&args[0])?, &args[1], Some(&args[2]))?)
    }),
    ("regexExtractAll(string, string)", |args| {
        arity(args, 2)?;
        Ok(every_match("regexExtractAll", text(&args[0])?, &args[1], None)?)
    }),
    ("regexExtractAll(string, string, string)", |args| {
        arity(args, 3)?;
        Ok(every_match("regexExtractAll", text(&args[0])?, &args[1], Some(&args[2]))?)
    }),
    ("regexGroups(string, string)", |args| {
        arity(args, 2)?;
        Ok(match_groups("regexGroups", text(&args[0])?, &args[1], None)?)
    }),
    ("regexGroups(string, string, string)", |args| {
        arity(args, 3)?;
        Ok(match_groups("regexGroups", text(&args[0])?, &args[1], Some(&args[2]))?)
    }),
    // math
    ("abs(dyn)", |args| {
        arity(args, 1)?;
        Ok(CelValue::Double(number_of(&args[0]).abs()))
    }),
    ("floor(dyn)", |args| {
        arity(args, 1)?;
        Ok(CelValue::Double(number_of(&args[0]).floor()))
    }),
    ("ceil(dyn)", |args| {
        arity(args, 1)?;
        Ok(CelValue::Double(number_of(&args[0]).ceil()))
    }),
    ("round(double)", |args| {
        arity(args, 1)?;
        Ok(CelValue::Double(math_round(formattable("round", &args[0])?)))
    }),
    ("round(int)", |args| {
        arity(args, 1)?;
        Ok(CelValue::Double(math_round(formattable("round", &args[0])?)))
    }),
    ("round(double, int)", |args| {
        arity(args, 2)?;
        round_to(&args[0], &args[1])
    }),
    ("round(int, int)", |args| {
        arity(args, 2)?;
        round_to(&args[0], &args[1])
    }),
    ("min(list<dyn>)", |args| {
        arity(args, 1)?;
        Ok(smallest(list("min", &args[0])?, true))
    }),
    ("max(list<dyn>)", |args| {
        arity(args, 1)?;
        Ok(smallest(list("max", &args[0])?, false))
    }),
    ("sum(list<dyn>)", |args| {
        arity(args, 1)?;
        Ok(CelValue::Double(list("sum", &args[0])?.iter().fold(0.0, |total, held| total + number_of(held))))
    }),
    ("avg(list<dyn>)", |args| {
        arity(args, 1)?;
        let values = list("avg", &args[0])?;
        if values.is_empty() {
            return Ok(CelValue::Null);
        }
        let total = values.iter().fold(0.0, |total, held| total + number_of(held));
        Ok(CelValue::Double(total / values.len() as f64))
    }),
    // JSON
    ("parseJson(string)", |args| {
        arity(args, 1)?;
        Ok(parse_json_text(text(&args[0])?)?)
    }),
    // encoding
    ("bytesFromBase64(string)", |args| {
        arity(args, 1)?;
        Ok(bytes_from_base64(text(&args[0])?)?)
    }),
    ("bytesToBase64(bytes)", |args| {
        arity(args, 1)?;
        match &args[0] {
            CelValue::Bytes(held) => string_value(base64_text(held)),
            _ => Err(Failure::Mismatch),
        }
    }),
    ("urlEncode(string)", |args| {
        arity(args, 1)?;
        string_value(encode_uri_component(text(&args[0])?))
    }),
    ("urlDecode(string)", |args| {
        arity(args, 1)?;
        match decode_uri_component(text(&args[0])?) {
            Ok(decoded) => string_value(decoded),
            Err(UriDecodeFault::NotHex { offset }) => Err(CatalogRefusal::new(format!(
                "urlDecode: '%' at offset {offset} is not followed by two hexadecimal digits"
            ))
            .into()),
            Err(UriDecodeFault::NotUtf8 { offset }) => Err(CatalogRefusal::new(format!(
                "urlDecode: the bytes percent-encoded at offset {offset} are not valid UTF-8"
            ))
            .into()),
        }
    }),
    // null handling
    ("default(dyn, dyn)", |args| {
        arity(args, 2)?;
        Ok(if matches!(args[0], CelValue::Null) { args[1].clone() } else { args[0].clone() })
    }),
    ("coalesce(list<dyn>)", |args| {
        arity(args, 1)?;
        Ok(list("coalesce", &args[0])?.iter().find(|held| !matches!(held, CelValue::Null)).cloned().unwrap_or(CelValue::Null))
    }),
    // time
    ("now()", |args| {
        arity(args, 0)?;
        Ok(instant_of_millis("now", Some(now_millis()))?)
    }),
    ("nowIso()", |args| {
        arity(args, 0)?;
        string_value(iso_text_in(now_millis(), "UTC").ok_or_else(|| outside_range("nowIso"))?)
    }),
    ("nowIso(string)", |args| {
        arity(args, 1)?;
        let now = now_millis();
        let zone = zone_arg("nowIso", Some(&args[0]))?;
        string_value(iso_text_in(now, &zone).ok_or_else(|| outside_range("nowIso"))?)
    }),
    ("today()", |args| {
        arity(args, 0)?;
        string_value(date_text_in(now_millis(), "UTC").ok_or_else(|| outside_range("today"))?)
    }),
    ("today(string)", |args| {
        arity(args, 1)?;
        let now = now_millis();
        let zone = zone_arg("today", Some(&args[0]))?;
        string_value(date_text_in(now, &zone).ok_or_else(|| outside_range("today"))?)
    }),
    ("nowMillis()", |args| {
        arity(args, 0)?;
        Ok(CelValue::Int(now_millis()))
    }),
    ("nowSeconds()", |args| {
        arity(args, 0)?;
        Ok(CelValue::Int(now_millis().div_euclid(1000)))
    }),
    ("dateIn(google.protobuf.Timestamp)", |args| {
        arity(args, 1)?;
        date_in(args)
    }),
    ("dateIn(google.protobuf.Timestamp, string)", |args| {
        arity(args, 2)?;
        date_in(args)
    }),
    ("isoIn(google.protobuf.Timestamp)", |args| {
        arity(args, 1)?;
        iso_in(args)
    }),
    ("isoIn(google.protobuf.Timestamp, string)", |args| {
        arity(args, 2)?;
        iso_in(args)
    }),
    ("startOfMonth(google.protobuf.Timestamp)", |args| {
        arity(args, 1)?;
        start_of_month(args)
    }),
    ("startOfMonth(google.protobuf.Timestamp, string)", |args| {
        arity(args, 2)?;
        start_of_month(args)
    }),
    ("addMonths(google.protobuf.Timestamp, int)", |args| {
        arity(args, 2)?;
        add_months(args)
    }),
    ("addMonths(google.protobuf.Timestamp, int, string)", |args| {
        arity(args, 3)?;
        add_months(args)
    }),
    // formatting
    ("format(double, string)", |args| {
        arity(args, 2)?;
        format_text(&args[0], &args[1])
    }),
    ("format(int, string)", |args| {
        arity(args, 2)?;
        format_text(&args[0], &args[1])
    }),
    ("fixed(double, int)", |args| {
        arity(args, 2)?;
        fixed_text(&args[0], &args[1])
    }),
    ("fixed(int, int)", |args| {
        arity(args, 2)?;
        fixed_text(&args[0], &args[1])
    }),
    ("formatDuration(double, int)", |args| {
        arity(args, 2)?;
        string_value(duration_text(&args[0], &args[1])?)
    }),
    ("formatDuration(int, int)", |args| {
        arity(args, 2)?;
        string_value(duration_text(&args[0], &args[1])?)
    }),
    // uuid
    ("uuidv1()", |args| {
        arity(args, 0)?;
        random("uuidv1", uuid_v1())
    }),
    ("uuidv4()", |args| {
        arity(args, 0)?;
        random("uuidv4", uuid_v4())
    }),
    ("uuidv6()", |args| {
        arity(args, 0)?;
        random("uuidv6", uuid_v6())
    }),
    ("uuidv7()", |args| {
        arity(args, 0)?;
        random("uuidv7", uuid_v7())
    }),
    ("uuidv3(string, string)", |args| {
        arity(args, 2)?;
        let (name, namespace) = (text(&args[0])?, text(&args[1])?);
        named_uuid("uuidv3", uuid_v3(name, namespace), namespace)
    }),
    ("uuidv5(string, string)", |args| {
        arity(args, 2)?;
        let (name, namespace) = (text(&args[0])?, text(&args[1])?);
        named_uuid("uuidv5", uuid_v5(name, namespace), namespace)
    }),
    ("uuidValidate(string)", |args| {
        arity(args, 1)?;
        Ok(CelValue::Bool(uuid_validate(text(&args[0])?)))
    }),
    ("uuidVersion(string)", |args| {
        arity(args, 1)?;
        let written = text(&args[0])?;
        uuid_version(written).map(|version| CelValue::Int(i64::from(version))).map_err(|_| {
            Failure::Refused(CatalogRefusal::new(format!("uuidVersion: invalid UUID {}", json_quote(written))))
        })
    }),
];

fn slice_call(args: &[CelValue]) -> Outcome {
    arity(args, 3)?;
    let (start, end) = (integer(&args[1])?, integer(&args[2])?);
    Ok(sliced(&args[0], start, end)?)
}

/// The host's nine, by dispatch key and the function's name, in Node's order.
const HOSTED: [(&str, &str); 9] = [
    ("json(dyn)", "json"),
    ("string.joinPath(string)", "joinPath"),
    ("base64Encode(string)", "base64Encode"),
    ("base64Decode(string)", "base64Decode"),
    ("sha256(string)", "sha256"),
    ("md5(string)", "md5"),
    ("sha1(string)", "sha1"),
    ("sha512(string)", "sha512"),
    ("hmac(string, string, string)", "hmac"),
];

/// Every dispatch key in Node's table order.
const KEYS: [&str; 86] = [
    "join(list<dyn>, string)",
    "keys(map<dyn, dyn>)",
    "values(map<dyn, dyn>)",
    "distinct(list<dyn>)",
    "reverse(list<dyn>)",
    "flatten(list<dyn>)",
    "sort(list<dyn>)",
    "range(int)",
    "enumerate(list<dyn>)",
    "compact(list<dyn>)",
    "compact(map<dyn, dyn>)",
    "merge(map<dyn, dyn>, map<dyn, dyn>)",
    "slice(bytes, int, int)",
    "slice(string, int, int)",
    "slice(list<dyn>, int, int)",
    "lower(string)",
    "upper(string)",
    "trim(string)",
    "replace(string, string, string)",
    "split(string, string)",
    "trimPrefix(string, string)",
    "trimSuffix(string, string)",
    "regexReplace(string, string, string)",
    "regexReplace(string, string, string, string)",
    "regexExtract(string, string)",
    "regexExtract(string, string, string)",
    "regexExtractAll(string, string)",
    "regexExtractAll(string, string, string)",
    "regexGroups(string, string)",
    "regexGroups(string, string, string)",
    "abs(dyn)",
    "floor(dyn)",
    "ceil(dyn)",
    "round(double)",
    "round(int)",
    "round(double, int)",
    "round(int, int)",
    "min(list<dyn>)",
    "max(list<dyn>)",
    "sum(list<dyn>)",
    "avg(list<dyn>)",
    "json(dyn)",
    "parseJson(string)",
    "string.joinPath(string)",
    "base64Encode(string)",
    "base64Decode(string)",
    "bytesFromBase64(string)",
    "bytesToBase64(bytes)",
    "urlEncode(string)",
    "urlDecode(string)",
    "sha256(string)",
    "md5(string)",
    "sha1(string)",
    "sha512(string)",
    "hmac(string, string, string)",
    "default(dyn, dyn)",
    "coalesce(list<dyn>)",
    "now()",
    "nowIso()",
    "nowIso(string)",
    "today()",
    "today(string)",
    "nowMillis()",
    "nowSeconds()",
    "dateIn(google.protobuf.Timestamp)",
    "dateIn(google.protobuf.Timestamp, string)",
    "isoIn(google.protobuf.Timestamp)",
    "isoIn(google.protobuf.Timestamp, string)",
    "startOfMonth(google.protobuf.Timestamp)",
    "startOfMonth(google.protobuf.Timestamp, string)",
    "addMonths(google.protobuf.Timestamp, int)",
    "addMonths(google.protobuf.Timestamp, int, string)",
    "format(double, string)",
    "format(int, string)",
    "fixed(double, int)",
    "fixed(int, int)",
    "formatDuration(double, int)",
    "formatDuration(int, int)",
    "uuidv1()",
    "uuidv4()",
    "uuidv6()",
    "uuidv7()",
    "uuidv3(string, string)",
    "uuidv5(string, string)",
    "uuidValidate(string)",
    "uuidVersion(string)",
];

static OWN_TABLE: LazyLock<HashMap<&'static str, Own>> = LazyLock::new(|| OWN.into_iter().collect());

/// The function's name a dispatch key is written over.
fn name_of(key: &str) -> &str {
    let call = &key[..key.find('(').unwrap_or(key.len())];
    call.rsplit('.').next().unwrap_or(call)
}

/// The one place a failure becomes a value.
fn answered(ctx: &CelCallContext, name: &str, args: &[CelValue], outcome: Outcome) -> CelValue {
    match outcome {
        Ok(value) => value,
        Err(Failure::Refused(refusal)) => cel_error(refusal.code, refusal.message, ctx.range).into(),
        Err(Failure::Mismatch) => mismatch(ctx, name, args),
    }
}

fn handler_answer(answer: Result<String, CatalogRefusal>) -> Outcome {
    answer.map(|text| CelValue::String(text.into())).map_err(Failure::Refused)
}

fn hosted(name: &'static str, handlers: &CelCatalogHandlers) -> CelImplementation {
    let unbound = || -> CelImplementation {
        Arc::new(move |ctx: &CelCallContext, _args: &[CelValue]| {
            cel_error(
                CelEvaluationCode::UnboundFunction,
                format!("{name}() is supplied by the host, and this environment was given no implementation for it"),
                ctx.range,
            )
            .into()
        })
    };
    let one_text = |handler: &Option<Arc<dyn Fn(&str) -> Result<String, CatalogRefusal> + Send + Sync>>| {
        let Some(handler) = handler.clone() else { return unbound() };
        Arc::new(move |ctx: &CelCallContext, args: &[CelValue]| {
            let outcome = arity(args, 1).and_then(|()| text(&args[0])).and_then(|value| handler_answer(handler(value)));
            answered(ctx, name, args, outcome)
        }) as CelImplementation
    };
    match name {
        "sha256" => one_text(&handlers.sha256),
        "md5" => one_text(&handlers.md5),
        "sha1" => one_text(&handlers.sha1),
        "sha512" => one_text(&handlers.sha512),
        "base64Encode" => one_text(&handlers.base64_encode),
        "base64Decode" => one_text(&handlers.base64_decode),
        "hmac" => {
            let Some(handler) = handlers.hmac.clone() else { return unbound() };
            Arc::new(move |ctx: &CelCallContext, args: &[CelValue]| {
                let outcome = (|| {
                    arity(args, 3)?;
                    handler_answer(handler(text(&args[0])?, text(&args[1])?, text(&args[2])?))
                })();
                answered(ctx, name, args, outcome)
            })
        }
        "json" => {
            let Some(handler) = handlers.json.clone() else { return unbound() };
            Arc::new(move |ctx: &CelCallContext, args: &[CelValue]| {
                let outcome = arity(args, 1).and_then(|()| handler_answer(handler(&args[0])));
                answered(ctx, name, args, outcome)
            })
        }
        "joinPath" => {
            let Some(handler) = handlers.join_path.clone() else { return unbound() };
            Arc::new(move |ctx: &CelCallContext, args: &[CelValue]| {
                let outcome = (|| {
                    arity(args, 2)?;
                    handler_answer(handler(text(&args[0])?, text(&args[1])?))
                })();
                answered(ctx, name, args, outcome)
            })
        }
        other => unreachable!("{other} is not one of the host's nine"),
    }
}

/// The implementation of a catalog signature, given the host's handlers, or nothing where
/// the catalog declares no such call.
pub fn catalog_implementation(key: &str, handlers: &CelCatalogHandlers) -> Option<CelImplementation> {
    if let Some((_, name)) = HOSTED.iter().find(|(held, _)| *held == key) {
        return Some(hosted(name, handlers));
    }
    let (key, run) = OWN_TABLE.get_key_value(key)?;
    let (key, run) = (*key, *run);
    let name = name_of(key);
    Some(Arc::new(move |ctx: &CelCallContext, args: &[CelValue]| answered(ctx, name, args, run(args))))
}

/// Every dispatch key this file answers for, in Node's table order.
pub fn catalog_implemented_keys() -> Vec<&'static str> {
    KEYS.to_vec()
}

// --- the literal guards -----------------------------------------------------

/// Runs a guard for its refusal alone.
fn refusal_of(run: impl FnOnce() -> Result<(), CatalogRefusal>) -> Option<String> {
    run().err().map(|refusal| refusal.message)
}

fn literal_text(literals: &[Option<CelValue>], at: usize) -> Option<&CelValue> {
    literals.get(at).and_then(Option::as_ref).filter(|value| matches!(value, CelValue::String(_)))
}

fn literal_int(literals: &[Option<CelValue>], at: usize) -> Option<&CelValue> {
    literals.get(at).and_then(Option::as_ref).filter(|value| matches!(value, CelValue::Int(_)))
}

fn literal(literals: &[Option<CelValue>], at: usize) -> Option<&CelValue> {
    literals.get(at).and_then(Option::as_ref)
}

/// A regex function's guard: the flags and the pattern, each judged only as a literal.
fn regex_guard(what: &'static str, pattern_at: usize, flags_at: usize) -> LiteralArgumentCheck {
    Arc::new(move |literals: &[Option<CelValue>]| {
        refusal_of(|| {
            let bits = match literal_text(literals, flags_at) {
                Some(flags) => re2_flags(what, Some(flags))?,
                None => Re2Flags::NONE,
            };
            if let Some(CelValue::String(written)) = literal_text(literals, pattern_at) {
                pattern_or_refusal(what, written, bits)?;
            }
            Ok(())
        })
    })
}

fn zone_guard(what: &'static str, at: usize) -> LiteralArgumentCheck {
    Arc::new(move |literals: &[Option<CelValue>]| {
        refusal_of(|| {
            if let Some(zone) = literal_text(literals, at) {
                zone_arg(what, Some(zone))?;
            }
            Ok(())
        })
    })
}

/// A numeric function's guard: its decimal places, then an integer it would format.
fn digits_guard(what: &'static str, digits: fn(&str, &CelValue) -> Result<(), CatalogRefusal>) -> LiteralArgumentCheck {
    Arc::new(move |literals: &[Option<CelValue>]| {
        refusal_of(|| {
            if let Some(written) = literal(literals, 1) {
                digits(what, written)?;
            }
            if let Some(whole) = literal_int(literals, 0) {
                formattable(what, whole)?;
            }
            Ok(())
        })
    })
}

static LITERAL_CHECKS: LazyLock<Vec<(&'static str, LiteralArgumentCheck)>> = LazyLock::new(|| {
    vec![
        ("regexReplace", regex_guard("regexReplace", 1, 3)),
        ("regexExtract", regex_guard("regexExtract", 1, 2)),
        ("regexExtractAll", regex_guard("regexExtractAll", 1, 2)),
        ("regexGroups", regex_guard("regexGroups", 1, 2)),
        ("round", digits_guard("round", |what, digits| digit_count(what, digits).map(drop))),
        ("format", digits_guard("format", |what, specifier| formatter(what, specifier).map(drop))),
        ("fixed", digits_guard("fixed", |what, digits| digit_count(what, digits).map(drop))),
        (
            "formatDuration",
            Arc::new(|literals: &[Option<CelValue>]| {
                refusal_of(|| {
                    if let Some(per_day) = literal(literals, 1) {
                        duration_text(literal(literals, 0).unwrap_or(&CelValue::Int(0)), per_day)?;
                    }
                    Ok(())
                })
            }) as LiteralArgumentCheck,
        ),
        ("dateIn", zone_guard("dateIn", 1)),
        ("isoIn", zone_guard("isoIn", 1)),
        ("startOfMonth", zone_guard("startOfMonth", 1)),
        ("addMonths", zone_guard("addMonths", 2)),
    ]
});

/// The literal guard of a catalog function, where it has one.
pub fn catalog_literal_check(name: &str) -> Option<LiteralArgumentCheck> {
    LITERAL_CHECKS.iter().find(|(held, _)| *held == name).map(|(_, check)| Arc::clone(check))
}

/// Every function name a literal guard answers for, in Node's order.
pub fn catalog_guarded_names() -> Vec<&'static str> {
    LITERAL_CHECKS.iter().map(|(name, _)| *name).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host_random::RandomSourceUnavailable;

    /// Interim (Q5): a random source that answers nothing is `unbound_function`, where Node
    /// would throw its host's own failure out of evaluation. A source cannot be made to
    /// fail from outside, so the wording is pinned on the one function that words it.
    #[test]
    fn interim_a_random_source_that_answers_nothing_is_unbound() {
        let failed = random("uuidv4", Err(RandomSourceUnavailable { cause: getrandom::Error::UNSUPPORTED }));
        let Err(Failure::Refused(refusal)) = failed else { panic!("a failing source answered a value") };
        assert_eq!(
            refusal,
            CatalogRefusal::coded(
                "uuidv4() needs the host's random source, which is unavailable here",
                CelEvaluationCode::UnboundFunction
            )
        );
    }

    /// Every merge V8's TimSort makes sorts what it is handed; a seeded step diverging from
    /// V8's is caught by the recorded comparison sequences in `tests/catalog_runtime.rs`.
    #[test]
    fn sorts_by_a_consistent_order_at_every_size() {
        let mut state: u64 = 0x2545_f491_4f6c_dd1d;
        for length in [0usize, 1, 2, 3, 31, 32, 33, 63, 64, 65, 127, 1000, 5000] {
            let values: Vec<u64> = (0..length)
                .map(|_| {
                    state ^= state << 13;
                    state ^= state >> 7;
                    state ^= state << 17;
                    state % 97
                })
                .collect();
            let mut order: Vec<usize> = (0..length).collect();
            tim_sort(&mut order, |a, b| Ok::<_, ()>(values[a].cmp(&values[b]))).unwrap();
            let values = &values;
            let expected: Vec<usize> =
                (0..97).flat_map(|value| (0..length).filter(move |&at| values[at] == value)).collect();
            assert_eq!(order, expected, "{length}");
        }
    }
}
