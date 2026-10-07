//! The CEL value domain: what a value is, the invariants it holds and the text it is
//! written as — `cel/nodejs`'s value-domain files, without an engine behind them.
//!
//! Two rules hold for every file here: no dependency of any kind, and no host
//! vocabulary — a host's own type reaches the domain as a [`CelHostValue`] carrying a
//! name the host chose.
//!
//! Each file twins the `cel/nodejs/src` file of its name. A Node export that needs the
//! syntax tree or the zone database lives in the engine crate's file of the same name,
//! and each header here lists those.
//!
//! - `cel_value.rs`       — `cel-value.ts`
//! - `cel_map_value.rs`   — `cel-map-value.ts`
//! - `duration_value.rs`  — `duration-value.ts`
//! - `timestamp_value.rs` — `timestamp-value.ts`
//! - `value_text.rs`      — `value-text.ts`

mod cel_map_value;
mod cel_value;
mod duration_value;
mod timestamp_value;
mod value_text;

pub use cel_map_value::{cel_map_from_entries, cel_map_keys, map_key_identity};
pub use cel_value::{
    cel_error, cel_none, cel_some, cel_type_name_of, cel_type_value, CelDuration, CelError,
    CelEvaluationCode, CelHostValue, CelMap, CelMapKey, CelOptional, CelRecord, CelTimestamp,
    CelTypeValue, CelValue, SourceRange, CEL_EVALUATION_CODES, CEL_VALUE_KEYS,
};
pub use duration_value::{
    cel_duration_from_nanos, duration_field, duration_nanos, duration_nanos_from_text,
    duration_out_of_range, format_duration, parse_duration, DurationField, MAX_DURATION_NANOS,
    MIN_DURATION_NANOS,
};
pub use timestamp_value::{
    cel_timestamp, cel_timestamp_from_millis, civil_from_days, days_from_civil, days_in_month,
    format_timestamp, is_leap_year, parse_timestamp, seconds_from_fields, timestamp_nanos,
    utc_fields, CivilFields, MAX_TIMESTAMP_SECONDS, MIN_TIMESTAMP_SECONDS,
};
pub use value_text::{bytes_to_text, double_text, es_number, json_quote, text_to_bytes};
