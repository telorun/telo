# CEL conformance vectors

Telo's CEL behaviour, frozen as data. Every file here is a set of rows, each an expression and an answer recorded for it, and this README is their format. Whose answer a row holds, and how much of it is compared, depends on the file:

- `holes.json`, `module-calls.json` and `verdicts.json` hold the whole answers of the Node tag engines (`@telorun/templating`, over the CEL engine `@telorun/cel`): every row's `expect` is reproduced whole.
- `language.json` is a recording. Its rows hold the answers of the engine `@telorun/cel` replaced — cel-js under Telo's options — and are read through `deviation`: where a row carries `deviation.celSpec`, cel-spec is the authority wherever cel-spec's language definition, or a library Telo enables, fixes the meaning, and the row is evidence of what the replaced engine answered.
- `catalog.json` and `types.json` hold answers recorded through the `cel` tag engine while it ran over the replaced engine — except the presence rows of `types.json` and the three rows beside them, which are authored (see [`catalog.json` and `types.json`](#catalogjson-and-typesjson)). `@telorun/cel` reproduces them at the level [Runners](#runners) states — whether a row checks, its type, its value or that it fails, and every refusal and literal-guard diagnostic the catalog words, byte for byte — with one row of each file answered otherwise, named there. Outside what is compared there, a recorded row's diagnostic text, its error text and the remaining fields of its `check` are that recording: no runner holds any engine to them, and the Node tag engine does not reproduce every one.

The files split along one line:

- **`language.json`** — the bare CEL language: cel-spec's `simple` conformance suite as the replaced engine answered it in the language environment, with cel-spec's own outcome under `deviation` where the two differ.
- **`catalog.json`** — Telo's function catalog: every function in every overload it registers, every refusal a function makes except those listed as not yet pinned, the literal guards that refuse an argument statically, and every host-backed handler's call, as the dialect environment answered them when recorded.
- **`types.json`** — Telo's types: every nominal value brand, the live `Stream` type, and what a read answers over each value that holds no members.
- **`holes.json`** — the hole grammar of the tags that hold text with `${{ … }}` holes, and what `interpolate` and `sql` make of the holes.
- **`module-calls.json`** — calls on a module's name: what resolves as one, how it is typed, and how it is dispatched.
- **`verdicts.json`** — every diagnostic code and Telo error code the tag engines emit, each in each circumstance it is reported.

## Files

A file is one JSON object. The language file names the cel-spec commit its rows were imported from; a dialect file carries its rows alone:

```json
{ "celSpec": { "commit": "<sha>" }, "rows": [ … ] }
{ "rows": [ … ] }
```

`rows` is the list of rows, in import order for the language file and in authored order for a dialect file. A file carrying any other key is malformed.

## Rows

A row is an object with these keys. A key whose value would be empty is omitted — except `expect`, which every row carries. The rule governs a row's own keys: a list under `expect` is written even when empty.

- `id` — unique in the file. For a language row, `<file-stem>/<section>/<test>` of the cel-spec test it came from; where a section repeats a test name, the n-th occurrence (n ≥ 2), counted in cel-spec file order before any test is dropped, is `<file-stem>/<section>/<test>#<n>`. For a dialect row, `<file-stem>/<subject>/<case>`: the subject is what the row is about — a catalog function in `catalog.json`, a type in `types.json`, an area of the behaviour in `holes.json` and `module-calls.json`, a verdict code in `verdicts.json` — and the case names the row within it.
- `source` — the CEL expression.
- `provenance` — language rows only: `{ "file", "section", "test" }`, the cel-spec file (relative to the cel-spec root), section name and test name (the bare name, without an `id`'s occurrence suffix).
- `declarations` — variable name → its type, in the type-expression grammar of `@telorun/cel`, which is also the spelling the engine prints a type in: `int`, `uint`, `double`, `bool`, `string`, `bytes`, `null`, `dyn`, `list<int>`, `map<string, int>`, `optional<int>`, `google.protobuf.Timestamp`, `google.protobuf.Duration`, and in a dialect row a brand (`Telo.TcpPort`) or `Stream`. A variable holding a record is declared `{ "fields": { <field>: <type> } }`, each field's type in turn a type string or a record.
- `functions` — functions the row declares, each `{ "signature", "result" }` or `{ "signature", "error" }`. `signature` is a signature in the engine's signature grammar (`fn(string, int): string`, `int.fn(): int` for a receiver call, a single capital letter for a type parameter). A call returns `result` (a conformance value), or throws an error whose message is the `error` string.
- `bindings` — variable name → its value at evaluation, a conformance value.
- `expect` — the answer; see below.
- `deviation` — language rows only: where the answer differs from cel-spec's, or the row could not carry a cel-spec input; see below.
- `divergence` — language rows only: the replaced engine's answer left the CEL value domain, so `expect` is not its answer; see [Divergences](#divergences).
- `tag`, `context`, `explain`, `rootsDeclared`, `couldNameModule`, `modules` — dialect rows only; see [Dialect rows](#dialect-rows) and [Module calls](#module-calls).

A row carrying any other key is malformed.

## `expect`

For a language row, `expect.check` is the verdict of the type check: `{ "type": "<type>" }` when it passes — the type in the spelling `declarations` uses, which is how the engine's check prints it; in every file a top-level `list<dyn>` prints as `list` and a top-level `map<dyn, dyn>` as `map`. That holds wherever a row records a type — `check.type` and a module call argument's `type`. A type parameter the check left unresolved is where the recording and the engine part: eleven `language.json` rows and `types/optional/none` in `types.json` record it under the letter of the declaration that introduced it, as the replaced engine printed it — `list<T>` for `[]`, `map<K, V>` for `{}`, `optional<T>` for `optional.none()`, `T` for a declared function returning `T` — while `@telorun/cel` reports it as `dyn`, or on two concatenation rows resolves it (`lists/concatenation/left_unit` to `list<int>`, `type_deduction/type_decay/type_free_param_list_concat` to `list<list<type>>`), so `[]` is `list`, `{}` is `map` and `optional.none()` is `optional<dyn>`; each of those rows is listed in the engine's replays as answered otherwise (see [Runners](#runners)). Inside a message the same parameter is written `dyn`. Otherwise `expect.check` is `{ "diagnostics": [ <error> ] }`, when parsing or checking fails. A dialect row's `expect.check` is the tag engine's whole static answer; see [Dialect rows](#dialect-rows).

Then exactly one of:

- `value` — the evaluation result, a conformance value;
- `error` — the error evaluation threw.

A row carrying `modules` also carries `expect.dispatched`; see [Module calls](#module-calls).

For a row of `holes.json`, `module-calls.json` or `verdicts.json` the runner computes the whole `expect` and compares it to the row's by deep equality; nothing is compared partially. Of a row of `language.json`, `catalog.json` or `types.json` only part of `expect` is compared; see [Runners](#runners).

### Errors

An error is `{ "code", "message" }`:

- `code` is the Telo error code the error carries (`ERR_…`), else `null`. The engine's own error codes are never recorded.
- `message` is the full message as thrown. When the error has a location in the expression, the message is the summary, a blank line, and a highlight: `> `, the line number right-aligned in four columns, ` | `, the source line, a newline, then spaces and a `^` under the column. Columns count UTF-16 code units.

Where a message quotes a text **written as a JSON string**, it is the text between double quotes, with `"` and `\` each behind a backslash, U+0008, U+0009, U+000A, U+000C and U+000D as `\b`, `\t`, `\n`, `\f` and `\r`, every other character below U+0020 as `\u` and four lowercase hexadecimal digits, and every other character as itself — U+007F, U+2028 and a character outside the basic plane included. No file holds a string with an unpaired surrogate: such a string is outside the CEL value domain, and a file holding one, raw or as a `\u` escape, is malformed. Not yet pinned: what an engine answers where the Node engine produces such a string, and with it how a message writes one.

## Conformance values

One encoding carries every value — bindings, results, function results and cel-spec's own values in a deviation. It is the typed frame (`kernel/specs/durable-execution.md` §6) held as a JSON value rather than as text: a string, bool, null and finite double are themselves; an int, uint, bytes, timestamp, duration, a non-finite or negative-zero double and a map that is not a plain string-keyed object are tagged under `$telo`, with the frame's canonical payloads and orders — with one exception: a timestamp in `catalog.json` is written with exactly three fractional digits (`2026-03-01T00:00:00.000Z`), where `holes.json` writes the frame's trimmed form (`2026-03-15T10:30:00Z`); no other file holds a timestamp the two spellings write differently. On top of the frame, two forms under the reserved key `$cel`:

```json
{ "$cel": "type", "value": "google.protobuf.Duration" }
{ "$cel": "optional", "value": <conformance value> }
{ "$cel": "optional" }
```

A type value carries its name in the spelling `declarations` uses (`int`, `list`, `null`, `type`, `google.protobuf.Timestamp`), and decodes to the type value the language environment names under it. An optional holds a value, or is none. Both forms nest anywhere a frame value may.

`$cel` is reserved exactly as `$telo` is: a data map with `$cel` (or `$telo`) as a key is written as a tagged `map`.

There is no opaque form. A value that cannot be written — one outside the CEL value domain, a string holding an unpaired surrogate among them, or one that does not read back to the same encoding — is an error in generation, never a stand-in; the one out-of-domain result a row records is a divergence (see [Divergences](#divergences)), and it records it as an error, not as a value. The templating test's reader refuses a node that is not the canonical encoding of the value it reads; the reader of the engine's replays accepts a timestamp in either spelling (see [Runners](#runners)).

## Language rows

A language row runs against the **language environment**: the standard library of `@telorun/cel` under Telo's options (unlisted variables are `dyn`, optional types enabled, heterogeneous aggregate literals allowed) and nothing else — no Telo function catalog, no `Stream` type. The Telo dialect environment is built on it.

A language row drives the language's own seams, and every row runs both halves:

- **Check** — a copy of the language environment plus the row's `declarations` and `functions`, then the engine's type check of `source`.
- **Evaluate** — a copy of the language environment plus the row's `functions` but **without** its `declarations`; `source` is parsed and evaluated with `bindings` as the activation. Evaluation type-checks first, so an ill-typed expression evaluates to the checker's error; that is what the row records.

Not yet pinned: what `substring` and the receiver `split` answer where the result would hold an unpaired surrogate.

The row `timestamps/timestamp_selectors_tz/getHours` records the replaced engine's refusal in its JS host's wording (`Invalid time zone specified: 02:00`). `@telorun/cel` answers the row's `deviation.celSpec` instead: a zone written `HH:MM` is a fixed offset ahead of UTC, so the row evaluates to `1`. A zone it does not know it refuses in its own words — `"<zone>" is not a time zone`, the zone written as a JSON string — which no row holds.

### From cel-spec

Every kept cel-spec `simple` test is one row, and its `expect` is the replaced engine's answer — except in a divergence row. What cel-spec says goes into `deviation`, only where it differs.

| cel-spec | Row |
| --- | --- |
| `expr` | `source` |
| file, section and test name | `id`, `provenance` |
| `type_env` identifier | `declarations`, the type in the spelling that key defines (`optional_type` is `optional<…>`, a well-known Timestamp or Duration is `google.protobuf.Timestamp` / `google.protobuf.Duration`) |
| `type_env` function overload | a `functions` entry whose `error` is `cel-spec declares this function without an implementation`; an overload the replaced engine's signature grammar could not state is uncarried |
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

- `celSpec` — cel-spec's outcome, where it differs from `expect`: `{ "value": <conformance value> }`, `{ "error": "<cel-spec's message text>" }`, `{ "unknown": [ <expression ids> ] }` or `{ "type": "<cel-spec's deduced type in the spelling declarations uses>" }`. A `typed_result` whose value and type both differ carries both `value` and `type`.
- `uncarried` — the cel-spec inputs the row could not carry: `container`, `disable_check`, `disable_macros`, `check_only`, or `function <overload id>` for a function declaration the replaced engine's signature grammar could not state.

### What is dropped

A cel-spec test is dropped exactly when it constructs, declares, binds or names a protobuf message or enum type outside Telo's CEL value domain: the test protos (`TestAllTypes`, `NestedMessage`, `NestedTestAllTypes`, `NestedEnum`, `GlobalEnum`, `TestRequired`, `Proto2ExtensionScopedMessage`), enum values, the `google.protobuf` wrappers (`BoolValue`, `BytesValue`, `DoubleValue`, `FloatValue`, `Int32Value`, `Int64Value`, `StringValue`, `UInt32Value`, `UInt64Value`), `Any`, `Struct`, `Value`, `ListValue`, `NullValue`, `Empty` and `FieldMask`. `google.protobuf.Timestamp` and `google.protobuf.Duration` are CEL's timestamp and duration, and are kept. Every extension-library file (`string_ext`, `math_ext`, `lists_ext`, `encoders_ext`, `bindings_ext`, `block_ext`, `network_ext`, `optionals`, …) is kept: the engine's answer — usually a rejection — is what pins which extensions it lacks. Nothing is dropped for what the engine accepts.

## Divergences

The engine `language.json` was recorded from did not keep every result inside the CEL value domain: some operations that cel-spec expects to fail returned an int beyond int64, a uint beyond uint64, a timestamp outside 0001-01-01T00:00:00Z … 9999-12-31T23:59:59.999999999Z, or a duration beyond ±315,576,000,000.999999999s. Such a value cannot be written as a conformance value, and an engine that keeps to the domain answers with an error. The `divergence` key marks the rows where that happened; fourteen rows carry it.

A language row is a **divergence row** exactly when cel-spec expects an evaluation error (`eval_error` / `any_eval_errors`), the replaced engine evaluated without error, and its result itself — not a value nested inside it — was outside the domain. Any other out-of-domain value is an error in generation. In a divergence row:

- `expect.check` is the replaced engine's check verdict, as in any row.
- `expect.error` is the domain-keeping answer, and the only `expect` in `language.json` that is not the replaced engine's: `{ "code": null, "message": … }`, the message a fixed summary for the condition followed by the usual highlight under the expression node that produced the out-of-domain value (for a binary operator, the start of its left operand, as the engine highlights its own operator errors). The summaries are `integer overflow: <the exact decimal result>` for an int operator, `int() type error: integer overflow` for `int()` of a double, `Unsigned integer overflow` for a uint operator, `uint() type error: unsigned integer overflow` for `uint()` of a double, `timestamp out of range` and `duration out of range` for a timestamp or duration constructed or computed out of range.
- `divergence` is `{ "nodeOutOfDomain": "int" | "uint" | "google.protobuf.Timestamp" | "google.protobuf.Duration" }` — the CEL type of the replaced engine's out-of-domain result.
- `deviation` may carry only `celSpec.type` and `uncarried`: `expect` already is cel-spec's outcome.

`@telorun/cel` keeps to the value domain: it raises integer overflow, `timestamp out of range` and `duration out of range` itself, so it answers an error on every one of the fourteen rows. Its duration is the int64 range of the total nanoseconds, -9223372036.854775808s … 9223372036.854775807s — narrower than the ±315,576,000,000.999999999s a conformance value carries — and a duration outside it is `duration out of range`. Its replays (see [Runners](#runners)) drive a divergence row as any other: the check is held to `expect.check`, and evaluation is held to failing. Of `expect.error`, the code is never compared, and the message is compared byte for byte, highlight included, only on the six `timestamps/duration_range` rows (`RECORDED_MESSAGE_ROWS` in `cel/nodejs/conformance/value-replay.ts`). On the other eight the engine's own message stands uncompared, and differs from the row's on the three `int()` rows, where it is `integer overflow: <the double converted>`. No runner asserts anything of the `divergence` key, and none checks the table below against the rows.

| Row | `nodeOutOfDomain` | Error |
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

A dialect row runs against the **dialect environment**: the language environment plus Telo's function catalog and the `Stream` type, with the conformance handler set (below) installed as its host handlers. It drives the seams of the TAG ENGINE the row names — `cel`, `interpolate` or `sql`: the engine's `analyze`, then its `compile` and an evaluation of what it compiled — and every row runs both halves. The rows of `holes.json`, `module-calls.json` and `verdicts.json` are driven exactly so. Every row of `catalog.json` and `types.json` names `cel`, and those two files are driven through the check and the evaluation of `@telorun/cel` itself, over the same two environments (see [Runners](#runners)).

- **Static** — a copy of the dialect environment plus every nominal value brand (each brand as a type of its own; its conversion to its base, `int(<brand>)` over an int and `string(<brand>)` over a string; `string(<brand>)` where the base is not a string; and, for a brand whose values come from the host, `<brand>.joinPath(string)` typed back to the brand), then the row's `declarations` and `functions`. The engine analyzes `source` against it, given the row's `context`, `explain`, `rootsDeclared`, `couldNameModule` and `modules`.
- **Runtime** — a copy of the dialect environment plus the row's `functions`, **without** its `declarations` and without the brands: at runtime a branded value is its base. The engine compiles `source` against the row's module names, and the compiled value is evaluated with `bindings` as the activation and the row's module functions bound as the dispatch table; a result that is a promise is awaited.

### Dialect row keys

- `tag` — the tag whose engine the row drives, without its `!`: `cel` (the whole source is one expression), `interpolate` or `sql` (text with holes; see [Holes](#holes)). Every dialect row carries it.
- `context` — the site's context, a JSON Schema: what the engine receives as the schema member-access chains are checked against (an unknown field, a nullable dereference, member access past a live value). Absent means an open context, against which no chain is judged.
- `explain` — the schema of the names the site reads, JSON Schema: consulted only to explain a rejection the checker already made. Absent means the engine has none to consult. What is read of this schema and of `context` is [below](#what-the-engine-reads-of-a-schema).
- `rootsDeclared` — `true` when the environment declares every name legal at the site, so a root identifier it does not know is reported as unknown. Absent means the check is off.
- `couldNameModule` — the list of names the host's naming rule says could denote a module; every other name could not. Absent means the host supplies no rule.
- `modules` — the declaring module's names and the module functions the host answers for; see [Module calls](#module-calls). Absent means no name set: every call is an ordinary one.

### What the engine reads of a schema

`context`, `explain` and a module function's `resultSchema` are JSON Schemas, of which the engine reads four keywords — `properties`, `additionalProperties`, `items`, `type` — and one annotation, `x-telo-type`. It reads nothing else: a schema that speaks only through `$ref`, `anyOf` or `nullable` is, here, a schema without them.

A member chain is checked one segment at a time, from the root of the schema:

- A named member is looked up in `properties`. A schema with no `properties` is open, and nothing at or below it is judged. A name `properties` holds leads to that property's schema. A name it does not hold is undeclared — `'<the chain up to that name>' is not defined (available: <the declared names in the schema's own order, joined by ", ">)` — unless `additionalProperties` is exactly `true`, which leaves the name and everything below it unjudged. `additionalProperties` holding a schema, or `false`, changes nothing for a named member.
- An index, whatever its expression, reads an element: the schema under `items` when that is one schema; otherwise — `items` absent, or a list of schemas, which is not read — in a schema with no `properties`, the schema under `additionalProperties` when that is a schema. Where neither gives an element the rest of the chain is unjudged: a list under `items` with no `additionalProperties` schema beside it, and any index into a schema that has `properties`, whatever its `additionalProperties`. In a message an index is the segment `[*]`, joined with a dot like any other.
- A property whose schema carries `x-telo-type` naming the live value type `Telo.Stream` — as that string, or as an object whose `name` is that string — is a live value. Reading it is clean; reading anything past it is `'<the chain up to it>' yields a stream — pipe it through an Encoder or iterate in a JS.Script step (no member access on stream-typed values)`. An `x-telo-type` naming any other type is not read.

Each finding is a `CEL_UNKNOWN_FIELD`. Under `context` every chain of the expression is judged, each reported in the order read. `explain` is consulted only when the checker rejected the expression and the call classification reported nothing: a chain `explain` leaves undeclared is reported, in the same words, when the checker on its own rejects that chain too, and the checker's own rejection is then not reported; a finding `explain` already gave is not given again by `context`.

A schema admits null when its `type` is `"null"` or a list holding `"null"`; `type` is read for nothing else. Under `context`, a dereference — a member read or an index, never a method call — of a plain chain of named members whose schema admits null is `CEL_NULLABLE_ACCESS`: `'<chain>' may be null — guard it (e.g. '<chain> != null && …' or '<chain> == null ? … : <chain><access>') before accessing '<access>'`, `<access>` being `.<member>` or `[index]`. The chain's schema is found through `properties` alone, so nothing past an index is judged. A dereference is clean where the chain is proven not null: on the right of `&&` after `<chain> != null`, on the right of `||` after `<chain> == null`, in the first branch of a ternary whose condition is `<chain> != null` and the second branch of one whose condition is `<chain> == null`. `null` may stand on either side of the comparison, `!` swaps what a test proves, a test joined by `&&` to others still proves it where the whole holds, and one joined by `||` where the whole fails; a test of another chain proves nothing of this one.

### Time zones

The vectors pin how an engine applies time-zone rules, never what the rules are: those are the host's data, which no Telo release fixes. So a row whose answer depends on a zone's rules names a zone present, and an instant on or before 2021-12-31 whose local time is the same, in every tzdata release from `2022a` on. A row over a function that reads the clock names only a zone whose offset is fixed by definition (`Etc/GMT±n`), or asserts only the shape of the result. A row refusing an unknown zone names a zone no release has held. An engine carrying older tzdata is outside the vectors.

### The dialect `check`

A dialect row's `expect.check` is an object with these fields, a field marked optional being absent exactly when the engine gives nothing for it:

- `diagnostics` — every diagnostic the engine reported, in its order, each `{ "code", "message", "fix"? }`: `code` the Telo diagnostic code (`CEL_TYPE_ERROR`, `CEL_UNKNOWN_FUNCTION`, …), never `null`, `message` the full message, and `fix` — `{ "replacement" }`, the whole corrected source — when the engine offers a repair. Empty when the expression is clean.
- `type` (optional) — the type the checker resolved, printed as [`expect`](#expect) says a type is, when the expression type-checks.
- `calls` — every function call in the source, in the order of their start offsets, a call before any call inside it that starts where it does, each `{ "name", "form", "moduleCall"?, "arity", "arguments"?, "start", "end", "deterministic"?, "hostBacked"? }`: the name called (for a module call, the qualified name as written), `form` `global` for `f(x)` or `receiver` for `x.f()`, `moduleCall` `true` for a call that resolved to a module's function, `arity` the argument count as written (the receiver excluded), for a module call its `arguments` (each `{ "type"?, "chain"? }`: the type the checker gave it and, for a plain member chain, the chain), the call's start and end offsets, and whether it is `deterministic` and `hostBacked` — both taken from the catalog function of that name, and absent when no catalog function has it (a module call carries them only as the host reports them).
- `stringLiteral` (optional) — the string the whole expression is a literal of.
- `readTypes` (optional) — when the checker rejected the expression, the distinct types the checker gives the plain member chains it reads (a chain with an index is not one), in the order first read.
- `regions` — where the tag's CEL sits in the source, each `{ "start", "end" }`: the whole source for `cel`, each hole's expression in order for a tag with holes, and none when the holes cannot be read.
- `refs` — the root identifiers the compiled expression reads, sorted.
- `volatile` — whether the compiled expression calls a catalog function whose result differs per call.

`refs` and `volatile` are what compiling answers. When compilation throws, `check` keeps everything the static half answered and carries neither `refs` nor `volatile`, nothing is evaluated, and the compile error is the row's `error`, as `{ "code", "message" }`. Every offset counts UTF-16 code units from the start of `source`. Then, as in every row, exactly one of `value` or `error` — the evaluation's result or the error compiling or evaluating threw (see [Errors](#errors)).

### Holes

The `interpolate` and `sql` tags hold text with holes, and one grammar reads both.

- A hole opens at `${{`. Outside a hole nothing else is special: `$`, `{`, `${`, `{{` and `}}` are text.
- A hole closes at the first `}}` that is outside a CEL string literal and outside any `{` the hole's own text opened. A `}` closing such a brace closes no hole, and a `}` outside every brace that is not followed by a second `}` leaves the hole unclosed.
- A string literal inside a hole is CEL's: `'…'` and `"…"`, their triple-quoted forms, and the `r` and `b` prefixes in either case. In a string without the `r` prefix a backslash takes the next character with it, so an escaped quote does not end the string — and neither does a line feed directly after a backslash: the backslash rule comes first, the string runs on, and what the expression makes of that escape is its own matter. A raw string is read whole too: a `}}` inside it closes no hole, and a backslash before any character but the string's own quote is kept as written. A string that is not triple-quoted ends unterminated at a line feed (U+000A), and so does its hole; a triple-quoted one may span lines. No other character ends a string: a carriage return or U+2028 inside one is the expression's own matter. Not yet pinned: where a hole ends when a raw string holds a backslash directly before its own quote, and a string under a two-letter prefix.
- A literal `${{` is written as a hole that yields it: `${{ '${{' }}`.
- A hole that never closes makes the whole scalar unreadable, at the offset of its `${{`. Statically that is one `CEL_SYNTAX_ERROR` — `the hole opened at offset <n> never closes — a hole ends at the first '}}' outside a string literal and outside any braces it opened` — with no calls and no regions, whatever holes precede it; compiling throws the same sentence behind `!<tag>: `, with no code.
- A hole's expression is its body without the whitespace at either end, whitespace being exactly U+0009 to U+000D, U+0020, U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF. Any other character — U+0085, for one — stays in the expression. An empty body is an empty expression, which CEL refuses.

A scalar has one of four shapes: `none` (no hole), `lone-hole` (exactly one hole with only whitespace around it), `interpolated` (any other readable text with holes) and `malformed` (a hole that never closes). Both tags read the first three alike: a lone hole under `interpolate` is still text, and the whitespace around it is kept. Which shape a scalar has is not an answer of either tag, so no row carries it: the naming of the shapes is not pinned and binds no engine.

Statically each hole's expression is analyzed exactly as a `cel` row's source is, in order, with every site input of the row; `check` is their sum. `diagnostics` holds each hole's diagnostics in hole order, worded as they are under `cel`: a highlight inside a message quotes the hole's expression alone, and a `fix` is re-anchored — its `replacement` is the whole scalar with that one hole's expression replaced. `calls` holds each hole's calls with offsets counted in the scalar. There is no `type`, `stringLiteral` or `readTypes`. Compiling compiles each hole; `refs` is the sorted union over the holes and `volatile` holds when any hole is volatile. A hole CEL cannot parse fails the compile with CEL's own error for that expression.

**`interpolate`** yields a string: the text between the holes joined with `string(<hole>)` for each hole — CEL's own conversion in the dialect environment, never the host language's. A string is itself, an int and a uint their decimal digits, a bool `true` or `false`, a double as `string()` writes it, bytes their UTF-8 text, a timestamp RFC 3339 in UTC, its fraction written to the precision it carries and omitted when the instant is whole (`2026-03-15T10:30:00Z`), a duration its seconds (`5400s`). Holes are evaluated and converted left to right, and the first failure is the row's error.

A hole that analyzed clean gets one more verdict. When its expression is a plain member chain whose `context` schema admits null, it is `CEL_NULLABLE_ACCESS` — `'<chain>' may be null, and a null has no text — guard it in the hole (e.g. '${{ <chain> != null ? <chain> : "" }}').`. Otherwise, when its checked type is one no one-argument global `string()` overload of the static environment accepts — `dyn` always passes, and a nominal brand converts — it is `INTERPOLATION_HOLE_NOT_CONVERTIBLE`: `the hole '${{ <expr> }}' is <type>, which CEL's string() cannot convert to text. Convert it inside the hole (e.g. join a list, or read the field you meant), or write the whole value as !cel.`. A hole with a diagnostic of its own gets neither.

At evaluation a hole whose value `string()` refuses fails with the code `ERR_INTERPOLATION_HOLE_NOT_CONVERTIBLE`: `the hole '${{ <expr> }}' at offset <n> of !interpolate <source> evaluated to <what>, which CEL's string() cannot convert to text. Declare outputType on the resource producing it so the check sees its type, or guard it inside the hole.` — `<n>` the offset of the hole's `${{`, `<source>` the whole scalar written as a JSON string (see [Errors](#errors)), and `<what>` `null`, `a list` or `a map`. Not yet pinned: how the message names a value that is not null, a list or a map — an optional, a type — and, with it, the static refusal of the holes `${{ optional.of(1) }}` and `${{ int }}`.

**`sql`** keeps the text and the holes apart, so that a consumer binds each value instead of splicing it. It yields a map of three entries: `__teloParameterized`, always `true`; `fragments`, the text before, between and after the holes — one more than there are holes, an empty string where a hole touches an edge or another hole; and `values`, each hole's value in order, unconverted. Any value is accepted, null included, so `sql` adds no verdict of its own to a hole. The text is never parsed as SQL: a hole inside a quoted SQL string or a comment is a hole.

### Module calls

An expression is compiled and analyzed against a **name set** as well as an environment: the names of the module declaring it. A row gives both under `modules`:

```json
{ "names": [ "<name>", … ],
  "functions": { "<qualified name>": { "returns", "deterministic", "hostBacked", "resultSchema"?, "result" | "error" } } }
```

- `names` — the name set, handed to both halves.
- `functions` — the module functions the host resolved, by qualified name (`<name>.<function>`); omitted when there are none. An entry is a function the host resolved, and the host answers for it whole — its type and both flags together; a qualified name the host did not resolve has no entry. For each: `returns`, the type the host answers as the call's type, in the spelling `declarations` uses; `deterministic` and `hostBacked`, the flags the host reports for it; `resultSchema`, the JSON Schema of its result, when the host has one; and what the function does when dispatched — `result`, the conformance value it returns, or `error`, the `{ "code", "message" }` it throws. That is an error in full, unlike the `error` of an entry of the row's own `functions`, which is a message alone and carries no code.

**What is a module call.** A call is a module call exactly when it is written on a receiver that is a bare identifier in the name set: `Billing.total(x)`. Its qualified name is the receiver and the function name as written. Nothing else is one: a call whose receiver is a field access (`a.Billing.total(1)`), a call on a name outside the set, a method called on a module call's result, and a name of the set read as a value or through a member (`Billing`, `Billing.rate`) are all ordinary CEL. A call with no receiver is always the catalog's, so `format(…)` and `Billing.format(…)` never meet. A module call whose function carries the name of a comprehension macro (`Billing.map(x, x)`) is a module call, its arguments ordinary expressions.

The receiver of a module call names a module, not a value: it is not among `refs`, is not judged as a root identifier, and is read against no schema. The arguments are ordinary expressions, analyzed and evaluated where they are written. A name of the set bound inside the expression — a comprehension variable, a `cel.bind` name — could never be read through a call, and is reported once per name as `BINDING_NAME_RESERVED`.

**How it is checked.** The call has the type `returns` names, so an operator or a function over it is checked against that type; a qualified name with no `functions` entry is `dyn`, and a `returns` naming no type of the environment is a `CEL_TYPE_ERROR`. A member read off the call is checked against `resultSchema` exactly as a chain is against `context`, the call standing as `<qualified name>(…)` and an index as `[*]`: an undeclared member is `CEL_UNKNOWN_FIELD`. With no `resultSchema` nothing is judged.

In `calls`, a module call is `{ "name": <qualified name>, "form": "receiver", "moduleCall": true, "arity", "arguments", "start", "end" }`, with `deterministic` and `hostBacked` as its `functions` entry gives them and neither when it has no entry. `arguments` has one entry per argument: `type`, the type the checker gave it, printed as [`expect`](#expect) says a type is, absent when the expression did not check far enough to type it; and `chain`, when the argument is a plain member chain with no index, rooted at a name the expression does not itself bind. The catalog's classification passes a module call over: it is never an unknown function, a wrong call form or a literal-guard refusal.

**How it is dispatched.** The runtime half binds the row's `functions` as the dispatch table — qualified name to function — under a key no expression can name. Evaluating a module call looks its qualified name up first: with none bound it fails, before any argument is evaluated, with `unbound function '<qualified name>' — nothing is bound under that name in this scope. '<name>' must be an imports: alias (or Self, or this module's own name) whose module declares a callable named '<function>' and exports it.` and no code. Otherwise the arguments are evaluated left to right and the function is handed their values in order; the call's value is its `result`, or the evaluation fails with its `error`, code and message unchanged.

`expect.dispatched` is every dispatch evaluation made, in the order made, each `{ "name", "arguments" }`: the qualified name and the values handed over, as conformance values. Every row carrying `modules` carries it; no other row does.

**The unknown-identifier hint.** Under `rootsDeclared`, an undeclared root identifier is `CEL_UNKNOWN_IDENTIFIER` — `unknown identifier '<name>' — nothing by that name is in scope here.`, once per name. When that name is written as the receiver of a call and `couldNameModule` lists it, the message continues ` To call a function another module declares, '<name>' must be one of this module's names — an 'imports:' alias, 'Self', or the module's own metadata.name.`; without `couldNameModule`, or for a name it does not list, it does not.

### The conformance handler set

Nine catalog functions reach the host through a handler: `sha256`, `md5`, `sha1`, `sha512`, `hmac`, `base64Encode`, `base64Decode`, `json` and `joinPath`. In every dialect row each handler answers with the text `<handler name>(<arg>, …)` — its name, then each argument it was handed, in order, written as its typed-frame text (`kernel/specs/durable-execution.md` §6) and separated by `, `. So `sha256('abc')` evaluates to `sha256("abc")`, `'/data'.joinPath('reports')` to `joinPath("/data", "reports")`, and `json({'a': 1})` to `json({"a":{"$telo":"int","value":"1"}})`: a row pins exactly what the engine hands the host, and every engine reproduces the text with its own typed-frame writer. The set is defined only over values the typed frame writes. A value it cannot write — an optional, a type value, a live `Stream`, a number or an instant outside the value domain, a string holding an unpaired surrogate — has no frame text, so no row hands one to a handler: such a row is malformed. What a writer answers when it refuses is the typed frame's own contract (`kernel/specs/durable-execution.md` §6.1 and §6.5: `ERR_TYPED_FRAME_UNENCODABLE` and its `path`), not these vectors'; it is not pinned here and binds no engine.

A catalog function whose result differs per call (`now`, `nowIso`, `today`, `nowMillis`, `nowSeconds`, `uuidv1`, `uuidv4`, `uuidv6`, `uuidv7`) is pinned only through a deterministic expression over its result — a size, a type, a suffix, a comparison against a fixed instant — never by recording a value it returned.

### Catalog refusals

Every refusal a catalog function makes is worded by Telo — `<function>: <what is wrong>` — and is the same text on every engine; a row records it verbatim, with `code` `null`. No wording of a library or of the host language's runtime reaches one, except in the refusals listed first below. Two families are fixed by rule rather than by a sentence.

Not yet pinned — no row answers on any of these:

1. the refusals of `range` (a count too large), `urlDecode`, `urlEncode`, `uuidv3`, `uuidv5`, `uuidVersion`, `hmac` (an unknown algorithm) and `joinPath` (an absolute argument) — each is still a dependency's or the host's wording;
2. three refusals the catalog words, which no row holds yet: `nowIso` and `today` of an unknown zone — `<function>: unknown IANA time zone "<zone>"`, the zone written as a JSON string, as the pinned refusal of `addMonths` is — with whether `Z` is a zone, and with neither function refusing a literal zone statically; `addMonths` of a result out of range — `addMonths: the result is outside the range of a timestamp`; and a non-finite number handed to `round`, `format`, `fixed` or `formatDuration` — `<function>: expected a finite number, got double`;
3. whether `parseJson` and `bytesFromBase64` refuse a literal argument statically — their refusals at evaluation are pinned, through a bound argument;
4. what a catalog function answers where its result would hold an unpaired surrogate — `parseJson` for a text whose string holds one, `slice` for a string range that starts or ends inside a surrogate pair, `split` for an empty separator and `replace` for an empty search over a string holding a pair.

**`parseJson`** refuses a text that is not an RFC 8259 JSON text with `parseJson: invalid JSON at offset <n>`. `<n>` is the offset, in UTF-16 code units, at which the text stops being a prefix of any JSON text — the offset of the first offending code unit. When every prefix of the text is a prefix of some JSON text, so that the text is only incomplete, `<n>` is the text's length and the message ends ` (unexpected end of input)`. So `[1,]` is refused at offset 3, `01` at 1, `1 x` at 2 and `"\x"` at 2; `{` at 1, `tru` at 3 and the empty text at 0, each as end of input. A JSON text is exactly RFC 8259's grammar: any value at the top level, the four whitespace characters, no byte-order mark, no raw control character in a string.

**The regex functions** (`regexReplace`, `regexExtract`, `regexExtractAll`, `regexGroups`) take a pattern in RE2 syntax and refuse one RE2 cannot parse with `<function>: invalid RE2 pattern "<pattern>": <kind>` — `"<pattern>"` the pattern written as a JSON string (see [Errors](#errors)), and `<kind>` the parse error RE2 reports, in RE2's own words and nothing after them. The kinds are a closed vocabulary:

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

The last two are RE2's parser limits, and the rows pin each on both sides. `expression nests too deeply` is a nesting height above 1000, the height counting the innermost element as one and each group around it as one more: a literal inside 999 nested groups, of height 1000, compiles, and inside 1000 groups, of height 1001, it is refused. `expression too large` is a parsed size above 3,355,443 — `(?:a×3355){1000}` compiles and `(?:a×3356){1000}` is refused, `a×n` being `a` written `n` times. RE2 also refuses a pattern of more than 33,554,432 runes under that kind; no row reaches that limit, the Node engine's host being exhausted first, so it is not pinned and binds no engine.

The fragment RE2 quotes after a kind, and any prefix its implementation puts before one, are not part of the message. An unknown flag character is refused with `<function>: unknown regex flag '<c>' (supported: i, m, s)`, naming the first such character; `g` is accepted and means nothing. The flags are judged before the pattern.

Where a function checks its literal arguments, its refusal is also made statically, of an argument written as a literal: the diagnostic is `CEL_INVALID_ARGUMENT`, its message the refusal followed by `` (in `<the call as written>`) ``. For the regex functions that is the pattern and the flags, each judged only when it is a literal — a computed pattern or computed flags are judged at evaluation alone. The static and the evaluated answers come from one check, so they are the same text. Only a refusal becomes that diagnostic. What an engine does when it fails for any other reason while judging a literal cannot be written as a row: it is not pinned and binds no engine.

### `catalog.json` and `types.json`

`catalog.json` holds, for every function of the catalog and every overload it registers (one registration per signature, an optional parameter registering one per arity), at least one row whose evaluation dispatches that overload and returns a value; for every function that checks its literal arguments, a row where that check refuses one statically (`CEL_INVALID_ARGUMENT`); and every host-backed function's call through the handler set. Its rows also record the catalog's call classification — a function called in the wrong form, a name no function has, an argument type no overload takes — of which only that the row is refused, and fails at evaluation, is compared. And it holds a row for every refusal a catalog function makes (see [Catalog refusals](#catalog-refusals)), except those listed there as not yet pinned: each distinct refusal of each function, every RE2 parse-error kind, and for each regex function an invalid pattern refused at evaluation — the pattern bound, so the check passes — and one refused statically, the pattern a literal.

`types.json` holds, for every nominal value brand, a row declaring a variable of it and reading it, its conversion to its base, its `string()` rendering, an operator its base accepts refused on the brand, and — for a brand whose values come from the host — `joinPath` typed back to the brand; for the live `Stream` type, a value passed through and member access refused; and, under the subject `optional`, the none optional, whose row records its type with the unresolved parameter (`optional<T>`) where `@telorun/cel` reports `optional<dyn>`. No conformance value carries a live `Stream`, so a `Stream` row binds nothing and records what the engine answers without the value.

It also holds, under the subject of each value that holds **no members at all** — `string`, `int`, `uint`, `double`, `bool`, `bytes`, `timestamp`, `duration`, `null`, a nominal brand, and `dyn` for the one receiver whose shape the check does not know — a row per **presence-shaped** read over it: `a.?b`, `a[?k]` and `has(a.b)`. Each answers **absence** (`optional.none()`, or `false` for `has()`), and each whose operand type is known refuses at check with `CEL_TYPE_ERROR`, so one row pins both halves. Beside them are the three readings that are not absence: the ordinary read of such a member (`types/dyn/ordinary_read`), the ordinary step of a chain that has entered optional land (`types/optional/ordinary_read_over_scalar`), and an unusable key in the presence form (`types/list/presence_unusable_key`) — each a CEL error. **These rows are authored, not recorded**: they are what this engine answers, and the authority for them is the optional library Telo enables, which enters whole from cel-go — whose attribute qualification answers "not found" for a receiver that is neither a mapper, a lister nor an indexer whenever the read is a presence test, erroring only under an explicitly named opt-in Telo does not carry.

### `holes.json`, `module-calls.json` and `verdicts.json`

`holes.json` holds the hole grammar through both hole tags: each of the four scalar shapes; a hole holding a string with `}}` in each quoting and under each one-letter prefix in either case, a map literal, an escaped quote, an escaped line feed, and a string broken by a line feed, a carriage return and U+2028; a literal `${{`; each way a hole fails to close; adjacent, repeated, padded, unpadded and empty holes, every whitespace character trimmed from a hole and one that is not; offsets past a character outside the basic plane. For `interpolate` it holds the conversion of every type `string()` accepts, a brand, the static refusal of a list, a map and a null, the refusal of a null, a list and a map at evaluation, and the nullable-chain hole with and without its guard. It holds a diagnostic, each kind of `fix` and the call offsets re-anchored onto the scalar; and for `sql`, what it yields for typed values, for a null, a list and a map, and for a hole that fails. Its `cel` rows (`holes/language/*`) pin what the language itself reads of the two cases the hole grammar leaves unpinned: a raw string with a backslash before its own quote, at its end and doubled at its end, and a string under each two-letter prefix.

`module-calls.json` holds a call through each kind of name a set holds — an import alias, `Self`, the module's own name, `Telo` — and every reading that is not a module call; the arguments as the check saw them, a function the row itself declares among them, and a type and an optional handed over; the call typed by `returns` and its member reads checked against `resultSchema`; the flags with and without a `functions` entry; dispatch inside a comprehension, nested, repeated, skipped by a short circuit, failing as scripted with and without a code, and unbound; the unknown-identifier hint with and without the host's rule; and a module call inside a hole of each hole tag.

`verdicts.json` holds a row for every diagnostic code and every Telo error code the three tag engines can emit, its rows named `verdicts/<code>/<case>`: each code in each circumstance the engine reports it, the circumstances that look alike and report nothing beside them (a guard that clears `CEL_NULLABLE_ACCESS`, a schema too open to judge, a site that does not vouch for its roots), and every `fix` the engine offers — the rename of an unknown function with exactly one candidate, and a call moved to its other form, the receiver parenthesized when it must be. A verdict a hole carries over unchanged from its expression is pinned once, under `cel`, in `verdicts.json`, and its re-anchoring in `holes.json`; `verdicts.json` holds hole rows only for what a hole tag adds or words itself — the unreadable hole, the nullable hole and the two conversion refusals.

## Runners

Two Node runners drive the files, each by its own rule. Both execute every row of every file they drive and never skip one.

### The engine's replays

`cel/nodejs/conformance/`, run by `pnpm run check:cel-conformance` — `scripts/check-cel-conformance.mjs`, which names this directory and hands the drivers the host's nominal types (`Telo.TcpPort`, `Telo.UdpPort`, `Telo.HostPath`, `Stream`) — and run in CI. They drive `language.json`, `catalog.json` and `types.json` against `@telorun/cel` alone, and they do not compare `expect` whole. Each row is accounted for as exactly one of:

- **agreed** — the engine answers what the row records, as far as the driver compares;
- **corrected** — the engine answers otherwise, on an authority the driver cites: for most language rows, the row's own `deviation.celSpec`;
- **excluded** — the engine is held to the recording, for one of five reasons.

Values are compared as text through the replays' own conformance-value writer (`conformance-value.ts`), after reading the row's value: the reader accepts a timestamp with any fraction, and the writer writes one with exactly three fractional digits and refuses an instant finer than a millisecond.

The lists are in the drivers, not in the rows: `SPEC_CORRECTION_GROUPS` and `SPEC_EXCLUSION_GROUPS` (`language-replay.ts`), `VALUE_CORRECTION_GROUPS` and `VALUE_EXCLUSION_GROUPS` (`value-replay.ts`), `CATALOG_CORRECTIONS` and `CATALOG_EXCLUSIONS` (`catalog-replay.ts`), `TYPES_CORRECTIONS` and `TYPES_EXCLUSIONS` (`types-replay.ts`). Each correction group names its cause and its authority, and each exclusion group pins its row count there. A row that disagrees with its recording and is on no list fails, as does a language row whose `deviation.celSpec` holds an answer and that is on none; a row listed as corrected fails once the engine answers it as recorded.

The five reasons are a closed set:

- `extension-library` — the row calls into a cel-go extension library Telo does not ship;
- `feature-not-carried` — the answer needs a cel-spec typing feature the engine does not carry;
- `container-not-declared` — the answer is a name resolved through a container, and Telo declares none;
- `uncarried-input` — an input of the cel-spec test the row could not carry: a function declaration, or `disable_check` where the engine refuses at check;
- `evaluation-answer` — the check agrees with the row and the difference is in what evaluation answers. It exists at the check level only: the value level corrects those rows.

What is compared:

- **`language.json` at the check** (`language-replay.ts`). A row recorded as checking must check, to the recorded type as the row spells it. A row recorded as refused must be refused, at the offset the recorded message's highlight points at where it has one. A recorded diagnostic's code and message are not compared. A corrected row carrying `deviation.celSpec.type` must check to that type. An excluded row is still held to checking or being refused as recorded, and to the recorded offset or type unless its group lists it as differing (`offsetDiffers`, `typeDiffers`). Every source that reads must also serialize and read back to an equal tree.
- **`language.json` at evaluation** (`value-replay.ts`). A row recorded with a value must evaluate to it, the two compared as canonical conformance-value text, so a difference of CEL type is a difference. A row recorded with an error must fail, at the check or at evaluation; the error's code and message are not compared, except the message on the six rows [Divergences](#divergences) names. A corrected row is held to its `deviation.celSpec` where it carries one — that value, or failing where cel-spec records an error — and an excluded row to the recording. A row that evaluates as recorded and whose `deviation.celSpec` is a type alone is left to the check-level driver, which must list it as corrected.
- **`language.json` through both backends** (`emitter-identity.ts`). Every row is answered by the closure backend and by the emitted module — or refused by both at compile — and the two answers must be the same text.
- **`catalog.json` and `types.json`** (`dialect-replay.ts`). The static half is the engine's check in the dialect environment plus the host's nominal types and the row's `declarations`; the runtime half is the engine's evaluation in the dialect environment, with `bindings` as the activation. Compared: that the row checks or is refused as recorded; `check.type` where the row checks; the code and message of a row's first diagnostic where that is `CEL_INVALID_ARGUMENT`, byte for byte; the value, as canonical conformance-value text; that a row recorded with an error fails, and — where the recorded message is a catalog refusal, `<function>: …` over a catalog function's name — its message, byte for byte. Not compared: any other diagnostic's code and message, any other error's message, and an error's code. One row of each file is corrected: `catalog/string/timestamp`, which records `.000Z` where the engine writes a whole second with no fraction, and `types/optional/none`. Neither file has an exclusion. Each file's row count is pinned (`CATALOG_ROWS`, `TYPES_ROWS`).

No runner compares `check.calls`, `check.regions`, `check.refs`, `check.volatile`, `check.stringLiteral` or `check.readTypes` of a `catalog.json` or `types.json` row, and none reads those rows' `context`, `explain`, `rootsDeclared` or `couldNameModule`.

The replays fail when the directory holds a file they do not know, when `language.json` carries a key other than `celSpec` and `rows` or a dialect file a key other than `rows`, when a row lacks `expect`, when an `id` repeats, when the number of rows driven differs from the number in the file, and when a `catalog.json` or `types.json` row declares a type the host's nominal types do not hold.

### The templating test

`templating/nodejs/tests/cel-conformance.test.ts`, part of `pnpm --filter @telorun/templating test`. It drives every row of `holes.json`, `module-calls.json` and `verdicts.json` through the tag engine the row names, as [Dialect rows](#dialect-rows) describes, computes the whole `expect` and compares it to the row's by deep equality.

It fails when the directory holds a file other than the six, when any of the six holds a string with an unpaired surrogate, when one of the three files it drives carries a key other than `rows`, when a row of those three carries an unknown key, lacks `id`, `tag`, `source` or `expect`, names a tag other than `cel`, `interpolate` and `sql`, or carries a malformed `modules`, when an `id` repeats, when the number of rows it executed differs from the number in the file, and when evaluating a row hands a conformance handler a value its typed-frame writer refuses — a row of those three files, or a `catalog.json` row recording a value, which the first gate below evaluates. No runner checks a row of `language.json`, `catalog.json` or `types.json` for an unknown key.

It also reads `catalog.json` and `types.json` for the coverage gates. It fails when a catalog overload the dialect environment registers is dispatched by no `catalog.json` row that evaluates to a value, when a catalog function's literal check fires in no `catalog.json` row, when an RE2 parse-error kind of the vocabulary above is the refusal of no `catalog.json` row, when a nominal brand the value types define is declared by no `types.json` row, and when a diagnostic code or Telo error code the tag engines can emit is reported by no `verdicts.json` row, as a diagnostic's `code` or the `code` of the row's `error` — each counted from what the engine, its kind vocabulary, the value-type vocabulary and the engine's verdict vocabulary state, never from a list kept beside the rows. Each engine declares its verdict vocabulary once — its diagnostic codes and its error codes — its type system holds every place it builds a diagnostic or throws a coded error to that declaration, and a runner reads the declaration. A diagnostic code is satisfied only by a diagnostic's `code`, an error code only by a row's `expect.error.code`. The one list the test keeps is of four diagnostic codes the vocabulary declares and the tag engines cannot produce — `CEL_TYPE_ARGUMENT_MISMATCH`, `FUNCTION_ARGUMENT_MISMATCH`, `FUNCTION_ARITY_MISMATCH` and `FUNCTION_UNRESOLVED`: each is exempt from the gate, and the test fails when a `verdicts.json` row reports one.
