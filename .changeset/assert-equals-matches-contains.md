---
"@telorun/assert": minor
---

Three new value-level assertion kinds — concise alternatives to `Assert.Schema { properties: { x: { const: ... } } }` for trivial value checks.

- **`Assert.Equals`** — deep equality between `actual` and `expected` (primitives, plain objects, arrays). One-line replacement for the const-via-schema pattern.
- **`Assert.Matches`** — JS regex match on a string `actual` (`pattern` source + optional `flags`). Replaces `pattern:` schema usage.
- **`Assert.Contains`** — substring check when `actual` is a string, or deep-equality membership when `actual` is an array.

All three are `Telo.Runnable`. Values come through step `inputs:` so CEL refs (`${{ steps.X.result.y }}`, `${{ error.code }}`) are evaluated by `Run.Sequence` automatically. Failure throws `InvokeError` with code `ERR_ASSERTION_FAILED`. `Assert.Schema` stays for actual structural validation.
