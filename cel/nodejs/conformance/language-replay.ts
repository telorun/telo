/**
 * Replaying the CEL conformance vectors' language rows.
 *
 * The vectors are rows of "expression, and what a CEL engine answers for it". This
 * driver answers the reading and the checking halves of a row — whether the source
 * reads, whether it checks, the type it checks to, and where a refusal points — and
 * **says what it defers**: every expectation it does not answer is reported with the
 * card that owns it, because a driver that answers half a file without naming the half
 * is how a gap survives to a later gate.
 *
 * What it holds the engine to, per row:
 *
 * 1. A row recorded as checking must read and check, **to the recorded type**, spelled
 *    exactly as the row spells it.
 * 2. A row recorded as refused must be refused, at the offset the recorded message's
 *    caret points at.
 * 3. Whatever reads must write back and re-read to an equal tree.
 *
 * Rows where this engine answers cel-spec rather than the recording are listed, with the
 * authority for each, in `SPEC_CORRECTIONS` — asserted to be **exactly** the set that
 * differs, so a new disagreement fails rather than hides.
 */

import { CelEnvironment } from "../src/environment.js";
import { serializeTree } from "../src/serializer.js";
import { hasUnparsed } from "../src/syntax-tree.js";
import { treesEqual } from "../src/tree-equality.js";

export interface RecordedError {
  readonly code: string | null;
  readonly message: string;
}

export interface RecordedVerdict {
  readonly type?: string;
  readonly diagnostics?: readonly RecordedError[];
}

export interface LanguageRow {
  readonly id: string;
  readonly source: string;
  readonly expect: {
    readonly check?: RecordedVerdict;
    readonly value?: unknown;
    readonly error?: RecordedError;
  };
  readonly declarations?: Readonly<Record<string, unknown>>;
  readonly functions?: readonly { readonly signature: string }[];
  readonly bindings?: Readonly<Record<string, unknown>>;
  readonly deviation?: {
    readonly celSpec?: Readonly<Record<string, unknown>>;
    readonly uncarried?: readonly string[];
  };
  readonly divergence?: unknown;
}

export interface ReplayFailure {
  readonly id: string;
  readonly source: string;
  readonly reason: string;
}

/** An expectation this driver does not answer, and what does answer it. */
export interface ElsewhereExpectation {
  readonly expectation: string;
  readonly rows: number;
  /** The driver that holds the engine to it. */
  readonly answeredBy: string;
  readonly because: string;
}

/** An expectation no engine but the one being replaced can reproduce. */
export interface IncomparableExpectation {
  readonly expectation: string;
  readonly rows: number;
  readonly because: string;
  /** What is compared instead. */
  readonly insteadCompared: string;
}

export interface LanguageReplayReport {
  readonly rows: number;
  readonly driven: number;
  readonly recordedChecking: number;
  readonly recordedRefused: number;
  readonly checkedToRecordedType: number;
  readonly refusedAtRecordedOffset: number;
  readonly refusedWithNoRecordedOffset: number;
  readonly roundTripped: number;
  readonly failures: readonly ReplayFailure[];
  readonly correctionsSeen: readonly string[];
  readonly exclusionsSeen: readonly string[];
  /** Rows needing a position that neither list accounts for — must be empty. */
  readonly unaccounted: readonly string[];
  readonly exclusionCounts: readonly { readonly reason: string; readonly rows: number; readonly pinned: number }[];
  readonly answeredElsewhere: readonly ElsewhereExpectation[];
  readonly incomparable: readonly IncomparableExpectation[];
}

/** The one file of the vectors this driver answers for. */
export const DRIVEN_FILE = "language.json";

/**
 * Where this engine's answer differs from the recorded one, and why.
 *
 * The vectors are a **recording of the engine being replaced** — their README says a
 * `language.json` row's `expect` is "the replaced engine's answer" — and the format already carries cel-spec's
 * own answer under `deviation.celSpec` wherever the two differ. So cel-spec is the
 * specification, the recording is evidence, and a row's own `deviation.celSpec` is the
 * authority for what this engine must answer. Each group below names that authority.
 *
 * Not called a "divergence": the vectors use that word for something else entirely — a
 * value outside the CEL value domain — and one reader mis-reading both is one too many.
 *
 * The set is asserted to be **exact**: a new disagreement fails, and one that goes away
 * fails too. Every entry is rewritten away at the cutover, mechanically, from the row's
 * own `deviation.celSpec` — not before, because the recorded engine answers every
 * consumer until then.
 */
