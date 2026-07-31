# @telorun/javascript

## 0.5.0

### Minor Changes

- 2ee3598: A resource's declared invocation contract is now enforced.

  `inputType` / `outputType` were declared all over the standard library and read almost nowhere: a declared `default:` never applied, a misspelled input, a wrong-typed value and a misread result field were all silent, and three modules of roughly forty validated anything at all — each re-deciding it for itself. Underneath was a naming collision: `inputs:` meant _a schema_ on the six `modules/run` kinds and _values_ at every call site, so the run kinds' whole declared contract was inert.

  One invariant now holds everywhere: **`inputs`/`outputs` are values; `inputType`/`outputType` are schemas.** The normative rules are in `kernel/specs/invocation-contract.md`.

  **Resolution.** A shared resolver answers "what is this target's contract" for both halves — `telo check` and the runtime — layering the instance's own declaration over the kind's. A kind's contract resolves to the **nearest declaration along `extends`** and **replaces** rather than merges: config and observed state merge because construction and reported state are additive, but a call signature is not, and merging a child's required inputs into its parent's yields a union no caller can satisfy. This also fixes multi-level chains, which previously resolved to nothing.

  A child that inherits its controller and declares its own contract must bridge it — `inputType` needs `inputs:`, `outputType` needs `result:` — because the inherited controller understands only the shape it was written for. That combination used to pass `telo check`, run, exit 0 and do nothing at all.

  **Enforcement.** The kernel binds the resolved contract to the instance at creation, so **an instance is never observable unbound**. Enforcing at a handoff would have meant enforcing at every handoff — injection, explicit resolution, scope handles, template dispatch, the chokepoint — and the dominant path is injection: a consumer reads the reference off its own config and invokes it directly. `invoke` and `provide` are bound; `run()` is parameterless and void, so a resource whose contract requires inputs is rejected statically at a run site. Defaults are filled and both directions validated on every call, skipping `x-telo-stream` properties in **both** directions.

  Violations raise the ambient `ERR_INPUT_INVALID` / `ERR_OUTPUT_INVALID` as structured errors: catchable and typo-checked by name in a `catches:` block, never counted toward a kind's own declared union. `JS.Script`, `Starlark.Script` and `Run.Choice` drop their controller-side validators, and `Run.Choice`'s duplicate `ERR_OUTPUT_INVALID` declaration goes with them; `Image.Blank`, `Image.Overlay`, `Pdf.Rasterizer` and `Pdf.FormFields` drop the input guards that duplicated their own declared bounds, keeping only what a schema cannot express (a CSS colour's validity, a PDF's decodability, a page against the document's real page count).

  **`Telo.JsonSchema` is now a kernel built-in.** Declaring a data shape stopped being optional once any kind can carry a contract: writing `inputType:` should not require an import, and a library declaring its own contract should not import a module purely to describe itself — the same reasoning that keeps the mandatory log sinks in the kernel. `modules/type` is deprecated and unchanged, so `Type.JsonSchema` and every published manifest importing it keep working; the standard library, examples and templates now write the built-in and have dropped the import.

  The six `modules/run` kinds declare `inputType:` / `outputType:` in place of the `inputs:` property map, and each result slot is annotated `x-telo-value-schema-from: outputType` so every branch is checked statically — including ones no input selects. Consumers in this repo are migrated; a manifest pinning a published `run` by digest keeps the old spelling and keeps working.

  A `Telo.JsonSchema` rule's declared `code:` now reaches a `catch` block. Rules raise an error that carries a code but not the marker a catch matches on, so `error.code` was the generic plain-failure code and every `catches:` entry naming a rule code silently never matched — the behaviour `modules/type` has always documented was never the behaviour. Contract enforcement re-raises a rule failure structurally, preserving the author's code; only a structural schema failure becomes the ambient contract code.

  CEL evaluates an integer literal to a BigInt, which a JSON Schema validator does not accept as `integer` — so with enforcement on, every computed integer reaching a declared integer input would have been rejected for a reason no author could act on. Validation runs against a view where those read as ordinary numbers while the callee still receives the original values, and `Assert.Equals` no longer throws while rendering one.

  `Type.JsonSchema` is now a controller-less `extends: Telo.JsonSchema` alias rather than a second copy of the same controller, so the deprecated module has no implementation left to drift.

  **Statically**, `telo check` now validates each call site's `inputs:` against the target's contract, rejects an unmapped contract replacement, rejects a contract-requiring resource wired where the caller cannot supply arguments, and rejects a contract naming a type that is not declared in scope — which the runtime would otherwise only discover at the first dispatch through it, and which was invisible on a KIND because `Telo.Definition` is excluded from ordinary reference validation.

  Several latent bugs surfaced and are fixed. A wrapped `invoke` dropped every argument after the first, discarding the InvokeContext — so a detached body never observed cancellation and anything holding a resource across it was never released. `base:` validation demanded `metadata` and then rejected it, making any `base:` child of `JS.Script` impossible. The canonical type-schema id carried a URI authority (`telo://<module>/<Type>`), which no JSON Schema validator can resolve, so a `$ref`-based contract was uncompilable; the internal id is now authority-free, with the authored form unchanged.

  CEL placeholder substitution — how the checker avoids judging a value it cannot know — gained the same discipline: bounds it ignored (`exclusiveMinimum`, `minLength`, `minItems`, `required`, `allOf`-inherited constraints) are now honoured, a `oneOf` / `anyOf` is resolved to the single branch a value is written against so leaves underneath are typed rather than nulled, and a finding located AT a substituted path is dropped outright — a `pattern`-constrained string cannot be satisfied by any stand-in, so the checker declines to judge it. Structural findings survive, because they are located at the container.

## 0.4.1

### Patch Changes

- adc248b: Loosen the `@telorun/sdk` peer dependency range from an exact pin to `*`.

  The sdk is a host-provided peer (the kernel supplies the single shared instance, so `Stream` and other sdk class identities stay intact for CEL's runtime type-checker). Pinning it via `workspace:*` published as an exact version, which made every sdk release fall out of range and forced a spurious major bump of all peer-dependents. Declaring the peer range as `*` (with a `workspace:*` devDependency to preserve local linking) keeps the single-instance guarantee while preventing the false major-bump cascade.

## 0.4.0

### Patch Changes

- Updated dependencies [ae0bf77]
  - @telorun/sdk@0.13.0

## 0.3.0

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

## 0.2.2

### Patch Changes

- Updated dependencies [58362c4]
  - @telorun/sdk@0.11.1

## 0.2.1

### Patch Changes

- Updated dependencies [f1c35bc]
- Updated dependencies [47f7d83]
  - @telorun/sdk@0.10.0

## 0.2.0

### Minor Changes

- b62e535: Streaming-Invocable convention, format-codec packages, and `Http.Api` `content:` map rewrite.

  **Breaking** (`@telorun/http-server`, `@telorun/ai`):

  - `Http.Api.routes[].returns[]` and `routes[].catches[]` (and the equivalent `Http.Server.notFoundHandler` lists) drop top-level `body` / `schema` in favour of a per-MIME `content:` map. Buffer-mode entries use `content[<mime>].body` / `content[<mime>].schema`; stream-mode entries use `content[<mime>].encoder` (ref to any `Codec.Encoder`). The map key is the canonical `Content-Type` — declaring `Content-Type` in `headers:` is rejected at load time. Multi-key `content:` maps are negotiated against the request's `Accept` header (RFC 9110 §12.5.1). Mismatch → `406 Not Acceptable`.
  - `mode: stream` is forbidden in `catches:` (catches fire pre-stream; no upstream iterable to feed an encoder).
  - Migration: every existing `returns: [..., body: ..., schema: ..., headers: { Content-Type: ... }]` rewrites mechanically to `returns: [..., content: { <mime>: { body, schema } }]`. In-tree manifests (`apps/registry`, `examples/*`, `tests/*`, `benchmarks/*`) migrated.
  - `Ai.TextStream`: `format` field removed; controller no longer encodes the wire — it returns `{ output: Stream<StreamPart> }`. Pair with a format-codec encoder (`Ndjson.Encoder`, `Sse.Encoder`, `PlainText.Encoder`) for HTTP responses or other byte transports. `text-stream-drain-controller.ts` removed (replaced by inline source → encoder → decoder steps).
  - `StreamPart.error` shape changed from native `Error` to `{ message, code?, data? }` so generic encoders can JSON-serialize error frames without bespoke translation.

  **New** (`@telorun/codec`, `@telorun/plain-text-codec`, `@telorun/ndjson-codec`, `@telorun/sse-codec`, `@telorun/octet-codec`):

  - `@telorun/codec` ships the `Encoder` and `Decoder` abstracts (no controllers — pure contracts).
  - Format-codec packages each carry one or both directions: `PlainText.Encoder/.Decoder` (UTF-8 collect + emit), `Ndjson.Encoder` (one JSON record per line), `Sse.Encoder` (Server-Sent Events frames), `Octet.Encoder/.Decoder` (raw bytes pass-through and collect).
  - All encoders implement `invoke({input}): Promise<{output: Stream<Uint8Array>}>` per the streaming-Invocable convention.

  **New** (`@telorun/sdk`):

  - `Stream<T>` class wrapping `AsyncIterable<T>`. Producers wrap their iterables in `new Stream(...)` so the value's constructor is recognized by CEL's runtime type-checker (which rejects unrecognized constructors like `AsyncGenerator` and Node `Readable`). The analyzer registers `Stream` as a CEL object type.

  **Annotation** (`@telorun/kernel`, `@telorun/analyzer`):

  - `x-telo-stream: true` schema annotation on input/output properties marks them as carrying a `Stream<T>`. CEL passes the value through by reference; analyzer's chain validator rejects `.field` / `[index]` access past a stream-marked property. Convention: streaming Invocables put the stream on `input` (inputs) and `output` (result).
  - `Self.<Abstract>` magic alias auto-registered for every Telo.Library/Application — lets concrete kinds in the same library use `extends: Self.<Abstract>` without a self-import that would loop the loader.
  - Analyzer's `buildReferenceFieldMap`, `resolveFieldValues`, `extractInlinesAtPath`, and `injectAtPath` (Phase 5) now recurse into `additionalProperties` via a `{}` path-segment marker. Required for refs nested inside open-keyed maps like `content[<mime>].encoder`.
  - `isInlineResource` widened: bare-kind refs (`{kind: X}` with no `name` and no extra config) are now treated as inline-singleton definitions and Phase 2 extracts them as fresh stateless resources. Previously `{kind: X}` raised `INVALID_REFERENCE` (treated as a malformed named ref). This matches the runtime-side `resolveChildren` semantics already documented for `Run.Throw`-style stateless inlines, and lets `encoder: {kind: Ndjson.Encoder}` work without boilerplate. Manifests that had `{kind: X}` with the (broken) intent of resolving to an existing named resource will now silently extract a fresh resource — extremely unlikely in practice (those refs were already failing analysis), but worth flagging for downstream consumers.

  **Behaviour changes worth flagging** (`@telorun/http-server`):

  - **Single-key `content:` maps now do `Accept` negotiation.** A route declaring only `content: { application/json: ... }` returns `406 Not Acceptable` for `Accept: image/png` — RFC 9110 §15.5.7 compliant. Pre-PR, the legacy top-level `body:` shape ignored `Accept` entirely. To preserve "always send" behaviour, declare `*/*` as an explicit key.
  - **Accept matching ignores media-type parameters** beyond the first `;`. `Accept: text/plain; charset=ascii` matches `content: { 'text/plain; charset=utf-8': ... }`. Q-values are still parsed for ranking; only the matching predicate ignores params. Authors needing parameter-level preference must declare distinct keys per parameter combo.
  - **Load-time validators reject misconfigured `content:` shapes.** `validateContentEntryShape` rejects `body+encoder` together (mutually exclusive), missing `encoder` under `mode: stream`, `body` under `mode: stream`, and `encoder` under `mode: buffer`. Previously some of these slipped through to runtime where they manifested as 500-on-negotiation.
  - **Mid-stream `pipeline()` failures emit `Http.Api.streamFailed` events.** Once `reply.hijack()` runs, mid-stream errors (encoder throws, broken pipe) bypass `catches:` by design (response is committed). They now emit a structured event with `path`, `method`, `status`, `mime`, and the error so operators can observe failures that would otherwise be silent.

  **Other** (`@telorun/http-client`, `@telorun/javascript`):

  - `HttpClient.Request` `mode: stream` returns `{ output: Stream<Uint8Array> }` instead of a bare `Readable` — fits the streaming-Invocable convention, pairs with `Octet.Encoder` for HTTP pass-through.
  - `JS.Script` injects `Stream` into every script's scope (via the second function argument, destructured at the top of the wrapper). User code can `new Stream(asyncGen)` directly.

  **Tests**:

  - New Layer 1 hermetic streaming-contract test (`modules/ai/tests/text-stream-streaming-contract.yaml`) — three sub-targets, byte-exact NDJSON / SSE / PlainText.
  - New Layer 2 live OpenAI streaming smoke (`modules/ai-openai/tests/openai-live-text-stream.yaml`) — env-gated; exercises `Ai.TextStream → Ndjson.Encoder → PlainText.Decoder` against the real provider.
  - New http-server integration test (`modules/http-server/tests/text-stream-via-http.yaml`) — exercises three single-format routes plus a four-format negotiated route with five Accept variants.

### Patch Changes

- Updated dependencies [b62e535]
  - @telorun/sdk@0.7.0

## 0.1.13

### Patch Changes

- Updated dependencies [dccd3a6]
- Updated dependencies [2e0ad31]
  - @telorun/sdk@0.6.0

## 0.1.12

### Patch Changes

- Updated dependencies [f76dd0f]
- Updated dependencies [fc4a562]
  - @telorun/sdk@0.5.0

## 0.1.11

### Patch Changes

- Updated dependencies [3c4ac58]
  - @telorun/sdk@0.3.2

## 0.1.10

### Patch Changes

- Updated dependencies [353d7e5]
  - @telorun/sdk@0.3.0

## 0.1.9

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.8

## 0.1.8

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.7

## 0.1.7

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.6

## 0.1.6

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.5

## 0.1.5

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.4

## 0.1.4

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.3

## 0.1.3

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/sdk@0.2.2
