---
"@telorun/record-stream": minor
---

New `record-stream` package for stream operations on structured records. First inhabitant: `RecordStream.ExtractText` projects a discriminated stream of records (`Stream<{type, ...}>`) down to a `Stream<string>` using a `discriminator` + per-variant `records` action map (`emit`, `drop`, `throw`). Format-neutral; pairs with text-aware sinks like `Console.WriteStream` and HTTP response bodies. Replaces the AI-aware projection logic that lived inside `PlainText.Encoder` — see `modules/record-stream/README.md` for usage.
