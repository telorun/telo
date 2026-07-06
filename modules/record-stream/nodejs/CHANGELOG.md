# @telorun/record-stream

## 0.7.0

### Minor Changes

- 06c675b: Add the `RecordStream.Journal` family — an in-memory, keyed, offset-addressable replay buffer that makes a **detached** stream **resumable**. `RecordStream.Journal` (Provider) is the buffer store (monotonic 1-based ids per key); `RecordStream.JournalSink` (`{ key, input }`) drains a stream into it, finishing the key on completion or failing it on error (recording the error for readers, then rethrowing — never swallowed); `RecordStream.JournalSource` (`{ key, fromId? }` → `{ output }` of `{ id, data }`) replays entries past `fromId` and then tails live until the key completes. Together they back a resumable transport (start work detached under a `turnId`, hand the client that id, let it reconnect via an SSE `Last-Event-ID`) that `OnComplete`/`Tee` — which observe a single live consumption — cannot.

## 0.6.0

### Minor Changes

- 5dd71ee: Add `RecordStream.OnComplete` — a stream passthrough that fires a `handler` Invocable once, after the input completes, with `{ records, context }` (the full list of items observed plus opaque caller data). Forwards every item live to `output`; the handler is skipped on input error or early cancellation. Closes the persist-while-streaming loop (stream an AI/agent response to a client while persisting the turn at end-of-stream) that a bare `Tee` can't, since its second branch has no autonomous driver inside a stream handler.

## 0.5.1

### Patch Changes

- adc248b: Loosen the `@telorun/sdk` peer dependency range from an exact pin to `*`.

  The sdk is a host-provided peer (the kernel supplies the single shared instance, so `Stream` and other sdk class identities stay intact for CEL's runtime type-checker). Pinning it via `workspace:*` published as an exact version, which made every sdk release fall out of range and forced a spurious major bump of all peer-dependents. Declaring the peer range as `*` (with a `workspace:*` devDependency to preserve local linking) keeps the single-instance guarantee while preventing the false major-bump cascade.

## 0.5.0

### Patch Changes

- Updated dependencies [ae0bf77]
  - @telorun/sdk@0.13.0

## 0.4.0

### Patch Changes

- be79957: Move `@telorun/sdk` to `peerDependencies` across the kernel, analyzer, templating, and every module.

  The SDK carries the `Stream` class registered with `@marcbachmann/cel-js` for stream-typed CEL values. cel-js identifies object types by constructor identity, so a second copy of `@telorun/sdk` in the install tree silently breaks streaming-typed evaluations with `Unsupported type: Stream`. The contract was previously enforced with three layered mechanisms (a generated `dist/generated/runtime-deps.json` driving install-root `dependencies`, `overrides` + `pnpm.overrides` blocks, and a `globalThis`-keyed singleton in `stream.ts`); the build artifact silently degraded when the kernel was run without a build step, defeating the layering.

  The new shape:

  - Every package that imports `@telorun/sdk` declares it as a `peerDependency`. Consumers (the kernel's install root, the CLI, apps) provide a single copy and `peerDependencies` cause npm/pnpm to resolve every transitive import to it.
  - The kernel's `NpmControllerLoader` no longer reads `runtime-deps.json`; the realm-collapse name list is a hardcoded constant (`REALM_COLLAPSE_NAMES = ["@telorun/sdk"]`) in `npm-loader.ts`. The install-root `package.json` it writes drops the `overrides` and `pnpm.overrides` blocks — peer-dep resolution makes them redundant.
  - `scripts/generate-runtime-deps.mjs` and the generated artifact are removed; `scripts/prepack-bake-overrides.mjs` no longer chains the runtime-deps regeneration.
  - The `globalThis` singleton in `sdk/nodejs/src/stream.ts` is **kept** as a safety net for environments that still end up with mismatched SDK copies (e.g. a controller install from a tarball that predates this change).

  Consumers installing `@telorun/kernel` or any module directly must now ensure `@telorun/sdk` is present in their dependency tree. The kernel already lists it via the install root for any manifest it boots, so kernel-driven usage is unaffected.

- Updated dependencies [849f57a]
- Updated dependencies [be79957]
  - @telorun/sdk@0.12.0

## 0.3.2

### Patch Changes

- Updated dependencies [58362c4]
  - @telorun/sdk@0.11.1

## 0.3.1

### Patch Changes

- Updated dependencies [f1c35bc]
- Updated dependencies [47f7d83]
  - @telorun/sdk@0.10.0

## 0.3.0

### Minor Changes

- 795c117: New `record-stream` package for stream operations on structured records. First inhabitant: `RecordStream.ExtractText` projects a discriminated stream of records (`Stream<{type, ...}>`) down to a `Stream<string>` using a `discriminator` + per-variant `records` action map (`emit`, `drop`, `throw`). Format-neutral; pairs with text-aware sinks like `Console.WriteStream` and HTTP response bodies. Replaces the AI-aware projection logic that lived inside `PlainText.Encoder` — see `modules/record-stream/README.md` for usage.
- 795c117: Add `RecordStream.Tee` — fan one input stream out to two consumers. Each output sees every item from the source. Source pulls are serialized by an internal lock; items are buffered for the lagging consumer (bounded by source-stream length). Source errors propagate to both outputs on their next pull. Pairs with the chat-console example's "print + capture" pattern (`Ai.TextStream → Tee → [ExtractText → WriteStream | history-collector]`).

### Patch Changes

- Updated dependencies [b62e535]
  - @telorun/sdk@0.7.0
