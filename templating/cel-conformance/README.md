# CEL conformance vectors

Telo's CEL behaviour, frozen as data. Every file here is a set of rows, each an expression and the Node engine's **whole answer** to it, and this README is their format. Which Node seam gives the answer depends on the file:

- `language.json` holds the whole answer of the engine `@telorun/cel`, in the language environment.
- `catalog.json`, `types.json`, `holes.json`, `module-calls.json` and `verdicts.json` (the dialect files) hold the whole answer of the Node tag engines (`@telorun/templating`, over `@telorun/cel`), in the dialect environment.

A runner computes a row's whole answer and compares it with `expect` by deep equality; no list of rows answered otherwise exists anywhere. Where cel-spec's own outcome still differs from a `language.json` row, the row says so under `deviation`, and cel-spec — not the row — is the authority on what the language means there.

**What deep equality cannot see.** It pins whatever Node answered, a defect included: `catalog/addMonths/result_before_range` recorded a wrong value (a timestamp in 1900) until the calendar was fixed, and a row is only as right as the answer it was recorded from. `deviation.celSpec` is the only check against cel-spec, and only on the rows that carry one. Each gate below states what it cannot see.

The files split along one line:

- **`language.json`** — the bare CEL language: cel-spec's `simple` conformance suite, answered by the engine in the language environment, then a few authored rows pinning what Telo fixes and cel-spec leaves open ([Language rows](#language-rows)).
- **`catalog.json`** — Telo's function catalog: every function in every overload it registers, every refusal a function makes, the literal guards that refuse an argument statically, and every host-backed handler's call.
- **`types.json`** — Telo's types: every nominal value brand, every value type whose members are its fields (`Telo.Url`), the live `Stream` type, and what a read answers over each value that holds no members.
- **`holes.json`** — the hole grammar of the tags that hold text with `${{ … }}` holes, and what `interpolate` and `sql` make of the holes.
- **`module-calls.json`** — calls on a module's name: what resolves as one, how it is typed, and how it is dispatched.
- **`verdicts.json`** — every diagnostic code and Telo error code the tag engines emit, each in each circumstance it is reported.

