# @telorun/stream

## 0.4.0

### Minor Changes

- b5a325f: `Stream.Of` now accepts `items` as invoke inputs, not just as a static resource
  field. The declared `items` become a default that runtime invoke inputs
  override; when neither is present the stream is empty. This lets a handler emit
  a stream from a value computed at request time — e.g. a read-through cache whose
  `mode: stream` route must return a stream on every branch, streaming a stored
  value on the cache hit — without dropping to an inline `JS.Script`. The `items`
  resource field is now optional (previously required).

## 0.3.0

### Minor Changes

- 5dd71ee: Add `Stream.Collect` — a terminal stream sink, the inverse of `Stream.Of`. Consumes a `Stream` to completion and returns every item as `items` (an array), in order. Draining drives the producer's side effects (so it runs an upstream `Ai.AgentStream` turn or pipeline) and materializes the finite stream so a caller can inspect, assert, or aggregate it in CEL — replacing a hand-rolled `JS.Script` drain. Buffered, bounded by the stream's length.

## 0.2.0

### Minor Changes

- 030bfdd: Add `std/stream` with `Stream.Of` — a value-agnostic literal stream source that emits a declared `items` array as a `Stream`, in order. It's the telo-native way to seed a pipeline with fixed data instead of an inline `JS.Script`. The output is statically opaque today (like every Telo stream); static element-type validation is a planned evolution.
