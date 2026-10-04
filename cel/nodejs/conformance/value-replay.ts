/**
 * Replaying the conformance vectors' language rows at the **value** level: what each row
 * evaluates to.
 *
 * This is the half the check-level driver (`language-replay.ts`) cannot reach. Its
 * completeness invariant filters on "the recording needs a position" — a row whose check
 * or evaluation **fails** while cel-spec answers — so by construction it cannot see a row
 * where both engines answer and the two answers differ. There are 26 such rows, and a
 * sweep that only looked at refusals would walk past every one. So the rule here is the
 * same shape one level up: **every row is accounted for, or the gate fails.**
 *
 * Per row, one of exactly three things holds:
 *
 * 1. **Matched** — the engine answers what the row records: the same value, written in
 *    its canonical form so a difference of CEL type is a difference of text, or an error
 *    where the row records an error.
 * 2. **Corrected** — the engine answers cel-spec rather than the recording, and the row's
 *    own `deviation.celSpec` says so. A correction is not a free pass: where the row
 *    carries cel-spec's value the engine's answer is compared **against that value**, and
 *    where it carries cel-spec's error the engine must fail.
 * 3. **Excluded** — the engine answers the recording although cel-spec differs, with one
 *    reason from the closed set the package guide names and a pinned row count.
 *
 * Anything else is `unaccounted`, and the test fails naming the row. A listed row that
 * now agrees fails too, so a correction cannot outlive its cause.
 *
 * **What is not compared:** an error's code and message. A recorded error's code is
 * always `null` and its wording is the engine being replaced's own, so a row recorded as
 * failing is held to failing — at a code and a range this engine decides for itself.
 */

import { CelEnvironment, CelEvaluationError, type CelValue, type SourceRange } from "../src/index.js";
import {
  conformanceText,
  decodeConformanceValue,
  describeValue,
  type ConformanceValue,
} from "./conformance-value.js";
import {
  languageEnvironment,
  SPEC_CORRECTIONS,
  specExclusion,
  type LanguageRow,
} from "./language-replay.js";

/** What the engine answered for a row: a value, or a failure. */
type Answer =
  | { readonly kind: "value"; readonly value: CelValue }
  | {
      readonly kind: "error";
      readonly why: string;
      /** Which seam refused: a `disable_check` exclusion is only about the checker's. */
      readonly stage: "syntax" | "check" | "evaluation";
      /** The failure's own summary and span, where it has one — for the rows below. */
      readonly message?: string;
      readonly range?: SourceRange;
    };

/**
 * The rows whose recorded error text the engine is held to **byte for byte**, caret
 * included.
 *
 * A recorded error is normally the engine being replaced speaking, so comparing it would
 * compare that engine's wording. These six are the exception the format itself names: they
 * are divergence rows, whose `expect.error` is "the only `expect` in any file that is not
 * the Node engine's" — a fixed summary for the condition plus the usual highlight. So they
 * are the one place a message comparison says something, and after the duration range came
 * in they are all six exactly what this engine answers.
 */
export const RECORDED_MESSAGE_ROWS: readonly string[] = [
  "timestamps/duration_range/from_string_under",
  "timestamps/duration_range/from_string_over",
  "timestamps/duration_range/add_under",
  "timestamps/duration_range/add_over",
  "timestamps/duration_range/sub_under",
  "timestamps/duration_range/sub_over",
];

/**
 * A failure as the vectors write one: the summary, a blank line, then `> `, the line number
 * right-aligned in four columns, ` | `, the source line, and a caret under the column — the
 * format `recordedOffset` reads, written the other way round.
 */
function highlighted(message: string, source: string, offset: number): string {
  const before = source.slice(0, offset).split("\n");
  const line = before.length;
  const column = before[before.length - 1]!.length;
  const text = source.split("\n")[line - 1] ?? "";
  const prefix = `> ${String(line).padStart(4)} | `;
  return `${message}\n\n${prefix}${text}\n${" ".repeat(prefix.length + column)}^`;
}

export interface ValueReplayFailure {
  readonly id: string;
  readonly source: string;
  readonly reason: string;
}

export interface ValueReplayReport {
  readonly rows: number;
  readonly driven: number;
  readonly recordedValue: number;
  readonly recordedError: number;
  readonly matched: number;
  readonly correctionsSeen: readonly string[];
  readonly exclusionsSeen: readonly string[];
  /** Rows the engine answers its own way, pinned, while a decision is owed. */
  readonly pendingSeen: readonly string[];
  /** Rows whose recorded error text the engine reproduced exactly. */
  readonly messagesMatched: readonly string[];
  /** Rows whose cel-spec answer is a type, which the check-level driver accounts for. */
  readonly checkSeamRows: readonly string[];
  /** Rows no outcome accounts for. Must be empty. */
  readonly unaccounted: readonly string[];
  readonly failures: readonly ValueReplayFailure[];
  readonly correctionCounts: readonly { readonly cause: string; readonly rows: number; readonly pinned: number }[];
  readonly exclusionCounts: readonly { readonly reason: string; readonly rows: number; readonly pinned: number }[];
  readonly notCompared: readonly { readonly expectation: string; readonly rows: number; readonly because: string }[];
}

