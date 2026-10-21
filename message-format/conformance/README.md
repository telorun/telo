# Message core vectors

These vectors are the language-neutral contract of the message core. Every core runs every row and must give the recorded answer: `@telorun/message-format` through `nodejs/conformance/vector-runner.ts`, and `telorun-message-format` through `rust/tests/conformance.rs`. A core that disagrees with a row is wrong. To fix a row itself, change the row and say so in review.

## Value encoding

A value is typed, so a vector says which host value it means:
- `{ "string": "…" }`
- `{ "int": "-9223372036854775808" }` (int64, decimal text)
- `{ "uint": "18446744073709551615" }` (uint64)
- `{ "double": "1.5" }` (text read by `Number` / `str::parse::<f64>`; `"NaN"`, `"Infinity"` and `"-Infinity"` included)

A Node core takes an `int` or a `uint` as a `bigint` and a `double` as a `number`.

## Files

| File | Rows | Each row |
| --- | --- | --- |
| `patterns.json` | `rows` | `source` → `pattern` + `canonical`, which must read back to the same pattern, or `problem` |
| `messages.json` | `rows` | `read` (`message` or `text`), `data` → the model (`message` or `text`) + `identity` + `variables`, or `problems` |
| `numbers.json` | `rows` | `lang`, `value` → `text` + `category`, or `refusal` (both `formatNumber` and `pluralCategory` refuse it) |
| `format.json` | `rows` | `lang`, `message` (data that reads), `values` → `output` or `error` |
| `checks.json` | `categories` | `lang` → `categories` |
| | `categoryProblems` | `lang`, `message` → `problems` |
| | `unknownVariables` | `source`, `translation` → `problems` |
| `lookup.json` | `chains` | `tag` → `chain` |
| | `lookups` | `requested`, `available` → `result` (`null` for none) |
| `mf2-working-group/cases.json` | `rows` | see below |

A problem is `{ code, message, path, range }`. `range` is `{ start, end }` in UTF-16 code units, or `null`. An error is `{ code, message }`.

## The MF2 working group's cases

`mf2-working-group/cases.json` takes every case of the working group's `syntax.json` and `syntax-errors.json`, at the commit its `source` names. Each case keeps its `src`, `locale` and `params`, and records the working group's own expectation under `mf2`. The profile's answer is one of:
- `output`, when the message reads and formats;
- `error`, when it reads and formatting refuses;
- `problem`, the first fault, when it does not read.

A row where the profile parts from MF2 says why in `deviation`. Three reasons occur:
- **The case is outside the profile.** MF2 reads it (a literal, a function, markup, `\|`), and the profile refuses it.
- **An unbound variable.** MF2 formats a fallback; the profile refuses to format.
- **A leading `.`.** It is text in the `pattern` production the profile reads, and MF2 reads it as opening a complex message.

Every syntax error MF2 reports is a refusal here. These cases are Unicode's, under the Unicode License V3 in `mf2-working-group/LICENSE`.

## CLDR samples

A row file does not hold the samples. Each runner reads `message-format/cldr/plurals.json` and expands every sample of every locale's rules: each item after `@integer` / `@decimal`; `a~b` as every value from `a` to `b` at the precision `a` is written with; `…` as nothing. Each sample must select the category whose rule lists it. Samples are read as UTS #35 writes them, `1c6` included (`pluralCategoryOfDecimal`).

## Counts

Both runners pin each set's row count and the expanded sample count (12 396), so a row that goes missing fails.