export const SPEC_CORRECTION_GROUPS = [
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
      "fields/qualified_identifier_resolution/list_field_select_unsupported",
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
      "conversions/int/uint_range",
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
      "optionals/optionals/optional_chaining_10",
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
      "type_deduction/flexible_type_parameter_assignment/unconstrained_type_var_as_dyn",
      "type_deduction/empty_range_nested_comprehensions/empty_list_range_nested_list_comprehension",
      "type_deduction/empty_range_nested_comprehensions/empty_map_range_nested_comprehension",
      "type_deduction/empty_range_nested_comprehensions/empty_range_nested_comprehension_before_constraint",
      "type_deduction/empty_range_nested_comprehensions/empty_range_nested_comprehension_boolean_map",
      "type_deduction/empty_range_nested_comprehensions/empty_range_nested_comprehension_equality",
    ],
  },
  {
    cause: "a concatenation's element type is the one both sides hold",
    authority:
      "`type_free_param_list_concat` carries cel-spec's `list<list<type>>` directly, and the sibling row `lists/concatenation/right_unit` records `list<int>` for the mirror case; taking the left operand's element type would make the checker answer `list<int>` for `[1] + ['a']`, which holds a string",
    rows: [
      "type_deduction/type_decay/type_free_param_list_concat",
      "lists/concatenation/left_unit",
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
    cause: "the type REPORTED for an unresolved parameter is dyn",
    authority:
      "cel-spec's rule that an unresolved type parameter behaves as `dyn` wherever it is used governs the type handed out as much as every use inside the expression: a consumer reading `list<T>` would have to know what `T` means to this engine, and the answer is that nothing resolved it. Two rows carry cel-spec's own type under `deviation.celSpec.type` (`list<list<list<list<list<dyn>>>>>`), and `unconstrained_type_var_as_dyn` carries `dyn` for the same reason; the other four record the parameter the engine being replaced printed where cel-spec deduces no type at all. A parameter still survives where it is DECLARED \u2014 a signature's text, a nominal type's parameter list",
    rows: [
      "type_deduction/flexible_type_parameter_assignment/list_parameter",
      "type_deduction/flexible_type_parameter_assignment/list_parameter_order_independent",
      "basic/self_eval_zeroish/self_eval_empty_list",
      "basic/self_eval_zeroish/self_eval_empty_map",
      "lists/concatenation/empty_empty",
      "macros/filter/list_empty",
    ],
  },
] as const;

/** Every corrected row, with the authority for correcting it. */
export const SPEC_CORRECTIONS: ReadonlyMap<string, string> = new Map(
  SPEC_CORRECTION_GROUPS.flatMap((group) =>
    group.rows.map((row) => [row, `${group.cause}: ${group.authority}`] as const),
  ),
);

/**
 * Where this engine answers the **recording** although cel-spec says otherwise, and why.
 *
 * `deviation.celSpec` binds where cel-spec's language definition fixes the meaning, or
 * where a library Telo enables does. Outside that, the engine answers the recording — and
 * says so here. Every entry carries a reason from the closed set below and a **pinned row
 * count**, so a section that grows or shrinks fails the gate rather than absorbing a row.
 *
 * An exclusion is about the **verdict** first: the engine refuses an extension call for its
 * own reason (no such function) where the recording may have refused for another (its
 * syntax). Where both refuse at the same offset it is still held to that offset, and a row
 * whose position differs is named in `offsetDiffers` — exactly, as everything else here is.
 */
export type SpecExclusionReason =
  /** A cel-go extension library Telo does not ship. */
  | "extension-library"
  /** A cel-spec feature this engine does not carry. */
  | "feature-not-carried"
  /** The answer depends on a container, which Telo never declares. */
  | "container-not-declared"
  /** The row's own declaration could not be carried into the format. */
  | "uncarried-input"
  /** The check agrees; the difference is in what evaluation answers. */
  | "evaluation-answer";

