# CEL conformance vectors

Telo's CEL behaviour, frozen as data. Every file here is a set of rows, each an expression and exactly what a Telo CEL engine answers for it — as the Node engine (`@telorun/templating`) answers it. Every engine runs every row and must reproduce every answer; the rows are the contract, and this README is their format.

The files split along one line:

- **`language.json`** — the bare CEL language: cel-spec's `simple` conformance suite as the language environment answers it.
- The dialect files — Telo's function catalog, its types, interpolation holes, module calls and the analyzer-facing verdicts — arrive with their own sections of this README.

## Files

A file is one JSON object:

```json
{ "celSpec": { "commit": "<sha>" }, "rows": [ … ] }
```

`celSpec.commit` is the cel-spec commit the rows were imported from. `rows` is the list of rows, in import order.

## Rows

A row is an object with these keys. A key whose value would be empty is omitted — except `expect`, which every row carries.

- `id` — unique in the file. For a language row, `<file-stem>/<section>/<test>` of the cel-spec test it came from; where a section repeats a test name, the n-th occurrence (n ≥ 2), counted in cel-spec file order before any test is dropped, is `<file-stem>/<section>/<test>#<n>`.
- `source` — the CEL expression.
- `provenance` — `{ "file", "section", "test" }`: the cel-spec file (relative to the cel-spec root), section name and test name (the bare name, without an `id`'s occurrence suffix).
- `declarations` — variable name → its type, spelled exactly as cel-js prints a type: `int`, `uint`, `double`, `bool`, `string`, `bytes`, `null`, `dyn`, `list<int>`, `map<string, int>`, `optional<int>`, `google.protobuf.Timestamp`, `google.protobuf.Duration`.
- `functions` — functions the row declares, each `{ "signature", "result" }` or `{ "signature", "error" }`. `signature` is a cel-js signature (`fn(string, int): string`, `int.fn(): int` for a receiver call, a single capital letter for a type parameter). A call returns `result` (a conformance value), or throws an error whose message is the `error` string.
- `bindings` — variable name → its value at evaluation, a conformance value.
- `expect` — the answer; see below.
- `deviation` — where the answer differs from cel-spec's, or the row could not carry a cel-spec input; see below.
- `divergence` — the Node engine's answer leaves the CEL value domain, so `expect` is not its answer; see [Divergences](#divergences).

A row carrying any other key is malformed.

## `expect`

`expect.check` is the verdict of the type check: `{ "type": "<type>" }` when it passes — the type as cel-js's check prints it, where a top-level `list<dyn>` is `list` and a top-level `map<dyn, dyn>` is `map` — or `{ "diagnostics": [ <error> ] }` when parsing or checking fails.

Then exactly one of:

- `value` — the evaluation result, a conformance value;
- `error` — the error evaluation threw.

A runner computes the whole `expect` and compares it to the row's by deep equality. Nothing is compared partially.

### Errors

An error is `{ "code", "message" }`:

- `code` is the Telo error code the error carries (`ERR_…`), else `null`. The engine's own error codes are never recorded.
- `message` is the full message as thrown. When the error has a location in the expression, the message is the summary, a blank line, and a highlight: `> `, the line number right-aligned in four columns, ` | `, the source line, a newline, then spaces and a `^` under the column. Columns count UTF-16 code units.

## Conformance values

One encoding carries every value — bindings, results, function results and cel-spec's own values in a deviation. It is the typed frame (`kernel/specs/durable-execution.md` §6) held as a JSON value rather than as text: a string, bool, null and finite double are themselves; an int, uint, bytes, timestamp, duration, a non-finite or negative-zero double and a map that is not a plain string-keyed object are tagged under `$telo`, with the frame's canonical payloads and orders. On top of the frame, two forms under the reserved key `$cel`:

```json
{ "$cel": "type", "value": "google.protobuf.Duration" }
{ "$cel": "optional", "value": <conformance value> }
{ "$cel": "optional" }
```

A type value carries its name as cel-js prints it (`int`, `list`, `null`, `type`, `google.protobuf.Timestamp`), and decodes to the type value the language environment names under it. An optional holds a value, or is none. Both forms nest anywhere a frame value may.

`$cel` is reserved exactly as `$telo` is: a data map with `$cel` (or `$telo`) as a key is written as a tagged `map`.

There is no opaque form. A value that cannot be written — one outside the CEL value domain, or one that does not read back to the same encoding — is an error in generation, never a stand-in; the one out-of-domain result a row records is a divergence (see [Divergences](#divergences)), and it records it as an error, not as a value. A reader refuses a node that is not the canonical encoding of the value it reads.

## Language rows

A language row runs against the **language environment**: cel-js's built-ins under Telo's options (unlisted variables are `dyn`, optional types enabled, heterogeneous aggregate literals allowed) and nothing else — no Telo function catalog, no `Stream` type. The Telo dialect environment is built on it.

A language row drives the language's own seams, and every row runs both halves:

- **Check** — a copy of the language environment plus the row's `declarations` and `functions`, then the engine's type check of `source`.
- **Evaluate** — a copy of the language environment plus the row's `functions` but **without** its `declarations`; `source` is parsed and evaluated with `bindings` as the activation, and a result that is a promise is awaited. Evaluation type-checks first, so an ill-typed expression evaluates to the checker's error; that is what the row records.

### From cel-spec

Every kept cel-spec `simple` test is one row, and its `expect` is the Node engine's answer — except in a divergence row. What cel-spec says goes into `deviation`, only where it differs.

| cel-spec | Row |
| --- | --- |
| `expr` | `source` |
| file, section and test name | `id`, `provenance` |
| `type_env` identifier | `declarations`, the type in cel-js spelling (`optional_type` is `optional<…>`, a well-known Timestamp or Duration is `google.protobuf.Timestamp` / `google.protobuf.Duration`) |
| `type_env` function overload | a `functions` entry whose `error` is `cel-spec declares this function without an implementation`; an overload cel-js's signature grammar cannot state is uncarried |
| `bindings` | `bindings`; cel-spec's `int64`, `uint64`, `double`, `string`, `bytes`, `bool`, `null`, list, map, type (`null_type` is `null`), Timestamp and Duration are the CEL values of the same type |
| `container`, `disable_check`, `disable_macros`, `check_only` | uncarried: the row always checks and evaluates, with no container and with macros |
| no result matcher | an expectation of `true` |
| `value` | compared with the evaluation result |
| `typed_result` | its result compared with the evaluation result (unless `check_only`), its deduced type with `expect.check` |
| `eval_error`, `any_eval_errors` | compared as "an error": any error agrees, whatever its message |
| `unknown`, `any_unknowns` | recorded as cel-spec's outcome whenever the engine answers otherwise |

Values compare by CEL equality including the type: an int, a uint and a double are never equal; NaN equals NaN; `-0` equals `0`; maps compare regardless of order.

### `deviation`

`deviation` has at least one of:

- `celSpec` — cel-spec's outcome, where it differs from `expect`: `{ "value": <conformance value> }`, `{ "error": "<cel-spec's message text>" }`, `{ "unknown": [ <expression ids> ] }` or `{ "type": "<cel-spec's deduced type in cel-js spelling>" }`. A `typed_result` whose value and type both differ carries both `value` and `type`.
- `uncarried` — the cel-spec inputs the row could not carry: `container`, `disable_check`, `disable_macros`, `check_only`, or `function <overload id>` for a function declaration cel-js's signature grammar cannot state.

### What is dropped

A cel-spec test is dropped exactly when it constructs, declares, binds or names a protobuf message or enum type outside Telo's CEL value domain: the test protos (`TestAllTypes`, `NestedMessage`, `NestedTestAllTypes`, `NestedEnum`, `GlobalEnum`, `TestRequired`, `Proto2ExtensionScopedMessage`), enum values, the `google.protobuf` wrappers (`BoolValue`, `BytesValue`, `DoubleValue`, `FloatValue`, `Int32Value`, `Int64Value`, `StringValue`, `UInt32Value`, `UInt64Value`), `Any`, `Struct`, `Value`, `ListValue`, `NullValue`, `Empty` and `FieldMask`. `google.protobuf.Timestamp` and `google.protobuf.Duration` are CEL's timestamp and duration, and are kept. Every extension-library file (`string_ext`, `math_ext`, `lists_ext`, `encoders_ext`, `bindings_ext`, `block_ext`, `network_ext`, `optionals`, …) is kept: the engine's answer — usually a rejection — is what pins which extensions it lacks. Nothing is dropped for what the engine accepts.

## Divergences

The Node engine does not keep every result inside the CEL value domain: some operations that cel-spec expects to fail return an int beyond int64, a uint beyond uint64, a timestamp outside 0001-01-01T00:00:00Z … 9999-12-31T23:59:59.999999999Z, or a duration beyond ±315,576,000,000.999999999s. Such a value cannot be written as a conformance value, and an engine that keeps to the domain answers with an error.

A language row is a **divergence row** exactly when cel-spec expects an evaluation error (`eval_error` / `any_eval_errors`), the Node engine evaluates without error, and its result itself — not a value nested inside it — is outside the domain. Any other out-of-domain value is an error in generation. In a divergence row:

- `expect.check` is the Node engine's check verdict, as in any row.
- `expect.error` is the domain-keeping answer, and the only `expect` in any file that is not the Node engine's: `{ "code": null, "message": … }`, the message a fixed summary for the condition followed by the usual highlight under the expression node that produced the out-of-domain value (for a binary operator, the start of its left operand, as the engine highlights its own operator errors). The summaries are `integer overflow: <the exact decimal result>` for an int operator, `int() type error: integer overflow` for `int()` of a double, `Unsigned integer overflow` for a uint operator, `uint() type error: unsigned integer overflow` for `uint()` of a double, `timestamp out of range` and `duration out of range` for a timestamp or duration constructed or computed out of range.
- `divergence` is `{ "nodeOutOfDomain": "int" | "uint" | "google.protobuf.Timestamp" | "google.protobuf.Duration" }` — the CEL type of the Node engine's out-of-domain result.
- `deviation` may carry only `celSpec.type` and `uncarried`: `expect` already is cel-spec's outcome.

The Node runner, for a divergence row, asserts that the check equals `expect.check`, that evaluation returns rather than throws, that the conformance-value writer refuses the result, that the result is outside the domain of the type `nodeOutOfDomain` names, and that `expect.error` has a `null` code and a highlight quoting the row's source line — so a Node engine that starts keeping to the domain fails the row until it is turned into an ordinary one. It also checks the table below against the rows in both directions. Any other runner knows the `divergence` key, ignores it and compares `expect` as for every row.

| Row | Node answers | Error |
| --- | --- | --- |
| `conversions/int/double_int_max_range` | `int` | `int() type error: integer overflow` |
| `conversions/int/double_range` | `int` | `int() type error: integer overflow` |
| `conversions/uint/double_uint_max_range` | `int` | `int() type error: integer overflow` |
| `integer_math/int64_math/int64_min_negate` | `int` | `integer overflow: 9223372036854775808` |
| `integer_math/int64_math/int64_min_negate_div` | `int` | `integer overflow: 9223372036854775808` |
| `timestamps/timestamp_range/add_duration_under` | `google.protobuf.Timestamp` | `timestamp out of range` |
| `timestamps/timestamp_range/add_duration_over` | `google.protobuf.Timestamp` | `timestamp out of range` |
| `timestamps/timestamp_range/add_duration_nanos_under` | `google.protobuf.Timestamp` | `timestamp out of range` |
| `timestamps/duration_range/from_string_under` | `google.protobuf.Duration` | `duration out of range` |
| `timestamps/duration_range/from_string_over` | `google.protobuf.Duration` | `duration out of range` |
| `timestamps/duration_range/add_under` | `google.protobuf.Duration` | `duration out of range` |
| `timestamps/duration_range/add_over` | `google.protobuf.Duration` | `duration out of range` |
| `timestamps/duration_range/sub_under` | `google.protobuf.Duration` | `duration out of range` |
| `timestamps/duration_range/sub_over` | `google.protobuf.Duration` | `duration out of range` |

## Runners

A runner executes every row of every file it drives and never skips one. It fails when the directory holds a file it does not drive, when a row carries an unknown key or lacks `expect`, when an `id` repeats, and when the number of rows it executed differs from the number in the file.

The Node runner is `templating/nodejs/tests/cel-conformance.test.ts`.