/**
 * Where the engine's VALUE differs from the recorded one because cel-spec says so.
 *
 * Each group names its cause and its authority, and pins how many rows it covers. The
 * authority for most is the row's own `deviation.celSpec`, which the driver then holds the
 * engine's answer to; where a group's rows carry no cel-spec answer the authority says
 * which production or rule decides instead.
 */
export const VALUE_CORRECTION_GROUPS = [
  {
    cause: "a bytes literal holds the UTF-8 of its text",
    authority:
      "cel-spec's `BYTES_LIT` is a string literal under a bytes marker, and its text is UTF-8: `b'ÿ'` is 0xC3 0xBF, which is the value `deviation.celSpec` carries. Reading each character's low eight bits instead made `b'ÿ' == b'\\303\\277'` false",
    rows: [
      "basic/self_eval_nonzeroish/self_eval_bytes_escape",
      "comparisons/eq_literal/eq_bytes",
      "comparisons/ne_literal/not_ne_bytes",
    ],
  },
  {
    cause: "bytes are ordered",
    authority:
      "cel-spec orders every scalar type, bytes included (cel-go declares `less_bytes`); each row carries cel-spec's answer under `deviation.celSpec`",
    rows: [
      "comparisons/bound/bytes_gt_left_false",
      "comparisons/gt_literal/gt_bytes_one",
      "comparisons/gt_literal/gt_bytes_one_to_empty",
      "comparisons/gt_literal/not_gt_bytes_sorting",
      "comparisons/gte_literal/gte_bytes_samelength",
      "comparisons/gte_literal/gte_bytes_to_empty",
      "comparisons/gte_literal/not_gte_bytes_empty_to_nonempty",
      "comparisons/lt_literal/lt_bytes",
      "comparisons/lt_literal/not_lt_bytes_same",
      "comparisons/lt_literal/not_lt_bytes_width",
      "comparisons/lte_literal/lte_bytes_empty",
      "comparisons/lte_literal/not_lte_bytes_length",
    ],
  },
  {
    cause: "backtick-quoted member names",
    authority:
      "cel-spec's `ESCAPED_IDENTIFIER` reads a member whose name is not spelled as an identifier, and each row carries cel-spec's answer under `deviation.celSpec`. Telo's own ground decides it too: an index into a schema with `properties` is left unjudged, so a dashed or dotted key in a header map, a JSON payload or a column set would be unreachable by the type checker \u2014 a hole exactly where Telo's HTTP and SQL surfaces live",
    rows: [
      "fields/quoted_map_fields/field_access_slash",
      "fields/quoted_map_fields/field_access_dash",
      "fields/quoted_map_fields/field_access_dot",
      "fields/quoted_map_fields/has_field_slash",
      "fields/quoted_map_fields/has_field_dash",
      "fields/quoted_map_fields/has_field_dot",
    ],
  },
  {
    cause: "raw bytes literals",
    authority:
      "core grammar: `BYTES_LIT: [bB] STRING_LIT` over `STRING_LIT: [rR]? \u2026`, so the bytes marker comes first and all four of `br`, `bR`, `Br`, `BR` are literals; each row carries cel-spec's answer under `deviation.celSpec`. (`rb'\u2026'` is NOT one, and stays refused.)",
    rows: [
      "parse/bytes_literals/raw_single_quoted_escapes",
      "parse/bytes_literals/raw_double_quoted_escapes",
      "parse/bytes_literals/raw_triple_single_quoted_escapes",
      "parse/bytes_literals/raw_triple_double_quoted_escapes",
      "parse/bytes_literals/upper_raw_single_quoted_escapes",
      "parse/bytes_literals/upper_raw_double_quoted_escapes",
      "parse/bytes_literals/upper_raw_triple_single_quoted_escapes",
      "parse/bytes_literals/upper_raw_triple_double_quoted_escapes",
    ],
  },
  {
    cause: "optional entries in a list or a map",
    authority:
      "the optional library's own syntax, which enters with the library Telo enables: `[?x]` and `{?k: v}` hold an `optional<T>` and contribute a `T`. Each row carries cel-spec's answer under `deviation.celSpec`, and three of them exercise `optional.ofNonZeroValue` only through this syntax",
    rows: [
      "optionals/optionals/optional_chaining_12",
      "optionals/optionals/optional_chaining_13",
      "optionals/optionals/optional_chaining_14",
      "optionals/optionals/optional_chaining_15",
      "optionals/optionals/optional_chaining_16",
      "optionals/optionals/map_optional_entry_has",
    ],
  },
  {
    cause: "a double may begin with its point",
    authority:
      "`FLOAT_LIT` is `DIGIT* . DIGIT+ EXPONENT?`, so `.99` is one double; the row carries cel-spec's answer under `deviation.celSpec` and says nothing about a container",
    rows: [
      "comparisons/gt_literal/not_gt_double",
    ],
  },
  {
    cause: "absolute names",
    authority:
      "a leading dot resolves a name against the environment's declarations and never against a name the expression bound; each row carries cel-spec's answer under `deviation.celSpec`. What the dot defeats in all three is a COMPREHENSION BINDING, which Telo has everywhere \u2014 today an author whose comprehension variable is named like an outer one has no spelling for the outer one",
    rows: [
      "namespace/namespace_shadowing/disambiguation",
      "namespace/namespace_shadowing/comprehension_shadowing_disambiguation",
      "namespace/namespace_shadowing/comprehension_shadowing_namespaced_selector_disambiguation",
    ],
  },
  {
    cause: "a dotted declaration is one name, longest prefix first",
    authority:
      "cel-spec resolves a qualified name against the declarations, the longest prefix winning, so `a.b.c` is that variable where it is declared and the map's entry where only `a.b` is; each row carries cel-spec's answer under `deviation.celSpec`. `list_field_select_unsupported` follows from the same rule and carries no cel-spec answer: its own name says the select is unsupported, and reading a member of a list is a type error",
    rows: [
      "fields/qualified_identifier_resolution/qualified_ident",
      "fields/qualified_identifier_resolution/map_field_select",
      "fields/qualified_identifier_resolution/qualified_identifier_resolution_unchecked",
      "fields/qualified_identifier_resolution/ident_with_longest_prefix_check",
      "namespace/qualified/self_eval_qualified_lookup",
    ],
  },
  {
    cause: "the identity conversions",
    authority:
      "cel-spec declares `duration(duration)` and `timestamp(timestamp)`; both rows carry cel-spec's answer under `deviation.celSpec`",
    rows: [
      "conversions/identity/duration",
      "conversions/identity/timestamp",
    ],
  },
  {
    cause: "int() over a uint, a timestamp and a duration",
    authority:
      "cel-spec declares `int(uint)`, `int(timestamp)` and `int(duration)`; each row carries cel-spec's answer under `deviation.celSpec`",
    rows: [
      "conversions/int/uint",
      "conversions/int/uint_zero",
      "conversions/int/uint_max_exact",
      "parse/nest/funcall",
      "conversions/int/timestamp",
      "timestamps/timestamp_conversions/toInt_timestamp",
    ],
  },
  {
    cause: "string() over a timestamp and a duration",
    authority:
      "cel-spec declares `string(timestamp)` and `string(duration)`; each row carries cel-spec's answer under `deviation.celSpec`",
    rows: [
      "timestamps/timestamp_conversions/toString_timestamp",
      "timestamps/timestamp_conversions/toString_timestamp_nanos",
      "timestamps/duration_conversions/toString_duration",
    ],
  },
  {
    cause: "has() over any member read",
    authority:
      "cel-spec's `has` takes any expression whose last step is a select, not only a member of a chain of names; each row carries cel-spec's answer under `deviation.celSpec`",
    rows: [
      "fields/map_has/has",
      "fields/map_has/has_not",
      "fields/map_has/has_empty",
      "optionals/optionals/has_map_optindex",
      "optionals/optionals/has_map_optindex_field",
      "optionals/optionals/map_optional_has",
      "optionals/optionals/map_optional_select_has",
      "optionals/optionals/optional_chaining_9",
      "optionals/optionals/ternary_optional_hasValue",
    ],
  },
  {
    cause: "the optional library, whole",
    authority:
      "the optional library is enabled rather than excluded, so it enters whole: `optMap`, `optFlatMap`, `optional.ofNonZeroValue`, equality over optionals and `type()` of one are all cel-spec's; each row carries cel-spec's answer under `deviation.celSpec`",
    rows: [
      "optionals/optionals/none_optMap_hasValue",
      "optionals/optionals/optional_of_optMap_value",
      "optionals/optionals/empty_map_optFlatMap_hasValue",
      "optionals/optionals/map_empty_submap_optFlatMap_hasValue",
      "optionals/optionals/map_submap_optFlatMap_value",
      "optionals/optionals/map_submap_subkey_optFlatMap_value",
      "optionals/optionals/map_optindex_optFlatMap_optional_ofNonZeroValue_hasValue",
      "optionals/optionals/null_non_zero_value",
      "optionals/optionals/optional_chaining_1",
      "optionals/optionals/optional_ofNonZeroValue_or_optional_value",
      "optionals/optionals/optional_eq_none_none",
      "optionals/optionals/optional_eq_none_int",
      "optionals/optionals/optional_eq_int_none",
      "optionals/optionals/optional_eq_int_int",
      "optionals/optionals/optional_ne_none_none",
      "optionals/optionals/optional_ne_none_int",
      "optionals/optionals/optional_ne_int_none",
      "optionals/optionals/optional_ne_int_int",
      "optionals/optionals/type",
    ],
  },
  {
    cause: "an unconstrained type variable is dyn",
    authority:
      "cel-spec types an unresolved type parameter as `dyn` wherever it is used \u2014 its own row is named `unconstrained_type_var_as_dyn` \u2014 so a member, an index or a comprehension range over one is answered rather than refused; each row carries cel-spec's answer under `deviation.celSpec`",
    rows: [
      "optionals/optionals/map_undefined_entry_hasValue",
      "optionals/optionals/optional_chaining_5",
      "optionals/optionals/optional_none_optselect_hasValue",
      "optionals/optionals/optional_none_optindex_hasValue",
      "type_deduction/empty_range_nested_comprehensions/empty_list_range_nested_list_comprehension",
      "type_deduction/empty_range_nested_comprehensions/empty_map_range_nested_comprehension",
      "type_deduction/empty_range_nested_comprehensions/empty_range_nested_comprehension_before_constraint",
      "type_deduction/empty_range_nested_comprehensions/empty_range_nested_comprehension_boolean_map",
      "type_deduction/empty_range_nested_comprehensions/empty_range_nested_comprehension_equality",
    ],
  },
  {
    cause: "the engine being replaced answering about itself",
    authority:
      "the refusal is that engine's own operator table reporting an internal overlap ('int > int: bool' overlaps 'double > int: bool'), not a verdict about the expression",
    rows: [
      "macros/all/list_empty",
    ],
  },
  {
    cause: "a duration plus a timestamp is a timestamp",
    authority:
      "cel-spec states it plainly; the recorded refusal follows from the engine being replaced answering a duration, so the comparison after it has mismatched types",
    rows: [
      "timestamps/timestamp_arithmetic/add_time_to_duration",
    ],
  },
  {
    cause: "equality across the numeric types, inside an aggregate as well as outside one",
    authority:
      "cel-spec's equality is numeric across int, uint and double at evaluation — the checker is strict on purpose and `dyn(1) == 1u` reaches the runtime anyway — and it is the same equality inside a list or a map, so `[1.0, 2.0, 3] == [1u, 2, 3u]` holds; each row carries cel-spec's answer under `deviation.celSpec`",
    rows: [
      "comparisons/eq_literal/eq_list_mixed_type_numbers",
      "comparisons/eq_literal/eq_map_mixed_type_numbers",
    ],
  },
  {
    cause: "an index and a membership test compare across the numeric types too",
    authority:
      "one equality serves a key, an index and `in`, so a uint indexes a list and `dyn(3u) in [5, 4, 3, 2, 1]` holds; each row carries cel-spec's answer under `deviation.celSpec`",
    rows: [
      "lists/index/zero_based_uint",
      "lists/in/uint_in_ints",
      "lists/in/uint_in_doubles",
      "lists/in/int_in_uints",
      "lists/in/double_in_uints",
    ],
  },
  {
    cause: "a map is keyed by an int, a uint, a bool or a string, and by each key once",
    authority:
      "cel-spec's map keys are those four types, and two keys its equality makes one are a repeated key — a double key is `unsupported key type` and `{0: 1, 0u: 2}` is `Failed with repeated key`, which is what each row carries under `deviation.celSpec`. The recording builds the map and drops or overwrites, which answers a value no reader of the expression could predict",
    rows: [
      "fields/qualified_identifier_resolution/map_key_float",
      "fields/qualified_identifier_resolution/map_key_null",
      "fields/qualified_identifier_resolution/map_value_repeat_key",
      "fields/qualified_identifier_resolution/map_value_repeat_key_heterogeneous",
    ],
  },
  {
    cause: "a map comprehension binds its key",
    authority:
      "cel-spec ranges a comprehension over a map's KEYS, so `{6: 'six'}.exists_one(foo, foo % 5 == 2)` tests the keys; the row carries cel-spec's `true` under `deviation.celSpec`, and the recording's refusal is its own binding of the values instead",
    rows: ["macros/exists_one/map_one"],
  },
  {
    cause: "string(bytes) refuses bytes that are not UTF-8 text",
    authority:
      "cel-spec's conversion is to TEXT, and `deviation.celSpec.error` is `invalid UTF-8`; the recording answers a string holding a replacement character, which is a value the author never wrote and which reads back as different bytes",
    rows: ["conversions/string/bytes_invalid"],
  },
  {
    cause: "the ORDINARY step of a chain that entered optional land is still an ordinary read",
    authority:
      "a presence-shaped read — `.?`, `[?]`, `has()` — answers absence over a value that holds no members, which is the optional library's own semantics; what an optional does NOT change is the ordinary read written after it. Both rows read a plain `.invalid` / `.absent` off a present optional whose held value is a `null` and a `0`, and `deviation.celSpec.error` records each as an error — cel-go qualifies such a step with its presence flag unset, so the receiver holding no members is the mistake it would be outside the optional. The recording answers absent, which would hide that mistake behind the `.?` two steps earlier. Its sibling reading is `optional_chaining_5`, where the ordinary step misses a KEY of a map and cel-spec answers absent",
    rows: [
      "optionals/optionals/map_null_entry_no_such_key",
      "optionals/optionals/map_present_key_invalid_field",
    ],
  },
  {
    cause: "a time zone written as a fixed offset",
    authority:
      "cel-spec reads a getter's zone as an IANA name or a fixed `HH:MM` offset ahead of UTC, and carries `1` for `getHours('02:00')` under `deviation.celSpec`; the recording's refusal is the JS host's own zone parser speaking, and the vectors say its message is not pinned",
    rows: ["timestamps/timestamp_selectors_tz/getHours"],
  },
  {
    cause: "an instant keeps its nanoseconds through arithmetic",
    authority:
      "cel-spec's timestamp is nanosecond-precise, so adding a nanosecond moves it — and moves it out of range at the end of year 9999, which `deviation.celSpec` records as a value on one row and a range error on the other. The recording holds an instant to milliseconds, so the nanosecond is lost and the overflow never happens",
    rows: [
      "timestamps/timestamp_arithmetic/add_time_to_duration_nanos_positive",
      "timestamps/timestamp_range/add_duration_nanos_over",
    ],
  },
  {
    cause: "a duration is the int64 range of its total nanoseconds",
    authority:
      "cel-spec's language definition states it under Overflow \u2014 'Duration values are limited to a single int64 value, or roughly +-290 years' \u2014 so the span between the first and last instant does not fit a duration, and `deviation.celSpec.error` is `range` on both rows. The \u00b110,000-year figure is protobuf's `google.protobuf.Duration` range, which Telo's typed frame carries deliberately so that a duration arriving from a transport or a journal is always representable: CEL's duration is a subrange of it. The recording's own answer is neither \u2014 it is that engine losing precision",
    rows: [
      "timestamps/timestamp_range/sub_time_duration_over",
      "timestamps/timestamp_range/sub_time_duration_under",
    ],
  },
  {
    cause: "a comparison across the numeric types converts, and the conversion is lossy",
    authority:
      "cel-spec compares an integer against a double by converting the integer, so `dyn(9223372036854775807) < 9223372036854775808.0` is false \u2014 both sides are 2^63 as doubles \u2014 and only the sign decides where the double lies outside the integer type's range. Its own corpus names the case (`not_lt_dyn_int_big_lossy_double`) and comments it: 'the conversion of the int to double is lossy'. Each row carries cel-spec's answer under `deviation.celSpec`. An exact comparison is defensible on its own and indefensible as a cross-engine contract: a second engine on a conformant library would answer the other way on a comparison that can decide an authorization or a retry bound",
    rows: [
      "comparisons/lt_literal/not_lt_dyn_int_big_lossy_double",
      "comparisons/gte_literal/gte_dyn_int_big_lossy_double",
      "comparisons/gt_literal/not_gt_dyn_big_double_int",
      "comparisons/lte_literal/lte_dyn_big_double_int",
    ],
  },
  {
    cause: "int() refuses a double at or beyond either int64 extreme",
    authority:
      "cel-spec refuses both ends alike, and `deviation.celSpec.error` is `range`. The double nearest `-9223372036854775808` IS that number exactly, so an engine that refuses only the positive end accepts one extreme and refuses the other for no reason a reader could state \u2014 which is what this engine did",
    rows: ["conversions/int/double_int_min_range"],
  },
  {
    cause: "a duration's getMilliseconds answers the component, not the total",
    authority:
      "cel-spec records 321 for `duration('123.321456789s').getMilliseconds()` under `deviation.celSpec`, and the engine's own timestamp getter has always answered the component \u2014 so answering the total made the engine contradict itself across two types for one field name. The recording's 123321 is that other reading",
    rows: ["timestamps/duration_converters/get_milliseconds"],
  },
] as const;