export interface SpecExclusionGroup {
  readonly reason: SpecExclusionReason;
  readonly because: string;
  /** Whole files of the vectors, by their id prefix. */
  readonly files?: readonly string[];
  /** Single sections, by their `<file>/<section>` id prefix. */
  readonly sections?: readonly string[];
  readonly ids?: readonly string[];
  /** How many rows this covers. Pinned: a move fails the gate. */
  readonly rows: number;
  /** The rows of this group the engine refuses at a different offset than the recording. */
  readonly offsetDiffers?: readonly string[];
  /**
   * The rows of this group that CHECK CLEAN to a type other than the recorded one.
   *
   * An exclusion excuses a verdict, and it pins no type: a row where both engines check
   * clean to different types sat in the exclusion branch with nothing compared at all —
   * proven by a fabricated row declaring `1 + 1` to check as `string`, which the gate passed.
   * So a clean excluded row is held to the recorded type exactly as a clean unexcluded one
   * is, and a row whose type differs is named here, exactly as `offsetDiffers` names an offset.
   */
  readonly typeDiffers?: readonly string[];
}

export const SPEC_EXCLUSION_GROUPS: readonly SpecExclusionGroup[] = [
  {
    reason: "extension-library",
    because:
      "Telo ships no cel-go extension library — its own catalog is the extension layer — so a call into one is an unknown function, which is the answer the recording gives too. It covers exactly the rows whose call the engine does not RESOLVE: the `string_ext` sections whose members this library declares (`index_of`, `last_index_of`, `substring`, `trim`, `split`, `join`, `ascii_casing`) are deliberately not here, since the engine answers them, so they are compared like any other row — and a disagreement there is a defect in the member to fix, never a new exclusion",
    files: ["block_ext", "encoders_ext", "lists_ext", "macros2", "math_ext", "network_ext"],
    sections: [
      "string_ext/char_at",
      "string_ext/replace",
      "string_ext/quote",
      "string_ext/format",
      "string_ext/format_errors",
      "string_ext/type_errors",
      "string_ext/reverse",
    ],
    // The one row of a section the engine otherwise answers whose call it does not resolve.
    ids: ["string_ext/value_errors/charat_out_of_range"],
    rows: 547,
    offsetDiffers: [
      // Each writes an optional entry, which this engine now reads: it gets as far as the
      // extension call it cannot resolve, where the recording stopped at the syntax.
      "block_ext/basic/optional_list",
      "block_ext/basic/optional_map",
      "block_ext/basic/optional_map_chained",
    ],
  },
  {
    reason: "feature-not-carried",
    because:
      "a typing feature this engine does not carry, so it answers what the recording answers: cel-spec deduces a type parameter out of a `type` VALUE (`cast(x, int)` is an int), which needs a parameterized type type, and it makes `null` assignable to an abstract type's parameter candidate, where this engine unifies the two element types to `dyn`",
    ids: [
      "type_deduction/type_parameters_in_type_type/type_param_in_type_type_int",
      "type_deduction/type_parameters_in_type_type/type_param_in_type_type_string",
      "type_deduction/type_parameters_in_type_type/composite_type_param_in_type_type",
      // cel-spec deduces `optional<int>` for `[optional.of(1), null][0]` through a legacy rule
      // making null assignable to an abstract type's parameter candidate; this engine unifies
      // the two element types to `dyn`, as the recording does.
      "type_deduction/legacy_nullable_types/null_assignable_to_abstract_parameter_candidate",
    ],
    rows: 4,
    // Each checks clean and reports `dyn` where the recording records the row's own type
    // parameter: under D1 an unresolved parameter is `dyn` in the type the checker HANDS OUT,
    // so there is no spelling of `T` left for this engine to agree with.
    typeDiffers: [
      "type_deduction/type_parameters_in_type_type/type_param_in_type_type_int",
      "type_deduction/type_parameters_in_type_type/type_param_in_type_type_string",
      "type_deduction/type_parameters_in_type_type/composite_type_param_in_type_type",
    ],
  },
  {
    reason: "container-not-declared",
    because:
      "the answer is a name resolved through a container, and Telo declares none — the engine must not invent one, so a bare name reads the declaration of that name",
    ids: [
      "namespace/namespace/self_eval_container_lookup",
      "namespace/namespace_shadowing/basic",
      // Its disagreement is the container, not the `disable_check` it also carries: this
      // engine checks it clean, so the uncarried-check reason would be false of it.
      "namespace/namespace/self_eval_container_lookup_unchecked",
    ],
    rows: 3,
  },
  {
    reason: "uncarried-input",
    because:
      "the row calls a function whose declaration cel-spec's own `type_env` holds and the format could not carry (`uncarried: function …`), so no engine is given the function the row calls",
    ids: [
      "type_deduction/type_parameters/multiple_parameters_generality",
      "type_deduction/type_parameters/multiple_parameters_generality_2",
      "type_deduction/type_parameters/multiple_parameters_parameterized_ovl",
      "type_deduction/type_parameters/multiple_parameters_parameterized_ovl_2",
    ],
    rows: 4,
  },
  {
    reason: "evaluation-answer",
    because:
      "the check agrees with the recording, so there is no check-level disagreement to excuse; the difference is what EVALUATION answers — a uint index into a list, a map comprehension binding its key, and a time zone written as an offset — and the value-level replay beside this one corrects all three against cel-spec, each against the row's own `deviation.celSpec`",
    ids: [
      "lists/index/zero_based_uint",
      "macros/exists_one/map_one",
      "timestamps/timestamp_selectors_tz/getHours",
    ],
    rows: 3,
  },
];

