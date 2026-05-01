# @telorun/record-stream

## 0.3.0

### Minor Changes

- 795c117: New `record-stream` package for stream operations on structured records. First inhabitant: `RecordStream.ExtractText` projects a discriminated stream of records (`Stream<{type, ...}>`) down to a `Stream<string>` using a `discriminator` + per-variant `records` action map (`emit`, `drop`, `throw`). Format-neutral; pairs with text-aware sinks like `Console.WriteStream` and HTTP response bodies. Replaces the AI-aware projection logic that lived inside `PlainText.Encoder` — see `modules/record-stream/README.md` for usage.
- 795c117: Add `RecordStream.Tee` — fan one input stream out to two consumers. Each output sees every item from the source. Source pulls are serialized by an internal lock; items are buffered for the lagging consumer (bounded by source-stream length). Source errors propagate to both outputs on their next pull. Pairs with the chat-console example's "print + capture" pattern (`Ai.TextStream → Tee → [ExtractText → WriteStream | history-collector]`).

### Patch Changes

- Updated dependencies [b62e535]
  - @telorun/sdk@0.7.0