export const VALUE_CORRECTIONS: ReadonlyMap<string, string> = new Map(
  VALUE_CORRECTION_GROUPS.flatMap((group) =>
    group.rows.map((row) => [row, `${group.cause}: ${group.authority}`] as const),
  ),
);

/**
 * The reasons a row's recorded VALUE stands although cel-spec differs — **four of the five the
 * check level declares**, `evaluation-answer` having no counterpart here: the rows it covers
 * are ones whose check agrees and whose VALUE this driver corrects, so at this level they are
 * corrections rather than exclusions. And **the guard that keeps the set closed:**
 *
 * **Every reason is a fact about the row's INPUT, or about which SEAM answers it.** A library
 * this engine does not ship, a cel-spec feature it does not carry, a container Telo never
 * declares, a declaration the format could not carry — none of those is a statement about
 * what the engine computes. A disagreement about what the engine itself computes, reports or
 * prints is a **correction with a cited authority, or a defect**: never an exclusion. That is
 * the whole reason the set can stay at five, and the test to apply to any proposed sixth —
 * if the sentence would describe the engine's own answer, the answer is what to change.
 */
export type ValueExclusionReason =
  /** A cel-go extension library Telo does not ship, so its own semantics do not bind. */
  | "extension-library"
  /** A cel-spec feature this engine does not carry. */
  | "feature-not-carried"
  /** The answer depends on a container, which Telo never declares. */
  | "container-not-declared"
  /** The row's own declaration could not be carried into the format. */
  | "uncarried-input";