/** Whether a group covers a row. */
function excludes(group: SpecExclusionGroup, id: string): boolean {
  const [file, section] = id.split("/");
  return (
    (group.ids?.includes(id) ?? false) ||
    (group.files?.includes(file!) ?? false) ||
    (group.sections?.includes(`${file}/${section}`) ?? false)
  );
}

export function specExclusion(id: string): SpecExclusionGroup | undefined {
  return SPEC_EXCLUSION_GROUPS.find((group) => excludes(group, id));
}

/**
 * The rows that must have a position: one of the two lists accounts for each.
 *
 * A row qualifies when cel-spec answers a **type** — always, because a type is this driver's
 * own question — or when cel-spec answers a value and the recording **fails**, at its check or
 * at its evaluation. The row must not say `disable_check`, which says nothing about checking.
 *
 * Both widenings are the same lesson twice: the evaluation half caught the five
 * dotted-declaration rows, which check clean in the recording and fail only when run, and the
 * type half caught the rows where both engines check clean to different types. A sweep is sound
 * in the direction it looks.
 */
export function needsAPosition(row: LanguageRow): boolean {
  const answer = row.deviation?.celSpec;
  if (!answer || !("value" in answer || "type" in answer)) return false;
  if (row.deviation?.uncarried?.includes("disable_check")) return false;
  // **A TYPE cel-spec answers is this driver's question whichever way the recording went.**
  // Requiring the recording to fail was the same blind spot one level over: a row where both
  // engines check clean to DIFFERENT types has no refusal anywhere in it, and sat in neither
  // list while the engine quietly followed the recording.
  if ("type" in answer) return true;
  return Boolean(row.expect.check?.diagnostics || row.expect.error);
}

/**
 * The offset the recorded message points at, read from its highlight: `> `, the line
 * number right-aligned in four columns, ` | `, the source line, then a caret under the
 * column. Nothing when the message carries no highlight.
 */
export function recordedOffset(message: string, source: string): number | undefined {
  const highlight = /\n\n(> +\d+ \| )(.*)\n( *)\^/.exec(message);
  if (!highlight) return undefined;
  const line = Number(/\d+/.exec(highlight[1]!)![0]);
  const column = highlight[3]!.length - highlight[1]!.length;
  if (column < 0) return undefined;
  const lines = source.split("\n");
  if (line < 1 || line > lines.length) return undefined;
  let offset = 0;
  for (let at = 0; at < line - 1; at += 1) offset += lines[at]!.length + 1;
  return offset + column;
}

/**
 * The language environment: CEL's own library, with unlisted names reading as `dyn`,
 * optional types on and heterogeneous aggregates allowed. Nothing else — no host
 * catalog, no host type.
 */
export function languageEnvironment(): CelEnvironment {
  return new CelEnvironment({
    unlistedVariablesAreDyn: true,
    enableOptionalTypes: true,
    homogeneousAggregateLiterals: false,
  });
}

function countRows(rows: readonly LanguageRow[], holds: (row: LanguageRow) => boolean): number {
  return rows.filter(holds).length;
}

/**
 * What this driver does not answer, and where it IS answered. Every one of these is an
 * evaluation expectation, and `value-replay.ts` holds the engine to all of them — which is
 * the point of naming them: a driver that answers half a file without saying which half is
 * how a gap survives to a later gate.
 */
