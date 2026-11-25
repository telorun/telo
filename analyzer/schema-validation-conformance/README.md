# Schema-validation conformance vectors

What a JSON Schema validation answers under each of Telo's named validator configurations, frozen as data: whether a value is valid, every error the validator records, the value it leaves behind, why a schema does not compile, and — for the judge's rows — the issues a refusal is reported with. Every runtime that validates a Telo schema reads these rows and answers each one identically. Editing an expected answer breaks every runner until each implementation gives it.

## The configurations

Every validator Telo runs is one of seven named configurations (`createAjv`, `@telorun/analyzer`). All are draft-07, `strict: false`, with JSON Schema's formats and Telo's, every Telo keyword, and RE2 as the pattern language:

| Configuration | Errors | Defaults | Undeclared members | A `live` value type |
|---|---|---|---|---|
| `analysis` | every one | not filled | kept | asserted |
| `analysis-verbose` | every one, each naming its schema node | not filled | kept | asserted |
| `analysis-defaults` | every one | filled, a value type's decoded first | kept | asserted |
| `primary` | the first | filled, a value type's decoded first | kept | exempt |
| `filling` | every one | filled, a value type's decoded first | kept | exempt |
| `locating` | every one, each naming its schema node | not filled | kept | exempt |
| `schema-validate` | the first | not filled | removed where `additionalProperties: false` | exempt |

## What a value is

A row's value is JSON read as JavaScript reads it: every number a double, an object's members in ECMAScript own-property order (an integer-like key before every other, ascending, then the rest as written), a schema's keywords and members iterated in that order too. An object holding the key `$telo` is a typed frame (`kernel/specs/durable-execution.md` §6): `{"$telo": "int", "value": "9007199254740993"}` is an int64, and `uint`, `double` (for `-0`), `bytes`, `google.protobuf.Timestamp`, `google.protobuf.Duration` and `Telo.Url` are written the same way. Every other object and every array is a plain container.

- An int64 or a uint is validated as the double it renders to; a kernel configuration's answer still holds the integer.
- A string's length is counted in code points.
- `const`, `enum` and `uniqueItems` compare by the value domain's equality.
- An instance value — bytes, an instant, a duration, a URL — is opaque: an object to `type`, equal only to an equal value of its own type, and holding no member for any other keyword. `x-telo-type` alone reads it.
- A schema pattern (`pattern`, a `patternProperties` key, `format: regex`) is RE2, searched unanchored. RE2 reads `.` as anything but a line feed, `\s` as `[\t\n\f\r ]`, `\S` as its complement, and `\p{…}` by Unicode general category or script name; it refuses lookaround and backreferences, and a validator flag other than `u`. A refusal reads `invalid RE2 pattern "<pattern>": <RE2's parse-error kind>`. Every pattern a schema holds is judged before it is compiled, at every place the draft-07 meta-schema declares `format: regex` — an unreferenced `definitions` entry, `not`, `if` / `then` / `else`, `dependencies` and a `patternProperties` key whose schema accepts everything included — through the meta-schema with that format alone asserted; the first refused one, in the meta-schema's order, is the compile error. A `format: regex` `default` or `const` is not judged at compile.

## Files

- `vectors/draft7.json` — the draft-07 tests of the JSON-Schema-Test-Suite, imported once and answered under `analysis`. Pinned at tag `Test-JSON-Schema-Acceptance-1.041`, commit `245a45abc90190c0bff04d97e6d2b541b4bb9f12`; the tarball `https://codeload.github.com/json-schema-org/JSON-Schema-Test-Suite/tar.gz/245a45abc90190c0bff04d97e6d2b541b4bb9f12` had SHA-256 `b60bdf58fd414e9b86c8be70b03e3b2d596b8bc3bc822a2083d86041cea4b20e` when it was read. Every test of `tests/draft7/`, `tests/draft7/optional/` and `tests/draft7/optional/format/` is a row, except those whose schema names a remote document (`refRemote.json`, `optional/cross-draft.json`, and every group naming `http://localhost:1234`): 37 tests, left out as input a row cannot carry. A row's id is `draft7/<file>/<group index>/<test index>`, its `description` the group's and the test's.
- `vectors/telo.json` — authored: each configuration, defaults and value-type defaults, undeclared-member removal, every format JSON Schema's and Telo's, `x-telo-type`, RE2 patterns and refusals, JavaScript's number rules, key order, instance values, compile errors and referenced documents.
- `vectors/unions.json` — the judge's cases: unions decided, tags read, the phrasing of a refusal, and the stand-ins a refusal excuses.