export interface ValueExclusionGroup {
  readonly reason: ValueExclusionReason;
  readonly because: string;
  /**
   * Whether the rows the CHECK-level list names for this reason are excluded here too. They
   * are the same facts about the same inputs, so the membership is read from that one
   * declaration rather than written twice — two lists of ids are two answers to "is this row's
   * input carryable".
   */
  readonly alsoAtCheckLevel: boolean;
  /** Rows excluded only here, where the check level has no disagreement to excuse. */
  readonly ids: readonly string[];
  /**
   * cel-spec inputs the format could not carry, read from each row's own
   * `deviation.uncarried`. A row is named by the fact rather than by its id: `disable_check`
   * says cel-spec's value comes from an evaluation with the CHECK TURNED OFF, and this engine
   * always checks — so the two are not answering the same question, and listing thirty ids
   * would only hide that it is one fact.
   *
   * **It applies only where this engine actually REFUSES at check**, because that is the whole
   * content of the reason: a row this engine checks clean is not answering a different
   * question, and matching on the fact alone pulled in eight such rows — seven of which cel-spec
   * never contradicted at all, so they were `matched` rows counted as excluded.
   */
  readonly uncarriedInputs?: readonly string[];
  /** Pinned: a row that joins or leaves the group fails the gate. */
  readonly rows: number;
}

