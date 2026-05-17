---
"@telorun/kernel": patch
---

Enrich CEL "No such key" errors with the failing access location and the actual shape at that point. When a `${{ … }}` expression like `steps.call.result.result.content[0].type` throws `No such key: content`, the kernel now appends a hint such as `at steps.call.result.result: cannot read 'content' — value is an empty object {}` (or `available keys: …` / `value is null` / `value is an array of length N`, etc.), so developers can immediately see which segment of the chain produced an unexpected shape instead of having to bisect the path by hand.
