---
"@telorun/console": minor
---

Add `Console.WriteStream` — drains a `Stream<string | Uint8Array>` to stdout. Strings use Node's native UTF-8 path; `Uint8Array` chunks pass through unchanged. No newline policy. Pairs with text producers like `RecordStream.ExtractText` and byte-producing codecs (`Ndjson.Encoder`, `Sse.Encoder`, `Octet.Encoder`) on the same input contract.
