---
"@telorun/stream": minor
---

Add `std/stream` with `Stream.Of` — a value-agnostic literal stream source that emits a declared `items` array as a `Stream`, in order. It's the telo-native way to seed a pipeline with fixed data instead of an inline `JS.Script`. The output is statically opaque today (like every Telo stream); static element-type validation is a planned evolution.
