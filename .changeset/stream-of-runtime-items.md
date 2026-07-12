---
"@telorun/stream": minor
---

`Stream.Of` now accepts `items` as invoke inputs, not just as a static resource
field. The declared `items` become a default that runtime invoke inputs
override; when neither is present the stream is empty. This lets a handler emit
a stream from a value computed at request time — e.g. a read-through cache whose
`mode: stream` route must return a stream on every branch, streaming a stored
value on the cache hit — without dropping to an inline `JS.Script`. The `items`
resource field is now optional (previously required).