Row counts, pinned by the runners: `language.json` 1816 (1814 cel-spec rows and 2 authored), `catalog.json` 195, `types.json` 74, `holes.json` 97, `module-calls.json` 53, `verdicts.json` 112.

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
- `functions` — functions the row declares. `signature` is a signature in the engine's signature grammar (`fn(string, int): string`, `int.fn(): int` for a receiver call, a single capital letter for a type parameter). In a language row an entry is `{ "signature" }` alone: the function is declared and has no implementation, and a call to it answers what Node answers — `no_matching_overload`, `no overload of "<name>" takes (<argument types>)`. In a row of `holes.json`, `module-calls.json` or `verdicts.json` an entry is `{ "signature", "result" }` or `{ "signature", "error" }`: a call returns `result` (a conformance value), or, with `error`, answers the CEL error value `invalid_argument` with the `error` string as its message — a declared function is a registered implementation, and a registered implementation fails only as an error value. `catalog.json` and `types.json` rows carry no `functions`.
- `bindings` — variable name → its value at evaluation, a conformance value.
- `expect` — the answer; see below.
- `deviation` — cel-spec rows of `language.json` only: where the answer still differs from cel-spec's, or the row could not carry a cel-spec input; see [`deviation`](#deviation).
- `tag` — dialect rows only, and every one carries it.
- `context`, `explain`, `rootsDeclared`, `couldNameModule`, `modules` — dialect rows of `holes.json`, `module-calls.json` and `verdicts.json` only, the inputs of a tag site; see [Dialect rows](#dialect-rows) and [Module calls](#module-calls). A row of `catalog.json` or `types.json` carries none of them, nor `functions`: those two files ask the engine alone ([Input gate](#input-gate)).

A row carrying any other key is malformed; `divergence`, which an earlier format carried, is refused by name.

## `expect`

`expect.check` is the static answer, and every row carries it.

**In a language row** `expect.check` is `{ "diagnostics", "type"?, "calls" }`:

- `diagnostics` — every diagnostic the engine's check reported, in its order, each `{ "code", "message", "range": { "start", "end" }, "fix"? }`: `code` the `CEL_*` check code, `range` in UTF-16 code units, `fix` — `{ "replacement" }`, the whole corrected source — when the engine offers one. Empty when the expression is clean.
- `type` — present only when `diagnostics` is empty: the type the check resolved, in the spelling `declarations` uses, which is how the engine prints a type. A type parameter the check left unresolved is `dyn`, so `[]` is `list`, `{}` is `map` and `optional.none()` is `optional<dyn>`; this holds wherever a row records a type (`check.type`, a module call argument's `type`). A top-level `list<dyn>` prints as `list` and a top-level `map<dyn, dyn>` as `map`.
- `calls` — every call the checker resolved, in its order, each `{ "name", "form", "namespace"?, "arity", "range": { "start", "end" }, "signature"?, "returns"?, "deterministic"?, "hostBacked"?, "throws"?, "argumentTypes"? }` — every field the checker reports and no other, a field it does not report omitted. A macro lowers to a comprehension and is not listed; the calls written inside it are.

**In a dialect row** `expect.check` is the tag engine's whole static answer; see [The dialect `check`](#the-dialect-check).

Then exactly one of:

- `value` — the evaluation result, a conformance value;
- `error` — the error evaluation threw.

A row carrying `modules` also carries `expect.dispatched`; see [Module calls](#module-calls).

Every file's `expect` is computed whole by a runner and compared to the row's by deep equality, except that the engine's replay of `catalog.json` and `types.json` compares their [projection](#the-engines-projection). Nothing else is compared partially.

### Errors

An error is `{ "code", "celCode", "message" }`, and a language row's also carries `range` when the engine gives one:

- `code` is the Telo error code the error carries (`ERR_…`), else `null`.
- `celCode` is the CEL engine's code for the failure, else `null`: one of the engine's 16 evaluation codes (`no_such_key`, `invalid_argument`, …), an engine-error code (`unreadable_expression` for a source the engine cannot read, and three others), or — only in a language row whose evaluation half its own check refused — the first diagnostic's `CEL_*` code. Evaluation codes are the engine's closed `CEL_EVALUATION_CODES`; a runner counts them from there, never from a list kept beside the rows.
- At most one of the two is non-null, and both are read from **the error that left the seam**, never from its cause: a tag-layer `ERR_*` that replaced an engine error records `celCode: null`. An error carrying no code at all records both as `null` (an unclosed hole, a module function's scripted failure). An error carrying any other code is not one the format can record, and the runner fails naming the row.
- `message` is the full message as thrown, with no rendered highlight: a location is `range`, never text in the message. A message whose error has a location in the expression says where only through `range`.
- `range` — `{ "start", "end" }`, UTF-16 code units: the evaluation error's own range, or the refusing diagnostic's.

A module function's scripted `error` under `modules.functions` is `{ "code", "message" }` and is rethrown unchanged, so the row that dispatches it records `celCode: null`.

Where a message quotes a text **written as a JSON string**, it is the text between double quotes, with `"` and `\` each behind a backslash, U+0008, U+0009, U+000A, U+000C and U+000D as `\b`, `\t`, `\n`, `\f` and `\r`, every other character below U+0020 as `\u` and four lowercase hexadecimal digits, and every other character as itself — U+007F, U+2028 and a character outside the basic plane included. No file holds a string with an unpaired surrogate: such a string is outside the CEL value domain, and a file holding one, raw or as a `\u` escape, is malformed. Not yet pinned: what an engine answers where the Node engine produces such a string, and with it how a message writes one.

## Conformance values

One encoding carries every value — bindings, results, function results and cel-spec's own values in a deviation. It is the typed frame (`kernel/specs/durable-execution.md` §6) held as a JSON value rather than as text: a string, bool, null and finite double are themselves; an int, uint, bytes, timestamp, duration, a non-finite or negative-zero double and a map that is not a plain string-keyed object are tagged under `$telo`, with the frame's canonical payloads and orders. A timestamp is the frame's trimmed form in every file (`2026-03-15T10:30:00Z`, a fraction only where the instant carries one, to the precision it carries); there is no other spelling and no reader that accepts one. On top of the frame, three forms under the reserved key `$cel`:

```json
{ "$cel": "type", "value": "google.protobuf.Duration" }
{ "$cel": "optional", "value": <conformance value> }
{ "$cel": "optional" }
{ "$cel": "host", "type": "Telo.Url", "value": { <member>: <conformance value>, … } }
```

A type value carries its name in the spelling `declarations` uses (`int`, `list`, `null`, `type`, `google.protobuf.Timestamp`), and decodes to the type value the language environment names under it. An optional holds a value, or is none. A host value is a value of a host's own named type: its type name and its own entries, written as a plain string-keyed map is, the one generic form an engine with no codec for the type can read and write. All three forms nest anywhere a frame value may.

`$cel` is reserved exactly as `$telo` is: a data map with `$cel` (or `$telo`) as a key is written as a tagged `map`.

There is no opaque form. A value that cannot be written — one outside the CEL value domain, a string holding an unpaired surrogate among them, or one that does not read back to the same encoding — is an error in generation, never a stand-in: an engine that keeps to the value domain answers such an operation with an error, and the row records that error. Every reader refuses a node that is not the canonical encoding of the value it reads.

## Language rows

A language row runs against the **language environment**: the standard library of `@telorun/cel` under Telo's options (unlisted variables are `dyn`, optional types enabled, heterogeneous aggregate literals allowed) and nothing else — no Telo function catalog, no `Stream` type. The Telo dialect environment is built on it.

A language row drives the language's own seams, and every row runs both halves:

- **Check** — a copy of the language environment plus the row's `declarations` and `functions`, then the engine's type check of `source`. This is `expect.check`.
- **Evaluate** — a copy of the language environment plus the row's `functions` but **without** its `declarations`. The evaluation half checks first, in that environment: when the check refuses, `expect.error` is the refusal — `code: null`, `celCode` the first diagnostic's `CEL_*` code, `message` its message and `range` its range — and nothing is evaluated. Otherwise `source` is compiled and evaluated with `bindings` as the activation, and `expect` is its `value` or the `error` it raised.

So an ill-typed expression evaluates to the checker's error, and a row can record a clean `check` beside such an error (declarations the evaluation half lacks), but never a refused `check` beside a `value`.

Not yet pinned: what `substring` and the receiver `split` answer where the result would hold an unpaired surrogate; the wording with which `bytes.json()` refuses bytes that are not JSON text, and what it answers for an escape naming an unpaired surrogate; how a refused lookup names a key that is not a string, a number, a bool or null; how the refusal of a comprehension's test that answered no bool names what it answered; and what `+` on strings, `join`, `lowerAscii`, `upperAscii`, `string(bytes)`, `bytes.string()`, `bytes.hex()`, `bytes.base64()` and `bytes.json()` answer for a text past the longest string, 536,870,888 UTF-16 code units — the Node engine throws a host `RangeError`, crashes, exhausts its heap or names the bytes not UTF-8, and the Rust engine answers `<function>: the text built would exceed the longest text a string can hold (536870888 UTF-16 code units)`, code `invalid_argument`.

The authored row `telo/getHours/unknown_zone` pins a zone the engine does not know: `t.getHours(z)` over a bound timestamp and the zone `Nowhere/Land` answers `invalid_argument`, `"Nowhere/Land" is not a time zone`, the zone written as a JSON string. The row `timestamps/timestamp_selectors_tz/getHours` pins a zone written `HH:MM` as a fixed offset ahead of UTC, so it evaluates to `1`.

### Two classes of row

`language.json` is one file in two classes, in this order:

1. **The cel-spec import**, in import order. Every row carries `provenance`.
2. **Authored rows**, after the import, with ids `telo/<subject>/<case>`: each pins a language-environment answer Telo fixes and cel-spec leaves open (an unknown zone, `optional.none().value()`). An authored row carries neither `provenance` nor `deviation`.

`provenance` is present exactly when the id does not start with `telo/`, and a cel-spec row after an authored one is malformed.

### From cel-spec

Every kept cel-spec `simple` test is one row, and its `expect` is the engine's whole answer. What cel-spec says goes into `deviation`, only where it still differs.

| cel-spec | Row |
| --- | --- |
| `expr` | `source` |
| file, section and test name | `id`, `provenance` |
| `type_env` identifier | `declarations`, the type in the spelling that key defines (`optional_type` is `optional<…>`, a well-known Timestamp or Duration is `google.protobuf.Timestamp` / `google.protobuf.Duration`) |
| `type_env` function overload | a `functions` entry, `{ "signature" }` alone; an overload the engine's signature grammar cannot state is uncarried |
| `bindings` | `bindings`; cel-spec's `int64`, `uint64`, `double`, `string`, `bytes`, `bool`, `null`, list, map, type (`null_type` is `null`), Timestamp and Duration are the CEL values of the same type |
| `container`, `disable_check`, `disable_macros`, `check_only` | uncarried: the row always checks and evaluates, with no container and with macros |
| no result matcher | an expectation of `true` |
| `value` | compared with the evaluation result |
| `typed_result` | its result compared with the evaluation result (unless `check_only`), its deduced type with `expect.check` |
| `eval_error`, `any_eval_errors` | compared as "an error": any error agrees, whatever its message |
| `unknown`, `any_unknowns` | recorded as cel-spec's outcome; no answer of this engine is an unknown set, so it always differs |

Values compare by CEL equality including the type: an int, a uint and a double are never equal; NaN equals NaN; `-0` equals `0`; maps compare regardless of order.

### `deviation`

`deviation` has at least one of:

- `celSpec` — cel-spec's outcome, only the parts where it still differs from `expect`: `{ "value": <conformance value> }`, `{ "error": "<cel-spec's message text>" }`, `{ "unknown": [ <expression ids> ] }` or `{ "type": "<cel-spec's deduced type in the spelling declarations uses>" }`. A `typed_result` whose value and type both differ carries both. A part agrees with the answer when, by the cel-spec rule above (CEL equality including the type, NaN equals NaN, `-0` equals `0`, maps unordered, any error agreeing with an error, `type` against `check.type`), cel-spec and `expect` say the same; an agreeing part is dropped, so no stated part agrees.
- `reason` — present exactly when `celSpec` is, one of four closed values naming why the engine's answer differs from cel-spec's:
  - `extension-library` — the row calls into a cel-go extension library Telo does not ship;
  - `feature-not-carried` — the answer needs a cel-spec typing feature the engine does not carry;
  - `container-not-declared` — the answer is a name resolved through a container, and Telo declares none;
  - `uncarried-input` — an input of the cel-spec test the row could not carry decides the answer (a function declaration, or `disable_check`).
- `uncarried` — the cel-spec inputs the row could not carry: `container`, `disable_check`, `disable_macros`, `check_only`, or `function <overload id>` for a function declaration the engine's signature grammar cannot state. It may stand alone. `uncarried-input` requires it non-empty, and `container-not-declared` requires it to hold `container`.

**What the checks cannot see.** `deviation` is the only place cel-spec is consulted, so a row with none is a row cel-spec was not asked about or agrees with; the checks hold the stated parts to being true, not the absent ones to being absent.

### What is dropped

A cel-spec test is dropped exactly when it constructs, declares, binds or names a protobuf message or enum type outside Telo's CEL value domain: the test protos (`TestAllTypes`, `NestedMessage`, `NestedTestAllTypes`, `NestedEnum`, `GlobalEnum`, `TestRequired`, `Proto2ExtensionScopedMessage`), enum values, the `google.protobuf` wrappers (`BoolValue`, `BytesValue`, `DoubleValue`, `FloatValue`, `Int32Value`, `Int64Value`, `StringValue`, `UInt32Value`, `UInt64Value`), `Any`, `Struct`, `Value`, `ListValue`, `NullValue`, `Empty` and `FieldMask`. `google.protobuf.Timestamp` and `google.protobuf.Duration` are CEL's timestamp and duration, and are kept. Every extension-library file (`string_ext`, `math_ext`, `lists_ext`, `encoders_ext`, `bindings_ext`, `block_ext`, `network_ext`, `optionals`, …) is kept: the engine's answer — usually a rejection — is what pins which extensions it lacks. Nothing is dropped for what the engine accepts.

## Dialect rows

A dialect row runs against the **dialect environment**: the language environment plus Telo's function catalog, every value type's CEL face and the `Stream` type, with the conformance handler set (below) installed as its host handlers. It drives the seams of the TAG ENGINE the row names — `cel`, `interpolate` or `sql`: the engine's `analyze`, then its `compile` and an evaluation of what it compiled — and every row runs both halves. The rows of `holes.json`, `module-calls.json` and `verdicts.json` are driven exactly so. Every row of `catalog.json` and `types.json` names `cel`; those two files are answered by the tag engine like the rest, and also by `@telorun/cel` alone through the [projection](#the-engines-projection) (see [Runners](#runners)).

- **Static** — a copy of the dialect environment, which carries every nominal value brand (each brand a type of its own: its conversion to its base, `int(<brand>)` over an int and `string(<brand>)` over a string; `string(<brand>)` where the base is not a string; and, for a brand whose values come from the host, `<brand>.joinPath(string)` typed back to the brand), plus the row's `declarations` and `functions`. The engine analyzes `source` against it, given the row's `context`, `rootsDeclared`, `couldNameModule` and `modules`.
- **Runtime** — a copy of the dialect environment plus the row's `functions`, **without** its `declarations`. The brands are registered there too, and change no evaluation: at runtime a branded value is its base. The engine compiles `source` against the row's module names, and the compiled value is evaluated with `bindings` as the activation and the row's module functions bound as the dispatch table; a result that is a promise is awaited.

### Dialect row keys

- `tag` — the tag whose engine the row drives, without its `!`: `cel` (the whole source is one expression), `interpolate` or `sql` (text with holes; see [Holes](#holes)). Every dialect row carries it.
- `context` — the site's context, a JSON Schema: what the engine receives as the schema member-access chains are checked against (an unknown field, a nullable dereference, member access past a live value). Absent means an open context, against which no chain is judged.
- `explain` — a schema of the names the site reads, JSON Schema. No tag engine reads it: a row answers as it would without it. What is read of `context` is [below](#what-the-engine-reads-of-a-schema).
- `rootsDeclared` — `true` when the environment declares every name legal at the site, so a root identifier it does not know is reported as unknown. Absent means the check is off.
- `couldNameModule` — the list of names the host's naming rule says could denote a module; every other name could not. Absent means the host supplies no rule.
- `modules` — the declaring module's names and the module functions the host answers for; see [Module calls](#module-calls). Absent means no name set: every call is an ordinary one.

### What the engine reads of a schema

`context` and a module function's `resultSchema` are JSON Schemas, of which the engine reads `properties`, `additionalProperties`, `items`, `type`, `const`, `allOf`, `anyOf`, `oneOf` and a document-local `$ref` (`#…`), and one annotation, `x-telo-type`. A value type declaring members is read by those members as its closed properties. A reference that is not local, or whose target no node on the walk holds, leaves the chain unjudged.

A member chain is checked one segment at a time, from the root of the schema:

- A named member is looked up in `properties`. A schema with no `properties` is open, and nothing at or below it is judged. A name `properties` holds leads to that property's schema. A name it does not hold is undeclared — `'<the chain up to that name>' is not defined (available: <the declared names in the schema's own order, joined by ", ">)` — unless `additionalProperties` is exactly `true`, which leaves the name and everything below it unjudged. `additionalProperties` holding a schema, or `false`, changes nothing for a named member.
- An index, whatever its expression, reads an element: the schema under `items` when that is one schema; otherwise — `items` absent, or a list of schemas, which is not read — in a schema with no `properties`, the schema under `additionalProperties` when that is a schema. Where neither gives an element the rest of the chain is unjudged: a list under `items` with no `additionalProperties` schema beside it, and any index into a schema that has `properties`, whatever its `additionalProperties`. In a message an index is the segment `[*]`, joined with a dot like any other.
- A property whose schema carries `x-telo-type` naming the live value type `Telo.Stream` — as that string, or as an object whose `name` is that string — is a live value. Reading it is clean; reading anything past it is `'<the chain up to it>' yields a stream — pipe it through an Encoder or iterate in a JS.Script step (no member access on stream-typed values)`. An `x-telo-type` naming any other type is not read.

Each finding is a `CEL_UNKNOWN_FIELD`. Under `context` every chain of the expression is judged, each reported in the order read — except one whose member the checker already refused as `CEL_UNKNOWN_FIELD`, or whose message the engine already reported.

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

`refs` and `volatile` are what compiling answers. When compilation throws, `check` keeps everything the static half answered and carries neither `refs` nor `volatile`, nothing is evaluated, and the compile error is the row's `error` (see [Errors](#errors)). Every offset counts UTF-16 code units from the start of `source`. Then, as in every row, exactly one of `value` or `error` — the evaluation's result or the error compiling or evaluating threw (see [Errors](#errors)).

### Holes

The `interpolate` and `sql` tags hold text with holes, and one grammar reads both.

- A hole opens at `${{`. Outside a hole nothing else is special: `$`, `{`, `${`, `{{` and `}}` are text.
- A hole closes at the first `}}` that is outside a quoted literal and outside any `{` the hole's own text opened. A `}` closing such a brace closes no hole, and a `}` outside every brace that is not followed by a second `}` leaves the hole unclosed.
- A quoted literal inside a hole ends exactly where the language ends it: the hole grammar has no literal rule of its own and asks the engine (`quotedLiteralEnd` in `@telorun/cel`, `quoted_literal_end` in `telorun-cel`). A quoted literal is a string or bytes literal — `'…'`, `"…"` and their triple-quoted forms — or a member name between backticks. The word directly before a string quote is its prefix and switches the reading only when the language accepts it: `r`, `b` or `br`, in any case; `rb` and every other word mean a plain literal (which the expression then refuses, as `holes/language/prefix_rb` pins). In a string without the `r` prefix a backslash takes the next character with it, so an escaped quote does not end the string — and neither does a line feed or a carriage return directly after a backslash: the backslash rule comes first, the string runs on, and what the expression makes of that escape is its own matter. A raw string is read whole too: a `}}` inside it closes no hole, and a backslash takes the next character with it, kept as written — so `r'\''` is a backslash and a quote, and in `r'\'` the backslash takes the closing quote and the hole never closes — except before a line feed or a carriage return of a single-line literal, where the backslash is content; a backslash that ends the source is content too. A single-line literal ends unterminated at a line feed (U+000A) or a carriage return (U+000D), and so does its hole; a triple-quoted one may span lines and holds both as written. A member name between backticks ends at the next backtick, and is unterminated when there is none or a line feed or a carriage return comes first. No other character ends a literal: U+2028 inside one is content. A comment is not read: `//` is hole text like any other, so a quote after it opens a literal.
- A literal `${{` is written as a hole that yields it: `${{ '${{' }}`.
- A hole that never closes makes the whole scalar unreadable, at the offset of its `${{`. Statically that is one `CEL_SYNTAX_ERROR` — `the hole opened at offset <n> never closes — a hole ends at the first '}}' outside a string literal and outside any braces it opened` — with no calls and no regions, whatever holes precede it; compiling throws the same sentence behind `!<tag>: `, both codes `null`.
- A hole's expression is its body without the whitespace at either end, whitespace being exactly U+0009 to U+000D, U+0020, U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF. Any other character — U+0085, for one — stays in the expression. An empty body is an empty expression, which CEL refuses.

A scalar has one of four shapes: `none` (no hole), `lone-hole` (exactly one hole with only whitespace around it), `interpolated` (any other readable text with holes) and `malformed` (a hole that never closes). Both tags read the first three alike: a lone hole under `interpolate` is still text, and the whitespace around it is kept. Which shape a scalar has is not an answer of either tag, so no row carries it: the naming of the shapes is not pinned and binds no engine.

Statically each hole's expression is analyzed exactly as a `cel` row's source is, in order, with every site input of the row; `check` is their sum. `diagnostics` holds each hole's diagnostics in hole order, worded as they are under `cel`: a `fix` is re-anchored — its `replacement` is the whole scalar with that one hole's expression replaced. `calls` holds each hole's calls with offsets counted in the scalar. There is no `type`, `stringLiteral` or `readTypes`. Compiling compiles each hole; `refs` is the sorted union over the holes and `volatile` holds when any hole is volatile. A hole CEL cannot parse fails the compile with CEL's own error for that expression.

**`interpolate`** yields a string: the text between the holes joined with `string(<hole>)` for each hole — CEL's own conversion in the dialect environment, never the host language's. A string is itself, an int and a uint their decimal digits, a bool `true` or `false`, a double as `string()` writes it, bytes their UTF-8 text, a timestamp RFC 3339 in UTC, its fraction written to the precision it carries and omitted when the instant is whole (`2026-03-15T10:30:00Z`), a duration its seconds (`5400s`). Holes are evaluated and converted left to right, and the first failure is the row's error.

A hole that analyzed clean gets one more verdict. When its expression is a plain member chain whose `context` schema admits null, it is `CEL_NULLABLE_ACCESS` — `'<chain>' may be null, and a null has no text — guard it in the hole (e.g. '${{ <chain> != null ? <chain> : "" }}').`. Otherwise, when its checked type is one no one-argument global `string()` overload of the static environment accepts — `dyn` always passes, and a nominal brand converts — it is `INTERPOLATION_HOLE_NOT_CONVERTIBLE`: `the hole '${{ <expr> }}' is <type>, which CEL's string() cannot convert to text. Convert it inside the hole (e.g. join a list, or read the field you meant), or write the whole value as !cel.`. A hole with a diagnostic of its own gets neither.

At evaluation a hole whose value `string()` refuses fails with the code `ERR_INTERPOLATION_HOLE_NOT_CONVERTIBLE`: `the hole '${{ <expr> }}' at offset <n> of !interpolate <source> evaluated to <what>, which CEL's string() cannot convert to text. Declare outputType on the resource producing it so the check sees its type, or guard it inside the hole.` — `<n>` the offset of the hole's `${{`, `<source>` the whole scalar written as a JSON string (see [Errors](#errors)), and `<what>` the value in CEL's terms: `null`, `a list`, `a map`, `a value of type <type>` — `<type>` the name `type()` gives the value in the dialect environment (`optional_type` for an optional, `type` for a type value, a host type's own name) — or `a value outside the CEL value domain` for a value of no CEL type, which no row can carry and a unit test pins. No host class name reaches the message. The static half refuses an optional and a type too (`${{ optional.of(1) }}`, `${{ int }}`).

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

**How it is dispatched.** The runtime half binds the row's `functions` as the dispatch table — qualified name to function — under a key no expression can name. Evaluating a module call looks its qualified name up first: with none bound it fails, before any argument is evaluated, with `unbound function '<qualified name>' — nothing is bound under that name here`, `code` `null` and `celCode` `unbound_function`. Otherwise the arguments are evaluated left to right and the function is handed their values in order; the call's value is its `result`, or the evaluation fails with its `error`, code and message unchanged.

`expect.dispatched` is every dispatch evaluation made, in the order made, each `{ "name", "arguments" }`: the qualified name and the values handed over, as conformance values. Every row carrying `modules` carries it; no other row does.

**The unknown-identifier hint.** Under `rootsDeclared`, an undeclared root identifier is `CEL_UNKNOWN_IDENTIFIER` — `unknown identifier '<name>' — nothing by that name is in scope here.`, once per name. When that name is written as the receiver of a call and `couldNameModule` lists it, the message continues ` To call a function another module declares, '<name>' must be one of this module's names — an 'imports:' alias, 'Self', or the module's own metadata.name.`; without `couldNameModule`, or for a name it does not list, it does not.

### The conformance handler set

Nine catalog functions reach the host through a handler: `sha256`, `md5`, `sha1`, `sha512`, `hmac`, `base64Encode`, `base64Decode`, `json` and `joinPath`. In every dialect row each handler answers with the text `<handler name>(<arg>, …)` — its name, then each argument it was handed, in order, written as its typed-frame text (`kernel/specs/durable-execution.md` §6) and separated by `, `. So `sha256('abc')` evaluates to `sha256("abc")`, `'/data'.joinPath('reports')` to `joinPath("/data", "reports")`, and `json({'a': 1})` to `json({"a":{"$telo":"int","value":"1"}})`: a row pins exactly what the engine hands the host, and every engine reproduces the text with its own typed-frame writer. The set is defined only over values the typed frame writes. A value it cannot write — an optional, a type value, a live `Stream`, a number or an instant outside the value domain, a string holding an unpaired surrogate — has no frame text, so no row hands one to a handler: such a row is malformed. What a writer answers when it refuses is the typed frame's own contract (`kernel/specs/durable-execution.md` §6.1 and §6.5: `ERR_TYPED_FRAME_UNENCODABLE` and its `path`), not these vectors'; it is not pinned here and binds no engine.

**A conversion a value type with members implements follows the same rule.** `string()` of a `Telo.Url` is the host's own conversion, and in both drives it answers `<name>(<conformance text of each argument>)` too, so `types/Url/string` pins what the engine hands the host and not the URL's text. A driver registers these from the value-type entries, naming no type: every `members`-bearing entry's `string(Self)` is bound to the rule.

A catalog function whose result differs per call (`now`, `nowIso`, `today`, `nowMillis`, `nowSeconds`, `uuidv1`, `uuidv4`, `uuidv6`, `uuidv7`) is pinned only through a deterministic expression over its result — a size, a type, a suffix, a comparison against a fixed instant — never by recording a value it returned.

### Catalog refusals

Every refusal a catalog function makes is worded by Telo — `<function>: <what is wrong>` — and is the same text on every engine; a row records it verbatim, with `code` `null` and the `celCode` the engine gives the failure (`invalid_argument` for a refused argument). No wording of a library or of the host language's runtime reaches one, except in the refusals listed first below. Two families are fixed by rule rather than by a sentence.

Not yet pinned — no row answers on any of these:

1. the refusals of `range` (a count too large), `urlDecode`, `urlEncode`, `uuidv3`, `uuidv5`, `uuidVersion`, `hmac` (an unknown algorithm) and `joinPath` (an absolute argument), and of a text built past the longest string — each is still a dependency's or the host's wording;
2. whether `parseJson` and `bytesFromBase64` refuse a literal argument statically — their refusals at evaluation are pinned, through a bound argument;
3. what a catalog function answers where its result would hold an unpaired surrogate — `parseJson` for a text whose string holds one, `slice` for a string range that starts or ends inside a surrogate pair, `split` for an empty separator and `replace` for an empty search over a string holding a pair.

Until these are pinned, the Rust engine (`telorun-cel`) answers each with an interim reading of its own, an error value where the Node engine throws its host's or a dependency's exception out of evaluation or answers a string holding half a pair — all `invalid_argument` unless named:

- `range`: `range: count must be at most 4294967295, got <n>` past the longest array, and `range: a list of <n> elements is more than this process can allocate`, reached only where the host's allocator refuses the list — on a host that overcommits memory the process is killed building it, as the Node engine's is;
- `format` with a width past the longest string: `format: width <w> exceeds the longest text a string can hold (536870888 UTF-16 code units)`, its own wording;
- a text built past the longest string, 536,870,888 UTF-16 code units — by `join`, `replace` (an empty search or any other), `regexReplace` (both arities), `urlEncode`, `upper`, `lower`, `bytesToBase64`, a list read as text (`join`'s elements, `sort`'s texts, a specifier, zone, flags, pattern or decimal places given as a list), or a refusal holding a value, which answers it instead: `<function>: the text built would exceed the longest text a string can hold (536870888 UTF-16 code units)`, found before the text is built — where the Node engine throws a host `RangeError`, or crashes (`lower` of `İ`), exhausts its heap (`bytesToBase64`) or names bytes decoded past it not UTF-8;
- `urlDecode`: `urlDecode: '%' at offset <n> is not followed by two hexadecimal digits`, and `urlDecode: the bytes percent-encoded at offset <n> are not valid UTF-8`, naming the `%` of the sequence's first byte, offsets in UTF-16 code units; `urlEncode` refuses only a text past the longest string, no Rust string holding an unpaired surrogate;
- `uuidv3` and `uuidv5`: `<function>: invalid namespace UUID "<value>"`, and `uuidVersion`: `uuidVersion: invalid UUID "<value>"`, the value written as a JSON string;
- `parseJson` of an escape naming an unpaired surrogate: `parseJson: unpaired surrogate at offset <n>`, the escape's backslash; and `slice`, `split` and `replace` where a cut falls inside a pair: `<function>: offset <n> is inside a surrogate pair`, the first such cut, in UTF-16 code units;
- `merge` of a uint key into a map with string keys: `merge: a key of type uint cannot be held by a map with string keys`;
- `uuidv1`, `uuidv4`, `uuidv6` and `uuidv7` where the operating system's random source answers nothing: `<function>() needs the host's random source, which is unavailable here`, code `unbound_function`;
- any of the nine host-backed functions (`sha256`, `md5`, `sha1`, `sha512`, `hmac`, `base64Encode`, `base64Decode`, `json`, `joinPath`): the host's handler refuses, in the catalog's voice, and its refusal is the call's error value with the handler's own code and message — where the Node engine lets a handler's failure leave evaluation as a thrown exception;
- a calendar result outside ECMAScript's time range (`addMonths` by a huge count), where the Node engine throws a host `RangeError`: `<function>: the result is outside the range of a timestamp`, code `invalid_conversion`, the settled wording.

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

`catalog.json` holds, for every function of the catalog and every overload it registers (one registration per signature, an optional parameter registering one per arity), at least one row whose evaluation dispatches that overload and returns a value; for every function that checks its literal arguments, a row where that check refuses one statically (`CEL_INVALID_ARGUMENT`); and every host-backed function's call through the handler set. Its rows also record the catalog's call classification — a function called in the wrong form, a name no function has, an argument type no overload takes. And it holds a row for every refusal a catalog function makes (see [Catalog refusals](#catalog-refusals)), except those listed there as not yet pinned: each distinct refusal of each function, every RE2 parse-error kind, and for each regex function an invalid pattern refused at evaluation — the pattern bound, so the check passes — and one refused statically, the pattern a literal. Among them are an unknown time zone for `nowIso` and `today`, an `addMonths` result outside a timestamp's range on either side (and one in a year below 100, which reads as itself), and a non-finite number handed to `round`, `format`, `fixed` and `formatDuration`; each decides its argument through a bound variable, so no row pins whether a literal guard exists.

`types.json` holds, for every nominal value brand, a row declaring a variable of it and reading it, its conversion to its base, its `string()` rendering, an operator its base accepts refused on the brand, and — for a brand whose values come from the host — `joinPath` typed back to the brand; for the live `Stream` type, a value passed through and member access refused; and, under the subject `optional`, the none optional, typed `optional<dyn>`. No conformance value carries a live `Stream`, so a `Stream` row binds nothing and records what the engine answers without the value. For every value type declaring members, under its own subject (`types/Url/…`), it holds a row reading each kind of field (a string, an int, a map's entry, a field by index), the presence forms over a field the value holds and one it does not (`has()`, `.?`), the ordinary read of a field it does not hold — a CEL error — a field the type does not declare refused at check, and `string()` reaching the host's own conversion, whose conformance implementation answers `string(<conformance text of the value>)`, so the row pins what the engine hands the host rather than the URL's text: that text is pinned by `sdk/value-types/encodings/url-text.json`, which each runtime's codec runs. **These rows are authored, not recorded.**

It also holds, under the subject of each value that holds **no members at all** — `string`, `int`, `uint`, `double`, `bool`, `bytes`, `timestamp`, `duration`, `null`, a nominal brand, and `dyn` for the one receiver whose shape the check does not know — a row per **presence-shaped** read over it: `a.?b`, `a[?k]` and `has(a.b)`. Each answers **absence** (`optional.none()`, or `false` for `has()`), and each whose operand type is known refuses at check with `CEL_TYPE_ERROR`, so one row pins both halves. Beside them are the three readings that are not absence: the ordinary read of such a member (`types/dyn/ordinary_read`), the ordinary step of a chain that has entered optional land (`types/optional/ordinary_read_over_scalar`), and an unusable key in the presence form (`types/list/presence_unusable_key`) — each a CEL error. **These rows are authored, not recorded**: they are what this engine answers, and the authority for them is the optional library Telo enables, which enters whole from cel-go — whose attribute qualification answers "not found" for a receiver that is neither a mapper, a lister nor an indexer whenever the read is a presence test, erroring only under an explicitly named opt-in Telo does not carry.

### Input gate

`catalog.json` and `types.json` ask the engine alone, so a row of either carries none of `context`, `explain`, `rootsDeclared`, `couldNameModule`, `modules` or `functions` — inputs only a tag site has — its `source` reads with no syntax diagnostic, and every error it records has `code: null` and a non-null `celCode`. Both Node runners enforce it, and a row failing it is refused naming the row. It cannot see an input a tag site has that is not on that list; the list is the format's.

### The engine's projection

The engine's replay of `catalog.json` and `types.json` compares the part of a row's answer `@telorun/cel` gives by itself, not the whole answer:

- `check.diagnostics`, each `{ code, message, fix? }`, in order — no `range`;
- `check.type`, when present;
- the row's `value`, or its `error` whole (`code`, `celCode`, `message`).

Outside the projection, and so seen only by the templating test: `calls`, `stringLiteral`, `readTypes`, `regions`, `refs` and `volatile`. That is this driver's blind spot: whatever the tag engine adds to a row is not held here.

The two halves are computed independently, as a dialect row's are:

- **Static** — the engine's check in the dialect environment, plus the [host types](#host-types) and the row's `declarations`. Diagnostics are recorded without their range; `type` only when there is none.
- **Runtime** — the engine's own evaluation, unchecked, in the dialect environment plus the host types, **without** the row's `declarations` and with `bindings` as the activation. The conformance handler set serves the nine host-backed functions, and each conversion and member a host type declares is bound to the conformance rule. The value is in the canonical encoding, and both sides are compared by deep equality.

### Host types

The engine knows no host type name, so a driver is handed the host's types. They are derived from `sdk/value-types/*.json` by rule, naming no type:

- an entry with `representation: json` and no `celType` is a brand over its `base`, with its base conversion (`int(Self): int`) and `string(Self): string`; where the base is a string, the `string` conversion alone;
- `fromHost` adds the member `Self.joinPath(string): Self`;
- an entry with `members` becomes a type whose fields are those members — each member's schema read as a CEL type: a string, a number, a boolean, a list's element, a map's value — plus `string(Self): string`;
- plus `Stream`, over `dyn`, with nothing declared.

A row declaring a type name that no host type accounts for is malformed. Every Node and Rust driver derives the list itself; `scripts/check-cel-conformance.mjs` is the Node one and holds no hand-written list.

### The `celCode` gate

Across all six files, the templating test counts the codes the rows record: every one of the engine's evaluation codes is some row's `celCode`, except `async_value_unsupported`, held unreachable (a row recording it fails the gate); every `celCode` is an evaluation code, an engine-error code, or — in a language row only — a `CEL_*` check code; no error has both `code` and `celCode`. A reachable code with no row gets an authored row (`telo/…` in `language.json` for a language code). The gate counts codes over the whole set of files, not per catalog function: a function's refusal being recorded under some other function's row satisfies it.

### `holes.json`, `module-calls.json` and `verdicts.json`

`holes.json` holds the hole grammar through both hole tags: each of the four scalar shapes; a hole holding a string with `}}` in each quoting and under each one-letter prefix in either case, a raw string whose backslash takes its quote, ends the string and is doubled at its end, the two-letter prefixes, a member name between backticks holding `}}`, a comment holding text, a map literal, an escaped quote, an escaped line feed and an escaped carriage return, a single-line string broken by a line feed or a carriage return (a raw one and a member name included), a triple-quoted one holding a carriage return, and a string holding U+2028; a literal `${{`; each way a hole fails to close; adjacent, repeated, padded, unpadded and empty holes, every whitespace character trimmed from a hole and one that is not; offsets past a character outside the basic plane. For `interpolate` it holds the conversion of every type `string()` accepts, a brand, the static refusal of a list, a map, a null, an optional and a type, the refusal of a null, a list, a map, an optional and a type at evaluation, and the nullable-chain hole with and without its guard. It holds a diagnostic, each kind of `fix` and the call offsets re-anchored onto the scalar; and for `sql`, what it yields for typed values, for a null, a list and a map, and for a hole that fails. Its `cel` rows (`holes/language/*`) pin what the language itself reads of the cases the hole grammar now takes from it: a raw string with a backslash before its own quote, at its end and doubled at its end, and a string under each two-letter prefix.

`module-calls.json` holds a call through each kind of name a set holds — an import alias, `Self`, the module's own name, `Telo` — and every reading that is not a module call; the arguments as the check saw them, a function the row itself declares among them, and a type and an optional handed over; the call typed by `returns` and its member reads checked against `resultSchema`; the flags with and without a `functions` entry; dispatch inside a comprehension, nested, repeated, skipped by a short circuit, failing as scripted with and without a code, and unbound; the unknown-identifier hint with and without the host's rule; and a module call inside a hole of each hole tag.

`verdicts.json` holds a row for every diagnostic code and every Telo error code the three tag engines can emit, its rows named `verdicts/<code>/<case>`: each code in each circumstance the engine reports it, the circumstances that look alike and report nothing beside them (a guard that clears `CEL_NULLABLE_ACCESS`, a schema too open to judge, a site that does not vouch for its roots), and every `fix` the engine offers — the rename of an unknown function with exactly one candidate, and a call moved to its other form, the receiver parenthesized when it must be. A verdict a hole carries over unchanged from its expression is pinned once, under `cel`, in `verdicts.json`, and its re-anchoring in `holes.json`; `verdicts.json` holds hole rows only for what a hole tag adds or words itself — the unreadable hole, the nullable hole and the two conversion refusals.

## Runners

Each runner executes every row of every file it drives, never skips one, and pins each file's row count, because a row that is deleted leaves every other number true. A row whose input cannot be built is malformed and fails its runner naming the row.

### The engine's replays

`cel/nodejs/conformance/`, run by `pnpm run check:cel-conformance` — `scripts/check-cel-conformance.mjs`, which names this directory and hands the drivers the host types derived as [Host types](#host-types) states — and in CI. They drive `language.json`, `catalog.json` and `types.json` against `@telorun/cel` alone.

- **`language.json` whole** (`language-replay.ts`). The answer is computed by the two halves of [Language rows](#language-rows) and compared with `expect` by deep equality (`LANGUAGE_ROWS`, 1816). Beside it, the format: a row's keys, the two classes with `provenance` exactly for cel-spec rows, `divergence` refused, every error `{ code, celCode, message }` (with `range` where the engine gives one) and its `celCode` in the vocabulary; and `deviation`'s checks — `reason` exactly when `celSpec`, one of the four reasons, every stated part disagreeing with the answer (an agreeing one fails, instructing to drop it), `uncarried-input` with a non-empty `uncarried`, `container-not-declared` with `container` in it. Every source that reads also writes back and reads again to an equal tree, with no exception. Blind spot: deep equality pins whatever the engine answered, and only `deviation.celSpec` is checked against cel-spec.
- **`catalog.json` and `types.json` through the [projection](#the-engines-projection)** (`dialect-replay.ts`), after the [input gate](#input-gate); `CATALOG_ROWS` 195, `TYPES_ROWS` 74. Blind spot: nothing outside the projection.
- **Both backends** (`emitter-identity.ts`). Every `language.json` row is answered by the closure backend and by the emitted module — or refused by both at compile — and the two answers must be the same text. It asks whether the backends agree, not whether the answer is right.

The replays fail when the directory holds a file they do not know, when `language.json` carries a key other than `celSpec` and `rows` or a dialect file a key other than `rows`, when a row lacks `expect`, when an `id` repeats, and when the number of rows driven differs from the pin or the file.

### The templating test

`templating/nodejs/tests/cel-conformance.test.ts`, part of `pnpm --filter @telorun/templating test`. It drives **all five dialect files whole**: every row through the tag engine it names, as [Dialect rows](#dialect-rows) describes, the computed `expect` compared with the row's by deep equality. It reads `language.json` only for the file-set, surrogate and `celCode` gates.

It fails when the directory holds a file other than the six, when any file holds a string with an unpaired surrogate, when a dialect file carries a key other than `rows`, when a dialect row carries an unknown key, lacks `id`, `tag`, `source` or `expect`, names a tag other than `cel`, `interpolate` and `sql`, or carries a malformed `modules`, when an `id` repeats, when the number of rows executed differs from the number in the file, when a row's error is not `{ code, celCode, message }`, when a `catalog.json` or `types.json` row breaks the [input gate](#input-gate), when the [`celCode` gate](#the-celcode-gate) fails, and when evaluating a row hands a conformance handler a value its typed-frame writer refuses.

Coverage gates read `catalog.json`, `types.json` and `verdicts.json`. It fails when a catalog overload the dialect environment registers is dispatched by no `catalog.json` row that evaluates to a value, when a catalog function's literal check fires in no `catalog.json` row, when an RE2 parse-error kind of the vocabulary above is the refusal of no `catalog.json` row, when a nominal brand, or a value type whose members are its fields, is declared by no `types.json` row, and when a diagnostic code or Telo error code the tag engines can emit is reported by no `verdicts.json` row, as a diagnostic's `code` or the `code` of the row's `error` — each counted from what the engine, its kind vocabulary, the value-type vocabulary and the engine's verdict vocabulary state, never from a list kept beside the rows. A diagnostic code is satisfied only by a diagnostic's `code`, an error code only by a row's `expect.error.code`. The one list the test keeps is of four diagnostic codes the vocabulary declares and the tag engines cannot produce — `CEL_TYPE_ARGUMENT_MISMATCH`, `FUNCTION_ARGUMENT_MISMATCH`, `FUNCTION_ARITY_MISMATCH` and `FUNCTION_UNRESOLVED`: each is exempt, and the test fails when a `verdicts.json` row reports one. Blind spot: the coverage gates count, they do not pair — a function's overload dispatched by some row says nothing about that row's answer being right.

### The Rust templating test

`templating/rust/tests/cel_conformance.rs`, part of `cargo test -p telo-templating`, is today the Rust twin of the templating test over the three tag files: it drives every row of `holes.json` (97), `module-calls.json` (53) and `verdicts.json` (112) through the tag engine the row names and compares the computed `expect` to the row's by deep equality, ignoring key order. Its helpers are `templating/rust/tests/support/` — a subdirectory because that is Rust's integration-test layout for code shared by several test files — and its codec has its own tests in `tests/cel_conformance_value.rs`. The codec is the typed frame from `telorun-sdk-core` held as a JSON value, plus the `$cel` type and optional forms; it has no host form yet. Its error shaping classifies as Node does — a Telo `ERR_*` into `code`, an engine error into `celCode`, nothing into both `null`, any other code failing the row.

It enforces the Node test's gates over the three files it drives — the directory's file set, no unpaired surrogate (a Rust string holds none, so a file holding one fails to read, and a test shows the JSON reader refusing the escapes), the keys a file and a row may carry, the required members, the tags, `modules`, unique ids, the row count of each file pinned and every row executed, a handler handed a value the typed frame refuses making its row malformed — and the coverage gates over `types.json` (every nominal brand and every value type declaring members declared by some row; declarations are read, nothing is evaluated) and `verdicts.json` (every code of Rust's `CEL_VERDICT_CODES` reported by some row, the four exempt codes excepted and refused if a row reports one). One gate has no Node twin: every value a row holds — bindings, module function results, the expected value and the arguments it expects a function to be dispatched with — must be the canonical writing of what it reads, a plain map's keys in ECMAScript's order over the code-unit-sorted keys and a tagged map's pairs by the code units of each key's JSON text, because `expect` is compared without key order and nothing else would hold the file to one writing. Each gate is a function over rows, and a test of its own feeds it a row that breaks it.

It does not run Node's catalog-dispatch, literal-guard and RE2-kind gates.

### The Rust runners to come

Two Rust runners complete the set, each answering what its Node twin answers:

- **`telorun-cel`** drives `language.json` whole (both halves, deep equality of `expect`, the deviation checks and the round trip) and `catalog.json` / `types.json` through the projection, after the input gate, over host types it derives by the [rule above](#host-types) from `sdk/value-types/*.json`.
- **`telo-templating`** drives all five dialect files whole, with the `celCode` gate over the six files and the conformance conversions of [the handler set](#the-conformance-handler-set) registered from the value-type entries. Where the Rust engine lacks a code or a wording Node records, the Rust engine is fixed, never the row.
