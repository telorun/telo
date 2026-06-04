---
"@telorun/http-server": minor
---

Support binary request bodies. An `Http.Server` `contentTypeParsers` entry may declare `stream: true` to deliver bodies of that content type to the handler as a raw `Stream<Uint8Array>` — no buffering, no parsing. A route opts in by marking its `request.schema.body` with `x-telo-stream: true`, which skips AJV on the body and surfaces `request.body` as a stream in handler CEL (member access past it is a static error). A content type on one server is either streamed or parsed, never both.