export const VALUE_EXCLUSION_GROUPS: readonly ValueExclusionGroup[] = [
  {
    reason: "extension-library",
    because:
      "Telo ships no cel-go extension library, so what one of them computes does not bind this engine. Two kinds of row sit here. In most, the engine resolves no such function and refuses, exactly as the recording does, while cel-spec answers a value. In the five `string_ext` casing and trim rows the engine DOES answer, because this library declares a member of that name for the manifests already written against it — and cel-spec defines no such member, so its recorded answer is the extension's semantics rather than the language's and does not bind; the member's own `spec: false` reason names the difference, which is where that belongs",
    alsoAtCheckLevel: true,
    ids: [
      "string_ext/ascii_casing/lowerascii_unicode",
      "string_ext/ascii_casing/lowerascii_unicode_with_space",
      "string_ext/ascii_casing/upperascii_unicode",
      "string_ext/trim/unicode_space_chars_1",
      "string_ext/trim/unicode_no_trim",
    ],
    rows: 552,
  },
  {
    reason: "feature-not-carried",
    because:
      "cel-spec deduces a type parameter out of a `type` VALUE, which needs a parameterized type type this engine does not carry; the rows evaluate as the recording does",
    alsoAtCheckLevel: true,
    ids: [],
    rows: 4,
  },
  {
    reason: "container-not-declared",
    because:
      "the answer is a name resolved through a container, and Telo declares none — the engine must not invent one, so a bare name reads the declaration of that name",
    alsoAtCheckLevel: true,
    ids: [],
    rows: 3,
  },
  {
    reason: "uncarried-input",
    because:
      "an input of the row cel-spec's own test carried and the format could not: a function declaration its `type_env` holds, so no engine is given the function the row calls — or, for most of these rows, `disable_check`, which means cel-spec's recorded value is what an evaluation answers with the CHECK TURNED OFF. This engine always checks before it evaluates, as the vectors' own row protocol says, so an ill-typed expression answers the checker's refusal; cel-spec's value for it is the answer to a different question. The rows are named by that fact, read from their own `deviation.uncarried`, not by a list of ids",
    alsoAtCheckLevel: true,
    ids: [],
    uncarriedInputs: ["disable_check"],
    rows: 57,
  },
];