function answeredElsewhere(rows: readonly LanguageRow[]): ElsewhereExpectation[] {
  return [
    {
      expectation: "expect.value",
      rows: countRows(rows, (row) => "value" in row.expect),
      answeredBy: "value-replay",
      because: "evaluating is the semantics and the backend, and the value-level replay compares every one",
    },
    {
      expectation: "expect.error",
      rows: countRows(rows, (row) => row.expect.error !== undefined),
      answeredBy: "value-replay",
      because: "a row recorded as failing is held to failing there; its code and wording are this engine's own",
    },
    {
      expectation: "bindings",
      rows: countRows(rows, (row) => row.bindings !== undefined),
      answeredBy: "value-replay",
      because: "an activation is read only by evaluation; checking reads declarations",
    },
    {
      expectation: "functions[].error",
      rows: countRows(rows, (row) => (row.functions?.length ?? 0) > 0),
      answeredBy: "value-replay",
      because: "a row's declared function is registered here for its types; that a call to it fails is evaluation's",
    },
    {
      expectation: "deviation, divergence",
      rows: countRows(rows, (row) => row.deviation !== undefined || row.divergence !== undefined),
      answeredBy: "value-replay",
      because: "both compare an evaluated answer against cel-spec's, which checking never produces; a divergence row is an ordinary row for this engine, which keeps to the value domain",
    },
  ];
}

function incomparable(rows: readonly LanguageRow[]): IncomparableExpectation[] {
  return [
    {
      expectation: "expect.check.diagnostics[].code and .message",
      rows: countRows(rows, (row) => (row.expect.check?.diagnostics?.length ?? 0) > 0),
      because:
        "a recorded diagnostic is the engine being replaced speaking: its code is always null and its wording is its own, while this engine decides a code of its own for each cause",
      insteadCompared: "that the row is refused, and the offset the recorded highlight points at",
    },
  ];
}

/** Applies a row's declarations and declared functions to a copy of the environment. */
function environmentFor(base: CelEnvironment, row: LanguageRow): CelEnvironment {
  if (!row.declarations && !row.functions) return base;
  const environment = base.clone();
  for (const [name, declaration] of Object.entries(row.declarations ?? {})) {
    environment.registerVariable(name, declaration as string);
  }
  for (const declared of row.functions ?? []) environment.registerFunction(declared.signature);
  return environment;
}

