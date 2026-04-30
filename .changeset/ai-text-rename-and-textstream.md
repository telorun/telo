---
---

`@telorun/ai`: hard-cut rename `Ai.Completion` → `Ai.Text` and add `Ai.TextStream` (chunked counterpart driving `model.stream()`, returns `{ output: Stream<StreamPart> }` per the streaming-Invocable convention; pipe through a format-codec encoder for HTTP responses or other byte transports). Empty changeset — no version bump on `@telorun/ai` per project decision; the rename will ship as part of a later release.