function exclusionFor(row: LanguageRow, refusedAtCheck: boolean): ValueExclusionGroup | undefined {
  const atCheckLevel = specExclusion(row.id)?.reason;
  return VALUE_EXCLUSION_GROUPS.find(
    (group) =>
      group.ids.includes(row.id) ||
      (group.alsoAtCheckLevel && atCheckLevel === group.reason) ||
      (refusedAtCheck &&
        (group.uncarriedInputs ?? []).some((input) => row.deviation?.uncarried?.includes(input))),
  );
}

/**
 * Whether cel-spec's answer for this row is about the TYPE alone — a statement the CHECK seam
 * answers, which the driver beside this one holds the engine to.
 *
 * It is not a free pass: the row must be accounted for over there, on a correction or an
 * exclusion list, and this driver fails it if it is not. That is what keeps the two drivers
 * from each dropping a row the other assumed.
 */
function answeredByTheCheckSeam(row: LanguageRow): boolean {
  const celSpec = row.deviation?.celSpec;
  if (!celSpec || !("type" in celSpec) || "value" in celSpec || "error" in celSpec) return false;
  // **A CORRECTION, not merely an exclusion.** The other driver holds a corrected row to
  // cel-spec's own recorded type, so deferring to it says something; an exclusion pins no type
  // of its own, so deferring to one would be two drivers each assuming the other asked.
  return SPEC_CORRECTIONS.has(row.id);
}

