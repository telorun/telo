---
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/sdk": patch
---

Close three `telo check` gaps and make declared integers CEL integers on the way in

- `inputs` inside a step body is typed from the resource's resolved input
  contract, so `inputs.<typo>` is `CEL_UNKNOWN_FIELD` — including in a handler
  declared inline in a route, whose open `inputs` view no longer wins over the
  contract. Open only where no `inputType` is declared.
- A handler with no `outputType` whose `outputs:` map carries
  `x-telo-value-schema-from: outputType` is typed by that map's keys, so
  `result.<typo>` in a route's `returns:` (and `steps.<name>.result.<typo>` after
  a step invoking it) is reported.
- A pure `value:` step's computed result is typed by the scalar its expression
  checks to, so `steps.a.result + steps.b.result` over a `double` and an `int` is
  `CEL_TYPE_ERROR` rather than a dispatch failure.
- A value an input contract declares `integer` is an int64 wherever the resource
  evaluates CEL over it; controllers still receive arguments as the call site
  produced them. `ctx.readPlainEncoded` also normalizes declared scalars, so a
  transport's declared `integer` request field reaches CEL as an int.
