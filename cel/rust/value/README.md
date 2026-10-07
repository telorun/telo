# telorun-cel-value

The CEL value domain for Rust: every value an expression can hold, the invariants each one keeps, and the text each is written as. It is the Rust half of the value-domain files of `@telorun/cel` (`cel/nodejs`), and it answers as they answer — the same acceptances, refusals, codes, messages and written text.

It holds values and nothing that computes with them. Equality (`==`), ordering, arithmetic, time zones and reading a literal out of a syntax tree belong to the engine crate that will stand on this one.

## The two rules

- **No dependency.** `[dependencies]` is empty: no registry crate, no path crate, no dev-dependency. `cargo tree -p telorun-cel-value` prints one line.
- **No host vocabulary.** No kind, annotation, tag or manifest word appears in `src/`, and nothing reads a path outside this directory. A host's own type enters the domain as a `CelHostValue` under a name the host chose. How a value is written for a reader outside CEL — a plain encoding, a wire frame, serde — is decided by the crate that owns that reader, never here.

The crate is `publish = false`, licensed MIT, and carries `@telorun/cel`'s version: the two are one artifact in two languages, stamped together by the version step.

## Files

Each file twins the `cel/nodejs/src` file of its name. A Node export that needs the syntax tree or the zone database lives in the engine crate's file of the same name; one that describes a JavaScript representation has no twin.