/**
 * Rows where the engine answers **neither** side, and the classification is a decision
 * nobody has taken yet.
 *
 * This is not a third way of excusing a row: each entry pins the engine's exact answer,
 * so the gate holds it just as tightly as a matched row, and the question is written down
 * where the next reader of the gate meets it. A row leaves this list by a decision, in one
 * of two directions — the engine adopts cel-spec's answer, or a reason joins the closed
 * exclusion set — and either way the list is meant to be empty.
 */
export interface ValuePendingDecision {
  /** What has to be decided, in full, for someone who has not read the rows. */
  readonly question: string;
  /** Each row and the engine's own answer, as the encoding writes it, or `"error"`. */
  readonly answers: readonly { readonly id: string; readonly answers: string }[];
}

export const VALUE_PENDING_DECISIONS: readonly ValuePendingDecision[] = [];

function pendingFor(id: string): { readonly question: string; readonly answers: string } | undefined {
  for (const pending of VALUE_PENDING_DECISIONS) {
    const held = pending.answers.find((row) => row.id === id);
    if (held) return { question: pending.question, answers: held.answers };
  }
  return undefined;
}

/** The environment a row is EVALUATED in: its functions, and none of its declarations. */
export function evaluationEnvironment(base: CelEnvironment, row: LanguageRow): CelEnvironment {
  if (!row.functions || row.functions.length === 0) return base;
  const environment = base.clone();
  // A row's declared function is cel-spec's `type_env` with no implementation behind it,
  // so a call to it fails — which is exactly what the row records.
  for (const declared of row.functions) environment.registerFunction(declared.signature);
  return environment;
}

export function activationOf(row: LanguageRow): Record<string, CelValue> {
  const activation: Record<string, CelValue> = Object.create(null) as Record<string, CelValue>;
  for (const [name, node] of Object.entries(row.bindings ?? {})) {
    activation[name] = decodeConformanceValue(node as ConformanceValue);
  }
  return activation;
}

/**
 * What the engine answers for a row. Checking comes first, as the vectors' own protocol
 * says: an ill-typed expression answers the checker's refusal rather than being run.
 */
function answerOf(environment: CelEnvironment, row: LanguageRow): Answer {
  const expression = environment.parse(row.source);
  if (expression.diagnostics.length > 0) {
    return {
      kind: "error",
      stage: "syntax",
      why: `syntax: ${expression.diagnostics[0]!.message.split("\n")[0]}`,
    };
  }
  const checked = environment.check(expression);
  if (checked.diagnostics.length > 0) {
    const first = checked.diagnostics[0]!;
    return {
      kind: "error",
      stage: "check",
      why: `${first.code}: ${first.message.split("\n")[0]}`,
      message: first.message,
      range: first.range,
    };
  }
  try {
    return { kind: "value", value: environment.compile(expression).evaluate(activationOf(row)) };
  } catch (cause) {
    if (cause instanceof CelEvaluationError) {
      return {
        kind: "error",
        stage: "evaluation",
        why: `${cause.code}: ${cause.message}`,
        message: cause.message,
        ...(cause.range ? { range: cause.range } : {}),
      };
    }
    throw cause;
  }
}

/**
 * Whether cel-spec has an answer of its own for this row — a value, a type or an error.
 *
 * **This is the invariant's other direction, and it was missing.** The `matched` bucket means
 * "the engine agrees with the recording", and a row can sit in it while cel-spec says
 * something else entirely: the engine would then be following the recording silently, which
 * is exactly what the two lists exist to make impossible. So a row cel-spec answered must be
 * on a list whichever way the engine went, and `matched` is for rows cel-spec was never asked
 * about.
 */
function carriesACelSpecAnswer(row: LanguageRow): boolean {
  const celSpec = row.deviation?.celSpec;
  if (!celSpec) return false;
  return "value" in celSpec || "type" in celSpec || "error" in celSpec;
}

/**
 * Whether an answer is the one a recorded value or error asks for, and why not.
 *
 * A recorded value is `unknown` until the encoding reads it — which is what the decode below
 * does, inside a `try`, so a row whose own value the encoding refuses is reported as that
 * rather than crashing the driver. Declaring the parameter as already-decoded would be a type
 * the rows do not have.
 */
function agreementWith(
  answer: Answer,
  expected: { readonly value?: unknown; readonly error?: unknown },
): string | undefined {
  if (expected.error !== undefined) {
    return answer.kind === "error" ? undefined : `answered ${describeValue(answer.value)} where the row fails`;
  }
  if (answer.kind === "error") return `failed (${answer.why}) where the row answers a value`;
  let recorded: string;
  try {
    recorded = conformanceText(decodeConformanceValue(expected.value as ConformanceValue));
  } catch (cause) {
    return `the row's own value cannot be read: ${(cause as Error).message}`;
  }
  let written: string;
  try {
    written = conformanceText(answer.value);
  } catch (cause) {
    return `answered a value the encoding refuses: ${(cause as Error).message}`;
  }
  return written === recorded ? undefined : `answered ${written} where the row records ${recorded}`;
}

/**
 * Whether a corrected row's answer is the one cel-spec records. This is what keeps the
 * corrections list evidence rather than an exemption: a row listed as corrected must
 * answer cel-spec's own value, or fail cel-spec's own way.
 */
