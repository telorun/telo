---
"@telorun/sdk": minor
"@telorun/kernel": minor
"@telorun/cli": minor
---

Every boundary read outside Telo writes a CEL value in its plain encoding, never type-tagged. `@telorun/sdk` exports the writer — `toPlainJson`, `writePlainJson`, `plainScalar`, `plainMapKey` — and `plainSchemaOf`, the schema of the text an instance-typed slot is written as; each plain encoding now carries that `schema`. A timestamp is RFC 3339 text in UTC, a duration is seconds (`"5400s"`), bytes are base64url, a `uint` is its digits, NaN and ±Infinity are `"NaN"` / `"Infinity"` / `"-Infinity"`, a negative zero is `0`, and a map with int or bool keys is an object keyed by their text; a map two of whose keys share one text is refused with `ERR_PLAIN_JSON_UNWRITABLE`.

Log attributes (`json`, `pretty` and `otlp`), debug-wire payloads and CLI JSON documents (`-o json`, `telo cel eval --json`) now write a duration, a `uint` and an int-keyed map in that form, where they used to write an empty object or a `[Duration]` marker; a debug-wire payload holding a map whose keys share a text or are not CEL map keys writes it as its `[key, value]` pairs rather than failing the call it observes. `ResourceContext.readPlainEncoded(value, schema)` decodes a value that arrived from outside — a transport body — at every slot declaring a plain-encoded value type, through the walk a YAML literal is read with, and refuses text the encoding does not read with `ERR_INPUT_INVALID`, whose `data.issues` lists each refusal as `{ path, message }`.