## A row

```json
{ "id": "…", "description": "…", "configuration": "analysis", "schema": {}, "documents": [], "value": {}, "standIns": {}, "expect": { "valid": true, "errors": [], "value": {}, "compileError": null, "issues": null }, "deviation": { "suite": { "valid": false } } }
```

- `id` — unique within the file.
- `description` — draft-07 rows only.
- `configuration` — one of the seven.
- `schema` — the schema compiled; `documents` — `{ id, schema }` pairs registered first, under that id. The manifest root (`telo://manifest`) is registered in every configuration.
- `value` — the value validated (above).
- `standIns` — `unions.json` only: the stand-ins in `value`, by JSON Pointer, each `{ class: computed | produced, identity?: { tag, text, repeatable } }`.
- `expect.valid` — whether the value is valid; `null` when the schema does not compile.
- `expect.errors` — each error the validator recorded, in its order: `keyword`, `instancePath`, `schemaPath`, `params`, `message`.
- `expect.value` — the value after validation, encoded as `value` is: defaults filled, members removed. Under `schema-validate` it is the validator's own view, where an int64 is the double it rendered.
- `expect.compileError` — the message a schema that does not compile is refused with, else `null`.
- `expect.issues` — `unions.json` only, else `null`: what the refusal reports, each `{ path, message }`, after the judge decides every union and excuses every finding a stand-in alone raised.
- `deviation.suite` — draft-07 rows only: the suite's `valid` where the answer differs from it. It is always a disagreement; a runner fails a row whose deviation agrees with its answer.

## Runners

- `analyzer/nodejs/tests/schema-validation-conformance.test.ts` — the Node analyzer, for every `analysis*` row, through the configuration factory and the opaque view, as the analyzer validates a value.
- `kernel/nodejs/tests/schema-validation-conformance.test.ts` — the Node kernel, for every `primary`, `filling`, `locating` and `schema-validate` row, through the kernel's BigInt view, its value-type default filler and its merge of the view's fills.
- `analyzer/rust/tests/schema_validation_conformance.rs` — the Rust analyzer, for every row of every file and every configuration, through its configuration factory, its view of the value and its value-type default filler, and — for a row's `issues` — its judge on a verbose twin of the row's instance, with the judge's reporting backstop watched.
- `kernel/rust/tests/schema_validation_conformance.rs` — the Rust kernel, for every `primary`, `filling`, `locating` and `schema-validate` row, through the validator the kernel validates with and the view it validates a value through.

Each runner pins how many rows of each file it answers, and checks every row's keys, so a row deleted or misspelled fails the run. Between them the runners answer every row; none has a skip list.

## The blind spot

Deep equality pins whatever the runtime answered when a row was recorded. A row is evidence about the JSON Schema specification only where it carries `deviation.suite`, which records that the answer differs from the suite's — `required` reading an inherited property (`__proto__`, `toString`), a format check AJV does not make, a pattern RE2 refuses. A row with no deviation was either agreed with the suite or never asked of it; an authored row is checked against nothing but the runtime that recorded it. Reading a row for a defect without first looking at its `deviation` is how a false finding is made.

There is no generator: the rows are data, recorded once and reviewed as a diff, and a runner only compares.