function agreementWithCelSpec(answer: Answer, row: LanguageRow): string | undefined {
  const celSpec = row.deviation?.celSpec;
  if (!celSpec) return undefined;
  if ("value" in celSpec) {
    return agreementWith(answer, { value: celSpec.value as ConformanceValue });
  }
  if ("error" in celSpec) {
    return answer.kind === "error"
      ? undefined
      : `answered ${describeValue(answer.value)} where cel-spec fails (${String(celSpec.error)})`;
  }
  return undefined;
}

export function replayLanguageValues(rows: readonly LanguageRow[]): ValueReplayReport {
  const failures: ValueReplayFailure[] = [];
  const correctionsSeen: string[] = [];
  const exclusionsSeen: string[] = [];
  const unaccounted: string[] = [];
  const pendingSeen: string[] = [];
  const messagesMatched: string[] = [];
  const checkSeamRows: string[] = [];
  const correctedRows = new Map<string, number>();
  const excludedRows = new Map<ValueExclusionGroup, number>();
  const base = languageEnvironment();
  let driven = 0;
  let matched = 0;
  let recordedValue = 0;
  let recordedError = 0;

  for (const row of rows) {
    driven += 1;
    if ("value" in row.expect) recordedValue += 1;
    else if (row.expect.error !== undefined) recordedError += 1;

    const answer = answerOf(evaluationEnvironment(base, row), row);
    const disagreement = agreementWith(answer, row.expect);
    const corrected = VALUE_CORRECTIONS.get(row.id);
    const exclusion = exclusionFor(row, answer.kind === "error" && answer.stage === "check");

    if (corrected !== undefined) {
      correctionsSeen.push(row.id);
      correctedRows.set(row.id, 1);
      if (!disagreement) {
        failures.push({
          id: row.id,
          source: row.source,
          reason: "listed as a value correction, but the engine now answers the row — remove the entry",
        });
        continue;
      }
      const against = agreementWithCelSpec(answer, row);
      if (against) {
        failures.push({ id: row.id, source: row.source, reason: `corrected against cel-spec, but ${against}` });
      }
      continue;
    }

    if (exclusion) {
      exclusionsSeen.push(row.id);
      excludedRows.set(exclusion, (excludedRows.get(exclusion) ?? 0) + 1);
      if (disagreement) {
        failures.push({
          id: row.id,
          source: row.source,
          reason: `excluded as ${exclusion.reason}, which means the engine answers the row — and it ${disagreement}`,
        });
      }
      continue;
    }

    const pending = pendingFor(row.id);
    if (pending) {
      pendingSeen.push(row.id);
      const written = answer.kind === "error" ? "error" : describeValue(answer.value);
      if (written !== pending.answers) {
        failures.push({
          id: row.id,
          source: row.source,
          reason: `awaits a decision and is pinned to answer ${pending.answers}, and it answered ${written}`,
        });
      }
      continue;
    }

    if (!disagreement && answeredByTheCheckSeam(row)) {
      checkSeamRows.push(row.id);
      continue;
    }

    if (!disagreement && !carriesACelSpecAnswer(row)) {
      matched += 1;
      if (RECORDED_MESSAGE_ROWS.includes(row.id)) {
        const written =
          answer.kind === "error" && answer.message !== undefined && answer.range !== undefined
            ? highlighted(answer.message, row.source, answer.range[0])
            : undefined;
        if (written !== row.expect.error?.message) {
          failures.push({
            id: row.id,
            source: row.source,
            reason: `is held to the recorded error text and wrote ${JSON.stringify(written)} where the row records ${JSON.stringify(row.expect.error?.message)}`,
          });
        } else messagesMatched.push(row.id);
      }
      continue;
    }
    unaccounted.push(row.id);
    failures.push({
      id: row.id,
      source: row.source,
      reason:
        disagreement ??
        `answers the row, and cel-spec answers ${JSON.stringify(row.deviation?.celSpec)} — which list accounts for it?`,
    });
  }

  return {
    rows: rows.length,
    driven,
    recordedValue,
    recordedError,
    matched,
    correctionsSeen,
    exclusionsSeen,
    pendingSeen,
    checkSeamRows,
    messagesMatched,
    unaccounted,
    failures,
    correctionCounts: VALUE_CORRECTION_GROUPS.map((group) => ({
      cause: group.cause,
      rows: group.rows.filter((row) => correctedRows.has(row)).length,
      pinned: group.rows.length,
    })),
    exclusionCounts: VALUE_EXCLUSION_GROUPS.map((group) => ({
      reason: group.reason,
      rows: excludedRows.get(group) ?? 0,
      pinned: group.rows,
    })),
    notCompared: [
      {
        expectation: "expect.error.code and .message",
        rows: rows.filter((row) => row.expect.error !== undefined).length,
        because:
          "a recorded error's code is always null and its wording is the engine being replaced's; a row recorded as failing is held to failing, at a code and a range this engine decides",
      },
    ],
  };
}
