# CEL conformance vectors

Telo's CEL behaviour, frozen as data. Every file here is a set of rows, each an expression and exactly what a Telo CEL engine answers for it — as the Node engine (`@telorun/templating`) answers it. Every engine runs every row and must reproduce every answer; the rows are the contract, and this README is their format.

The files split along one line:

- **`language.json`** — the bare CEL language: cel-spec's `simple` conformance suite as the language environment answers it.
- **`catalog.json`** — Telo's function catalog: every function in every overload it registers, every refusal a function makes, the literal guards that refuse an argument statically, and every host-backed handler's call, as the dialect environment answers them.
- **`types.json`** — Telo's types: every nominal value brand and the live `Stream` type.
- The remaining dialect files — interpolation holes, module calls and the analyzer-facing verdicts — arrive with their own sections of this README.

## Files

A file is one JSON object. The language file names the cel-spec commit its rows were imported from; a dialect file carries its rows alone:

```json
{ "celSpec": { "commit": "<sha>" }, "rows": [ … ] }
{ "rows": [ … ] }
```

`rows` is the list of rows, in import order for the language file and in authored order for a dialect file. A file carrying any other key is malformed.

## Rows

A row is an object with these keys. A key whose value would be empty is omitted — except `expect`, which every row carries.

- `id` — unique in the file. For a language row, `<file-stem>/<section>/<test>` of the cel-spec test it came from; where a section repeats a test name, the n-th occurrence (n ≥ 2), counted in cel-spec file order before any test is dropped, is `<file-stem>/<section>/<test>#<n>`. For a dialect row, `<file-stem>/<subject>/<case>`: the catalog function or the type the row is about, and a name for the case.
- `source` — the CEL expression.
- `provenance` — language rows only: `{ "file", "section", "test" }`, the cel-spec file (relative to the cel-spec root), section name and test name (the bare name, without an `id`'s occurrence suffix).
- `declarations` — variable name → its type, spelled exactly as cel-js prints a type: `int`, `uint`, `double`, `bool`, `string`, `bytes`, `null`, `dyn`, `list<int>`, `map<string, int>`, `optional<int>`, `google.protobuf.Timestamp`, `google.protobuf.Duration`, and in a dialect row a brand (`Telo.TcpPort`) or `Stream`. A variable holding a record is declared `{ "fields": { <field>: <type> } }`, each field's type in turn a type string or a record.
- `functions` — functions the row declares, each `{ "signature", "result" }` or `{ "signature", "error" }`. `signature` is a cel-js signature (`fn(string, int): string`, `int.fn(): int` for a receiver call, a single capital letter for a type parameter). A call returns `result` (a conformance value), or throws an error whose message is the `error` string.
- `bindings` — variable name → its value at evaluation, a conformance value.
- `expect` — the answer; see below.
- `deviation` — language rows only: where the answer differs from cel-spec's, or the row could not carry a cel-spec input; see below.
- `divergence` — language rows only: the Node engine's answer leaves the CEL value domain, so `expect` is not its answer; see [Divergences](#divergences).
- `tag`, `context`, `explain`, `rootsDeclared`, `couldNameModule` — dialect rows only; see [Dialect rows](#dialect-rows).

A row carrying any other key is malformed.

## `expect`

For a language row, `expect.check` is the verdict of the type check: `{ "type": "<type>" }` when it passes — the type as cel-js's check prints it, where a top-level `list<dyn>` is `list` and a top-level `map<dyn, dyn>` is `map` — or `{ "diagnostics": [ <error> ] }` when parsing or checking fails. A dialect row's `expect.check` is the tag engine's whole static answer; see [Dialect rows](#dialect-rows).

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

## Dialect rows

A dialect row runs against the **dialect environment**: the language environment plus Telo's function catalog and the `Stream` type, with the conformance handler set (below) installed as its host handlers. It drives the seams of the TAG ENGINE the row names — for a `cel` row, the engine's `analyze`, then its `compile` and an evaluation of what it compiled — and every row runs both halves:

- **Static** — a copy of the dialect environment plus every nominal value brand (each brand as a type of its own; its conversion to its base, `int(<brand>)` over an int and `string(<brand>)` over a string; `string(<brand>)` where the base is not a string; and, for a brand whose values come from the host, `<brand>.joinPath(string)` typed back to the brand), then the row's `declarations` and `functions`. The engine analyzes `source` against it, given the row's `context`, `explain`, `rootsDeclared` and `couldNameModule`.
- **Runtime** — a copy of the dialect environment plus the row's `functions`, **without** its `declarations` and without the brands: at runtime a branded value is its base. The engine compiles `source`, and the compiled expression is evaluated with `bindings` as the activation; a result that is a promise is awaited.

### Dialect row keys

- `tag` — the tag whose engine the row drives, without its `!`: `cel`. Every dialect row carries it.
- `context` — the site's context, a JSON Schema: what the engine receives as the schema member-access chains are checked against (an unknown field, a nullable dereference, member access past a live value). Absent means an open context, against which no chain is judged.
- `explain` — the schema of the names the site reads, JSON Schema: consulted only to explain a rejection the checker already made. Absent means the engine has none to consult.
- `rootsDeclared` — `true` when the environment declares every name legal at the site, so a root identifier it does not know is reported as unknown. Absent means the check is off.
- `couldNameModule` — the list of names the host's naming rule says could denote a module; every other name could not. Absent means the host supplies no rule.

### The dialect `check`

A dialect row's `expect.check` is an object with these fields, a field marked optional being absent exactly when the engine gives nothing for it:

- `diagnostics` — every diagnostic the engine reported, in its order, each `{ "code", "message", "fix"? }`: `code` the Telo diagnostic code (`CEL_TYPE_ERROR`, `CEL_UNKNOWN_FUNCTION`, …) or `null` when the engine gave none, `message` the full message, and `fix` — `{ "replacement" }`, the whole corrected source — when the engine offers a repair. Empty when the expression is clean.
- `type` (optional) — the type the checker resolved, as cel-js prints it, when the expression type-checks.
- `calls` — every function call in the source, in source order, each `{ "name", "form", "moduleCall"?, "arity", "arguments"?, "start", "end", "deterministic"?, "hostBacked"? }`: the name called (for a module call, the qualified name as written), `form` `global` for `f(x)` or `receiver` for `x.f()`, `moduleCall` `true` for a call that resolved to a module's function, `arity` the argument count as written (the receiver excluded), for a module call its `arguments` (each `{ "type"?, "chain"? }`: the type the checker gave it and, for a plain member chain, the chain), the call's start and end offsets, and whether it is `deterministic` and `hostBacked` — both taken from the catalog function of that name, and absent when no catalog function has it (a module call carries them only as the host reports them).
- `stringLiteral` (optional) — the string the whole expression is a literal of.
- `readTypes` (optional) — when the checker rejected the expression, the distinct types the checker gives the plain member chains it reads (a chain with an index is not one), in the order first read.
- `regions` — where the tag's CEL sits in the source, each `{ "start", "end" }`: the whole source for `cel`.
- `refs` — the root identifiers the compiled expression reads, sorted.
- `volatile` — whether the compiled expression calls a catalog function whose result differs per call.

`refs` and `volatile` are what compiling answers. When compilation throws, `check` keeps everything the static half answered and carries neither `refs` nor `volatile`, nothing is evaluated, and the compile error is the row's `error`, as `{ "code", "message" }`. Every offset counts UTF-16 code units from the start of `source`. Then, as in every row, exactly one of `value` or `error` — the evaluation's result or the error compiling or evaluating threw (see [Errors](#errors)).

### The conformance handler set

Nine catalog functions reach the host through a handler: `sha256`, `md5`, `sha1`, `sha512`, `hmac`, `base64Encode`, `base64Decode`, `json` and `joinPath`. In every dialect row each handler answers with the text `<handler name>(<arg>, …)` — its name, then each argument it was handed, in order, written as its typed-frame text (`kernel/specs/durable-execution.md` §6) and separated by `, `. So `sha256('abc')` evaluates to `sha256("abc")`, `'/data'.joinPath('reports')` to `joinPath("/data", "reports")`, and `json({'a': 1})` to `json({"a":{"$telo":"int","value":"1"}})`: a row pins exactly what the engine hands the host, and every engine reproduces the text with its own typed-frame writer. A handler handed a value the typed frame refuses fails with the writer's refusal.

A catalog function whose result differs per call (`now`, `nowIso`, `today`, `nowMillis`, `nowSeconds`, `uuidv1`, `uuidv4`, `uuidv6`, `uuidv7`) is pinned only through a deterministic expression over its result — a size, a type, a suffix, a comparison against a fixed instant — never by recording a value it returned.

### Catalog refusals

Every refusal a catalog function makes is worded by Telo — `<function>: <what is wrong>` — and is the same text on every engine; a row records it verbatim, with `code` `null`. No wording of a library or of the host language's runtime reaches one. Two families are fixed by rule rather than by a sentence.

The rule is not yet met by these functions, which have no refusal rows: `range`, `urlDecode`, `urlEncode`, `nowIso`, `today`, `addMonths` (its out-of-range result only — its unknown-zone refusal is pinned), `uuidv3`, `uuidv5`, `uuidVersion`, `hmac` and `joinPath`.

**`parseJson`** refuses a text that is not an RFC 8259 JSON text with `parseJson: invalid JSON at offset <n>`. `<n>` is the offset, in UTF-16 code units, at which the text stops being a prefix of any JSON text — the offset of the first offending code unit. When every prefix of the text is a prefix of some JSON text, so that the text is only incomplete, `<n>` is the text's length and the message ends ` (unexpected end of input)`. So `[1,]` is refused at offset 3, `01` at 1, `1 x` at 2 and `"\x"` at 2; `{` at 1, `tru` at 3 and the empty text at 0, each as end of input. A JSON text is exactly RFC 8259's grammar: any value at the top level, the four whitespace characters, no byte-order mark, no raw control character in a string.

**The regex functions** (`regexReplace`, `regexExtract`, `regexExtractAll`, `regexGroups`) take a pattern in RE2 syntax and refuse one RE2 cannot parse with `<function>: invalid RE2 pattern "<pattern>": <kind>` — `"<pattern>"` the pattern written as a JSON string, and `<kind>` the parse error RE2 reports, in RE2's own words and nothing after them. The kinds are a closed vocabulary:

- `missing closing )`
- `missing closing ]`
- `unexpected )`
- `trailing backslash at end of expression`
- `invalid escape sequence`
- `invalid character class range`
- `invalid named capture`
- `duplicate capture group name`
- `invalid or unsupported Perl syntax`
- `missing argument to repetition operator`
- `invalid nested repetition operator`
- `invalid repeat count`
- `expression nests too deeply`
- `expression too large`

The last two are RE2's parser limits, and the rows pin each on both sides. `expression nests too deeply` is a nesting height above 1000: 999 groups nested around a literal compile, 1001 are refused. `expression too large` is a parsed size above 3,355,443 — `(?:a×3355){1000}` compiles and `(?:a×3356){1000}` is refused, `a×n` being `a` written `n` times — and also a pattern of more than 33,554,432 runes. An engine that fails on its host's limits before RE2 answers — a pattern of 33,554,433 characters exhausts the Node engine's host first — has a host failure, which is outside the vectors and has no row.

The fragment RE2 quotes after a kind, and any prefix its implementation puts before one, are not part of the message. An unknown flag character is refused with `<function>: unknown regex flag '<c>' (supported: i, m, s)`, naming the first such character; `g` is accepted and means nothing. The flags are judged before the pattern.

Where a function checks its literal arguments, its refusal is also made statically, of an argument written as a literal: the diagnostic is `CEL_INVALID_ARGUMENT`, its message the refusal followed by `` (in `<the call as written>`) ``. For the regex functions that is the pattern and the flags, each judged only when it is a literal — a computed pattern or computed flags are judged at evaluation alone. The static and the evaluated answers come from one check, so they are the same text. Only a refusal becomes that diagnostic: an engine failing for any other reason while it judges a literal reports the failure as its own, never as `CEL_INVALID_ARGUMENT`.

### `catalog.json` and `types.json`

`catalog.json` holds, for every function of the catalog and every overload it registers (one registration per signature, an optional parameter registering one per arity), at least one row whose evaluation dispatches that overload and returns a value; for every function that checks its literal arguments, a row where that check refuses one statically (`CEL_INVALID_ARGUMENT`); and every host-backed function's call through the handler set. Its rows also pin the catalog's call classification — a function called in the wrong form, a name no function has, an argument type no overload takes. And it holds a row for every refusal a catalog function makes (see [Catalog refusals](#catalog-refusals)): each distinct refusal of each function, every RE2 parse-error kind, and for each regex function an invalid pattern refused at evaluation — the pattern bound, so the check passes — and one refused statically, the pattern a literal.

`types.json` holds, for every nominal value brand, a row declaring a variable of it and reading it, its conversion to its base, its `string()` rendering, an operator its base accepts refused on the brand, and — for a brand whose values come from the host — `joinPath` typed back to the brand; and for the live `Stream` type, a value passed through and member access refused. No conformance value carries a live `Stream`, so a `Stream` row binds nothing and records what the engine answers without the value.

## Runners

A runner executes every row of every file it drives and never skips one. It fails when the directory holds a file it does not drive, when a row carries an unknown key or lacks `expect`, when an `id` repeats, and when the number of rows it executed differs from the number in the file. It also fails when a catalog overload the dialect environment registers is dispatched by no `catalog.json` row that evaluates to a value, when a catalog function's literal check fires in no `catalog.json` row, when an RE2 parse-error kind of the vocabulary above is the refusal of no `catalog.json` row, and when a nominal brand the value types define is declared by no `types.json` row — each counted from what the engine, its kind vocabulary and the value-type vocabulary register, never from a list kept beside the rows.

The Node runner is `templating/nodejs/tests/cel-conformance.test.ts`.
