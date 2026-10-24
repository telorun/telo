---
"@telorun/sdk": minor
"@telorun/analyzer": minor
"@telorun/kernel": minor
---

A finding about a refused value is now written in one closed vocabulary, kept as data under `sdk/issue-keywords/` (one file per keyword, `{ keyword, params }`, copied in by the root `prepare`): each finding is `{ pointer, keyword, params }` — a JSON Pointer to the value, the JSON Schema keyword violated with only the params its entry names, and anything outside the vocabulary `invalid` with none — and carries no prose. `@telorun/sdk` exports `valueIssue(pointer, keyword, params)`, `issueKeywords()`, `jsonPointerSegment` and `formatDisplayMessage(record, data)`, the one formatter of an error's display message in its own language that a `throw` step's default developer message and a transport's problem `detail` share. The vocabulary is read by the Node runtime only; the Rust kernel embeds no copy and the `Telo.Builtins` archive does not carry it.

Breaking: the `issues` an `ERR_INPUT_INVALID` / `ERR_OUTPUT_INVALID` carries for a value type that does not build at a contract boundary or in `ctx.readPlainEncoded` are `{ pointer, keyword: format, params: { format: <type name> }, code }`; `path`, `message` and `reason` leave the entries and stay in the error's message, and the value itself is the empty pointer. A schema refusal in `ctx.readPlainEncoded` carries its findings the same way — `format` for a value type that does not read, `required` with `missingProperty` (the pointer naming the property), anything else `invalid` — in place of `{ path, message }`. The analyzer's `SchemaIssue` gains `pointer`, the issue's place as a JSON Pointer.
