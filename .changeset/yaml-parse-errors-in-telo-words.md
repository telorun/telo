---
"@telorun/analyzer": minor
---

A YAML parse error is now reported in Telo's words rather than the `yaml` package's: one closed set of kinds — a key written twice, an alias naming no anchor before it in its document, aliases expanding past the bound of 100, a quote never closed, a flow collection never closed, a tab as indentation, a plain value holding `: `, a line indented to match nothing beside it, an escape YAML does not define, a plain value starting with `@` or `` ` `` — each with one sentence, and every other error as `This is not valid YAML; check the indentation, quoting and brackets at this position.`, still under `MANIFEST_PARSE_FAILED` with the parser's range. The `Hint:` the colon case carried is now that kind's sentence. The Rust loader reports the same kinds in the same words at the same ranges, pinned by `templating/tag-conformance/loader-positions.json`.

An alias naming no anchor, and aliases expanding past the bound, are now `MANIFEST_PARSE_FAILED` diagnostics on their document — the unresolved alias located at the alias — where the load used to throw the `yaml` package's `ReferenceError` out of the whole parse.