export function replayLanguageRows(rows: readonly LanguageRow[]): LanguageReplayReport {
  const failures: ReplayFailure[] = [];
  const correctionsSeen: string[] = [];
  const exclusionsSeen: string[] = [];
  const unaccounted: string[] = [];
  const excludedRows = new Map<SpecExclusionGroup, number>();
  const base = languageEnvironment();
  let driven = 0;
  let recordedChecking = 0;
  let recordedRefused = 0;
  let checkedToRecordedType = 0;
  let refusedAtRecordedOffset = 0;
  let refusedWithNoRecordedOffset = 0;
  let roundTripped = 0;

  for (const row of rows) {
    driven += 1;
    const recorded = row.expect.check?.diagnostics ?? [];
    const refusedByVectors = recorded.length > 0;
    if (refusedByVectors) recordedRefused += 1;
    else recordedChecking += 1;

    const problems: string[] = [];
    const environment = environmentFor(base, row);
    const expression = environment.parse(row.source);

    // **Reading and writing back is asserted on every row, corrected or not.** A correction is
    // about a VERDICT, so suppressing the round trip along with it would let a listed row stop
    // serializing and say nothing — the one assertion here that has nothing to do with what
    // cel-spec says.
    if (expression.diagnostics.length === 0) {
      if (hasUnparsed(expression.root)) {
        failures.push({
          id: row.id,
          source: row.source,
          reason: "read with no diagnostic but left an unparsed hole in the tree",
        });
      } else {
        const written = serializeTree(expression.root);
        const reread = environment.parse(written);
        if (reread.diagnostics.length > 0) {
          failures.push({
            id: row.id,
            source: row.source,
            reason: `wrote ${JSON.stringify(written)}, which does not read back`,
          });
        } else if (!treesEqual(expression.root, reread.root)) {
          failures.push({
            id: row.id,
            source: row.source,
            reason: `wrote ${JSON.stringify(written)}, which reads back as a different expression`,
          });
        } else {
          roundTripped += 1;
        }
      }
    }

    const result = environment.check(expression);
    const refused = result.diagnostics.length > 0;
    const exclusion = specExclusion(row.id);
    if (exclusion) {
      excludedRows.set(exclusion, (excludedRows.get(exclusion) ?? 0) + 1);
      exclusionsSeen.push(row.id);
    }
    if (needsAPosition(row) && !SPEC_CORRECTIONS.has(row.id) && !exclusion) unaccounted.push(row.id);
    if (exclusion) {
      if (refused !== refusedByVectors) {
        problems.push(
          refused
            ? `refused (${result.diagnostics[0]!.code}) a row the vectors check, and is listed as ${exclusion.reason}`
            : `checked clean as ${result.typeName} where the vectors refuse, and is listed as ${exclusion.reason}`,
        );
      } else if (refused) {
        const offset = recordedOffset(recorded[0]!.message, row.source);
        const mine = result.diagnostics[0]!.range[0];
        const listed = exclusion.offsetDiffers?.includes(row.id) ?? false;
        if (offset !== undefined && (offset !== mine) !== listed) {
          problems.push(
            listed
              ? `is listed as refusing at a different offset, and refuses at ${mine} as the vectors do`
              : `refuses at ${mine} where the vectors refuse at ${offset}, and its group does not list it`,
          );
        }
      } else {
        // **Both check clean, and an exclusion pins no type.** This branch compared nothing at
        // all, so a row whose type the engine reports differently passed as agreement.
        const listed = exclusion.typeDiffers?.includes(row.id) ?? false;
        const recordedType = row.expect.check?.type;
        if ((result.typeName !== recordedType) !== listed) {
          problems.push(
            listed
              ? `is listed as checking to a different type, and checked to ${result.typeName} as the vectors do`
              : `checked to ${result.typeName} where the vectors record ${recordedType}, and its group does not list it`,
          );
        }
      }
    } else if (refusedByVectors) {
      if (!refused) {
        problems.push(
          `checked clean as ${result.typeName} where the vectors refuse: ${recorded[0]!.message.split("\n")[0]}`,
        );
      } else {
        const offset = recordedOffset(recorded[0]!.message, row.source);
        if (offset === undefined) refusedWithNoRecordedOffset += 1;
        else if (offset !== result.diagnostics[0]!.range[0]) {
          problems.push(
            `refused at ${result.diagnostics[0]!.range[0]} (${result.diagnostics[0]!.code}: ${result.diagnostics[0]!.message.split("\n")[0]}) where the vectors refuse at ${offset}: ${recorded[0]!.message.split("\n")[0]}`,
          );
        } else refusedAtRecordedOffset += 1;
      }
    } else if (refused) {
      problems.push(
        `refused (${result.diagnostics[0]!.code}: ${result.diagnostics[0]!.message.split("\n")[0]}) a row the vectors check as ${row.expect.check?.type}`,
      );
    } else if (result.typeName !== row.expect.check?.type) {
      problems.push(`checked to ${result.typeName} where the vectors record ${row.expect.check?.type}`);
    } else {
      checkedToRecordedType += 1;
    }

    const corrected = SPEC_CORRECTIONS.has(row.id);
    if (corrected) {
      correctionsSeen.push(row.id);
      // **A correction is evidence, not an exemption**: where the row carries cel-spec's own
      // type, the engine is held to THAT type rather than merely excused from the recording's.
      const against = row.deviation?.celSpec?.type;
      if (typeof against === "string" && !refused && result.typeName !== against) {
        failures.push({
          id: row.id,
          source: row.source,
          reason: `is corrected against cel-spec, which records the type ${against}, and checked to ${result.typeName}`,
        });
      }
      if (typeof against === "string" && refused) {
        failures.push({
          id: row.id,
          source: row.source,
          reason: `is corrected against cel-spec, which records the type ${against}, and was refused (${result.diagnostics[0]!.code})`,
        });
      }
    }
    if (problems.length > 0 && !corrected) {
      for (const reason of problems) failures.push({ id: row.id, source: row.source, reason });
    }
    if (problems.length === 0 && corrected) {
      failures.push({
        id: row.id,
        source: row.source,
        reason: "listed as a spec correction, but the engine now agrees with the row — remove the entry",
      });
    }
  }

  return {
    rows: rows.length,
    driven,
    recordedChecking,
    recordedRefused,
    checkedToRecordedType,
    refusedAtRecordedOffset,
    refusedWithNoRecordedOffset,
    roundTripped,
    failures,
    correctionsSeen,
    exclusionsSeen,
    unaccounted,
    exclusionCounts: SPEC_EXCLUSION_GROUPS.map((group) => ({
      reason: group.reason,
      rows: excludedRows.get(group) ?? 0,
      pinned: group.rows,
    })),
    answeredElsewhere: answeredElsewhere(rows),
    incomparable: incomparable(rows),
  };
}
