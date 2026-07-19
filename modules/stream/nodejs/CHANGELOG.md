# @telorun/stream

## 0.4.1

### Patch Changes

- 8af345f: The `Telo.Definition` schema is now the sole resource-config contract.

  A controller module's exports become the controller instance verbatim, so an
  `export const schema` silently won over the manifest's `schema:`. The analyzer
  never loads controllers, so those overrides were invisible to `telo check` and
  to the editor, could not be pre-compiled by the validator warm (recompiling on
  every boot, and failing to persist on a read-only image), and were free to drift
  from the manifest they shadowed.

  `ControllerInstance.schema` is removed, and the kernel now validates every
  resource against its definition's schema. All 35 controller-exported schemas are
  gone: 26 were `additionalProperties: true` catch-alls that merely _disabled_ the
  manifest's stricter validation, and 9 kept their TypeBox for `Static<typeof …>`
  typing but no longer export it.

  Two manifests had already drifted and are corrected:

  - `S3.Bucket` was missing `accessKeyId` / `secretAccessKey` entirely, though its
    controller required both. They are now declared (and required) in the manifest.
  - `Assert.ModuleContext` was missing `resources` / `variables` / `secrets`.

  Controller authors: declare config in `telo.yaml`, not in code. An
  `export const schema` is now inert.

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