| File | Twins | Public items | Node exports elsewhere |
|---|---|---|---|
| `cel_value.rs` | `cel-value.ts` | `CelValue`, `CelTimestamp`, `CelDuration`, `CelMap`, `CelMapKey`, `CelRecord`, `CelTypeValue`, `CelOptional`, `CelError`, `CelEvaluationCode`, `CelHostValue`, `SourceRange`, `CEL_VALUE_KEYS`, `CEL_EVALUATION_CODES`, `cel_type_value`, `cel_none`, `cel_some`, `cel_error`, `cel_type_name_of` | Engine half: `literalValue`. No twin: the brand symbol and the `isCel*` predicates (the variant is the identity), `celUint` (it is `CelValue::Uint`), `isThenable` / `asyncValueRefused` (no Rust value can be awaited) |
| `cel_map_value.rs` | `cel-map-value.ts` | `cel_map_from_entries`, `cel_map_keys`, `map_key_identity` | No twin: `celMapOf` (the empty map is `CelMap::default()`) |
| `duration_value.rs` | `duration-value.ts` | `cel_duration_from_nanos`, `duration_out_of_range`, `duration_nanos`, `parse_duration`, `duration_nanos_from_text`, `format_duration`, `DurationField`, `duration_field`, `MAX_DURATION_NANOS`, `MIN_DURATION_NANOS`, and `CelDuration`'s carrier constructors | — |
| `timestamp_value.rs` | `timestamp-value.ts` | `cel_timestamp`, `cel_timestamp_from_millis`, `timestamp_nanos`, `parse_timestamp`, `format_timestamp`, `MIN_TIMESTAMP_SECONDS`, `MAX_TIMESTAMP_SECONDS`, `CelTimestamp`'s carrier constructors, and the civil calendar: `CivilFields`, `utc_fields`, `seconds_from_fields`, `days_from_civil`, `civil_from_days`, `days_in_month`, `is_leap_year` | Engine half: `zonedFields`, `timestampField`, `TimestampField` — a getter reads a field in a zone, and the zone database is a dependency |
| `value_text.rs` | `value-text.ts` | `text_to_bytes`, `bytes_to_text`, `double_text`, and two items Node calls its host for: `es_number` (ECMAScript's `Number::toString`) and `json_quote` (a string as `JSON.stringify` quotes one) | — |

`value-equality.ts` and `integer-arithmetic.ts` have no file here: both are operator semantics, and the engine crate owns them. The integer limits (`MAX_INT`, `MIN_INT`, `MAX_UINT`) are not declared either — an int is an `i64` and a uint a `u64`, so the range is the type.

Every public item is exported at the crate root.

## The union

`CelValue` is closed at sixteen variants. A value's identity is its variant; adding one is a change to this crate.

| Variant | Holds |
|---|---|
| `Null` | — |
| `Bool` | `bool` |
| `Int` | `i64` |
| `Uint` | `u64` |
| `Double` | `f64` |
| `String` | `String` |
| `Bytes` | `Vec<u8>` |
| `List` | `Vec<CelValue>` |
| `Map` | `CelMap` — typed keys |
| `Record` | `CelRecord` — string keys, as a host hands a map over |
| `Timestamp` | `CelTimestamp` |
| `Duration` | `CelDuration` |
| `Type` | `CelTypeValue` — a type's name |
| `Optional` | `CelOptional` — nothing, or one held value |
| `Error` | `CelError` |
| `Host` | `CelHostValue` |

- **Aggregates are owned**, not reference-counted. `CelValue` is `Clone + Debug + Send + Sync`, and deliberately neither `Eq` nor `Hash` (a double is in it).
- **`PartialEq` is identity in the domain, never CEL's `==`.** Same variant, same content. A double compares by its bits, so NaN equals NaN and `-0.0` is not `0.0`; `Int(1)` is not `Uint(1)`. Two maps are equal when they hold the same key/value pairs in any order, a key compared as the value it is. The one crossing: a `Map` whose keys are all strings equals a `Record` of the same pairs, because they are one value written two ways.
- **`cel_type_name_of`** answers what `type()` answers: `bool`, `string`, `double`, `int`, `uint`, `null_type`, `bytes`, `list`, `map` (for both `Map` and `Record`), `type`, `optional`, `google.protobuf.Timestamp`, `google.protobuf.Duration`, or a host value's own name. It answers nothing for an error and for an unnamed host value.
- **`CEL_VALUE_KEYS`** is the closed set of seven type keys the domain's own values carry: `uint`, `google.protobuf.Timestamp`, `google.protobuf.Duration`, `type`, `optional`, `map`, `error`.

### Host values

A `CelHostValue` is an optional type name plus an opaque shared payload (`Arc<dyn Any + Send + Sync>`).

- `CelHostValue::named(name, payload)` is a value of a host-registered type. It answers `None` when the name is one of `CEL_VALUE_KEYS`.
- `CelHostValue::unnamed(payload)` is a host object of no CEL type, such as a live handle.
- Two host values are the same value only when they are the same object under the same name.

## The two maps

Node answers differently for a map with typed keys and for a plain object a host handed over, so both exist.

**`CelMap`** holds int, uint, bool and string keys in one container, in insertion order.

- It is built only by `cel_map_from_entries`, from key/value pairs in written order; `CelMap::default()` is the empty map.
- A key's identity is a `CelMapKey`: a string or a bool is itself, and an int, a uint and a whole double are the one integer CEL equality makes them. So `1`, `1u` and `1.0` name one entry, while `"1"` and `"true"` are never `1` and `true`.
- `map_key_identity` answers that identity for any value, or nothing for a value that names no entry (a double that is not whole, a list, a map, null …). A whole double too large for any int or uint answers an identity no entry holds.
- A map is **built** with an int, uint, bool or string key only — a double is refused even when whole — and is still **looked up** by any numeric type.
- The key is kept as it was written: `{1: …}` read through `1u` answers the entry whose key is the int `1`.
- `cel_map_keys` lists the keys in insertion order.

`cel_map_from_entries` refuses, in this order for each entry, first entry first:

| Cause | Code | Message |
|---|---|---|
| The key is an error value | the key's own | the key's own |
| The value is an error value | the value's own | the value's own |
| The key is not an int, uint, bool or string | `unsupported_key_type` | `a map is keyed by an int, a uint, a bool or a string` |
| The key's identity is already held | `duplicate_map_key` | `the key <k> is written twice` — a string quoted as JSON, a uint with its `u` (`1u`), an int or bool plain |

**`CelRecord`** is a map whose keys are all strings. It ranges in ECMAScript's own-property order, because that is what a comprehension over a host's object answers on Node: keys that are canonical array indices (`0` … `4294967294`, no leading zero) first, ascending, then every other key in insertion order. Setting a key that is already held replaces its value and keeps its position.

## Durations: two ranges

`CelDuration` is a total of nanoseconds whose whole seconds fit an `i64`. Seconds and nanoseconds therefore share a sign and `|nanos| < 1e9`. **CEL's own range is not part of the type.**

- **The carrier's range** — whole seconds fit an `i64`. `CelDuration::new(seconds, nanos)` and `CelDuration::from_total_nanos(total)` build any such duration and answer `None` on a shape the carrier does not hold. They are for a duration this engine did not build: one from a transport, a journal or a host.
- **CEL's range** — the total of nanoseconds fits an `i64`: `-9223372036.854775808s … 9223372036.854775807s`, about ±292 years. It belongs to CEL's constructor and to the check at use:
  - `cel_duration_from_nanos(total)` refuses a total outside it;
  - `parse_duration(text)` is the grammar plus that range;
  - `duration_out_of_range(duration)` answers the same error for a carrier-built duration, asked where the engine uses one.

  All three refuse with `invalid_conversion` / `duration out of range`. So 200,000,000,000 s is a value the carrier holds and writes (`200000000000s`), and one CEL refuses to compute with.

**The grammar** is one, with or without the range. `duration_nanos_from_text` reads it and applies no range, for a consumer whose range is not CEL's: an optional `+` or `-`, then either a bare `0` or one or more `<digits>[.<digits>]<unit>` parts with no separator, over `ns`, `us`, `µs` (U+00B5), `μs` (U+03BC), `ms`, `s`, `m`, `h`. Each part needs a digit on at least one side of its point. A fraction is read to the nanosecond and further digits are dropped. Malformed text is `invalid_conversion` / `<quoted text> is not a duration`, judged before any range. A well-formed total that 128 bits cannot hold answers `duration out of range`.

**Written text** — `format_duration`, which is also `Display` — is seconds with an `s`, the fraction trimmed to what it carries: `5400s`, `-1.5s`, `0.000000001s`, `0s`.

**Getters** — `duration_field`: `GetHours`, `GetMinutes` and `GetSeconds` answer the whole span in that unit, truncated toward zero; `GetMilliseconds` answers the component inside the second, so `123.321456789s` answers 321 and `-1.5s` answers −500.

## Timestamps: one range

`CelTimestamp` is an instant to the nanosecond within `0001-01-01T00:00:00Z … 9999-12-31T23:59:59.999999999Z`, by construction. No wider carrier exists; every way of building one outside the range refuses.

- `CelTimestamp::new(seconds, nanos)` and `CelTimestamp::from_unix_nanos(total)` answer `None` outside the range.
- `cel_timestamp(seconds, nanos)` takes seconds and nanoseconds of any sign, normalizes them, and refuses with `invalid_conversion` / `timestamp out of range`.
- `cel_timestamp_from_millis(millis)` reads a host's epoch-millisecond clock, keeping a fractional reading's sub-millisecond part; a reading that is not finite is out of range.
- `parse_timestamp(text)` is CEL's lenient RFC 3339 reading: `T`, `t` or a space between date and time; a fraction of any length, read to the nanosecond with further digits dropped; `Z`, `z` or `±HH:MM`. An offset's digits are not ranged — `+99:99` is the arithmetic it names. It refuses a wrong shape with `<quoted text> is not an RFC 3339 instant`, a date or time of day that does not exist with `<quoted text> is not an instant`, and an instant outside the range with `timestamp out of range`, all `invalid_conversion`. A stricter plain form is the business of the crate that owns it.
- `format_timestamp`, which is also `Display`, writes RFC 3339 in UTC with the fraction trimmed and omitted when the instant is whole: `2009-02-13T23:31:30Z`.

Neither type has a `parse` method: reading is the named functions, so the grammar and the range a caller gets are the ones it asked for.

The civil calendar is public for the engine's zoned getters to build on: `utc_fields` (the date and time of day of a count of seconds), `seconds_from_fields`, `days_from_civil`, `civil_from_days`, `days_in_month`, `is_leap_year`.

## Text

- `double_text` writes a double as the shortest digits that read back as it, in ECMAScript's layout (plain decimal from `1e-6` up to `1e21`, exponent notation outside), with `NaN`, `+Inf`, `-Inf` and `-0` named as cel-spec writes them. `es_number` is the same digits as `Number::toString` writes every double (`Infinity`, and `0` for either zero), written here once for every crate above.
- `bytes_to_text` reads UTF-8 and refuses anything else with `invalid_conversion` / `the bytes are not UTF-8 text` rather than substitute a replacement character. One leading byte order mark is dropped, as on Node. `text_to_bytes` is the reverse.
- `json_quote` quotes a string exactly as `JSON.stringify` does. Every refusal that names text quotes it this way.

## The error value

`CelError { code, message, range }` is one struct in two roles: a variant of the union (`From<CelError> for CelValue`), because `false && <error>` is `false` and an error must flow through evaluation as an operand; and a `std::error::Error`, so every constructor and parser here answers `Result<T, CelError>` and a caller uses `?`.

- `code` is a `CelEvaluationCode`: a closed enum of the sixteen codes every engine names, listed in one order by `CEL_EVALUATION_CODES` and written by `as_str()` (`no_such_key`, `invalid_conversion`, …). A code is never derived from a message. `async_value_unsupported` is in the set although no Rust value can raise it, because the set is one vocabulary across engines.
- `message` is what `Display` writes, alone.
- `range` is an optional `SourceRange`: a `[start, end)` pair of UTF-16 code-unit offsets into the expression's source. No function here knows where in a source it was called from, so each answers an error with no range; the engine attaches one with `CelError::with_range`.
- No function of this crate answers `Ok` holding an `Error` variant.

## Tests

`tests/` holds the value-level twins of `cel/nodejs/tests/cel-value.test.ts`, `map-key-identity.test.ts` and the value-level cases of `evaluate.test.ts`, plus literal tables for what no Node test pins directly — duration and timestamp text, the double's written form, JSON quoting, UTF-8 reading and a record's order. Every expected value, code and message in them was produced by executing the Node build, not by reading it, and the tests read no file outside this directory.

Semantics shared with the Node engine, and the reasons behind them, are in `cel/nodejs/CLAUDE.md` ("The value domain", and the sections on the two durations and the declared ranges).
