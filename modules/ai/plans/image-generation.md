# Image generation

## Problem

Telo can send images *into* a model (multimodal `ContentPart`s on `Ai.Text` / `Ai.Agent`) but cannot get one *out*. There is no way to author "prompt → image bytes" in a manifest, and no contract a provider could implement to supply it. `Ai.Model` cannot be reused: an image model's config and call shape are different, so a shared abstract would let `Ai.Text` statically accept an image model and fail at dispatch.

## Solution

Two new kinds in `modules/ai`, one provider implementation in `modules/ai-openai` — the same abstract/operation split `Ai.Model` + `Ai.Text` already uses — plus one prerequisite in `modules/fs`.

**Prerequisite: `Fs.FileWrite` learns to write bytes.** Its `content` is `type: string` under `additionalProperties: false`, so a `Uint8Array` is rejected by the input contract before the controller runs, and nothing in the standard library converts bytes to base64. Widening `content` to accept raw bytes alongside the existing utf8/base64 string forms is a one-field change that unblocks every byte producer at once — `Image.Blank` and `Image.Overlay` sit in the same dead end today. Without it the flagship "generate, then save" flow needs a `JS.Script` hop, which the project rules call a last resort.

**`Ai.ImageModel`** (`Telo.Abstract`, `capability: Telo.Provider`) is the configured handle: credentials, model id, default options. It **declares `inputType` and `outputType`**, and providers implement **`invoke()`** — the kernel's bound entry point, not a convention method. That is what makes the contract real: the kernel binds `invoke` at its single instance-production site and AJV-checks both directions at dispatch, so `Ai.Image` hand-rolls no result validation, the shape is visible to `telo check`, and a Rust or Python provider has a manifest-declared contract to implement rather than a TypeScript interface. Each provider narrows the intents it serves through a `$defs/Intent` entry in its own schema (see below).

**`Ai.Image`** (`Telo.Definition`, `capability: Telo.Invocable`, controller `modules/ai/nodejs/src/ai-image-controller.ts`) is the buffered operation, symmetric to `Ai.Text`. It holds a model reference, shallow-merges its manifest `options` beneath per-call `inputs.options`, forwards the cancellation signal, and returns the images.

Its **config** carries the model reference, `options`, and an optional **`intent`** — `x-telo-schema-from: "model/$defs/Intent"`, so the acceptable values come from the referenced provider rather than from a fixed enum here (the pattern `modules/workflow/telo.yaml` already uses for `backend/$defs/NodeOptions`). Absent means plain text-to-image; present means this resource works from reference images. Its **per-call input** is `prompt` plus the reference `images` and an optional `mask` — the bytes are runtime data, the mode is configuration. `prompt` is required except under a `variation` intent, which some providers serve from the reference alone; `mask` is required under `inpaint`.

Its output — a named `Telo.JsonSchema` in `modules/ai` referenced by both the abstract's `outputType` and the operation's, so the two cannot drift — is `images`, always an array of `{ data, mediaType, width?, height?, details? }` with `data` as raw bytes; a request-level **`finishReason`** (`stop` | `content-filter` | `error` | `other`) covering refusals; and optional `usage` and `text`. `width`/`height` are whatever the provider reports (OpenAI echoes the requested size); `details` is its per-image extras (seed, safety flags). `usage` is a tagged quantity — `{ unit, total, details? }` — omitted entirely when the provider reports nothing. The request shapes are deliberately *not* shared: the model's input carries `intent` and the merged options, which are configuration on the operation.

`Ai.Text` and `Ai.Agent` gain two **optional** fields on their existing `usage` object, `unit` and `total`, filled by the operation from `totalTokens`. Additive — the required token triple stays, no provider or manifest changes — and it means one aggregator can total spend across text and image calls instead of `modules/ai` carrying two unrelated usage shapes.

**`AiOpenai.OpenaiImageModel`** (`extends: Ai.ImageModel`, controller `modules/ai-openai/nodejs/src/openai-image-model-controller.ts`) mirrors `OpenaiModel`'s config — `model`, `apiKey`, `baseUrl`, `options` — declares `$defs/Intent` as `edit | inpaint | variation`, and speaks the images HTTP API directly, no vendor SDK. It routes on the resolved intent: none → JSON POST to `/images/generations`; `edit` or `inpaint` → multipart POST to `/images/edits`, mask as its own part; `variation` → `/images/variations`. `snapshot()` redacts `apiKey` through the existing `redact` helper. The camelCase→snake_case option conversion currently private to `openai-model-controller.ts` moves to `modules/ai-openai/nodejs/src/openai-params.ts` so both controllers share one implementation (a pure function — each bundle inlines its own copy, which the payload rule permits).

`modules/ai/nodejs/src/types.ts` gains the matching TypeScript types, published as `@telorun/ai/types`. They are convenience typing for Node providers, not the contract — the manifest is.

**Tests.** Hermetic first: an `EchoImageModel` joins the `modules/ai/tests/__fixtures__/ai-echo.yaml` fixture library, returning fixed bytes with a test-only refusal marker (the same shape as `EchoModel`'s existing `failOn`), and declaring a `$defs/Intent` narrower than the abstract's vocabulary. `modules/ai/tests/image-smoke.yaml` covers the output shape, option merging, the missing-prompt and missing-mask errors, and the `content-filter` path with an empty array; a fixture under `__fixtures__/` asserts through `Assert.Manifest` that an intent the provider does not declare is a **static** diagnostic, not a runtime failure. `modules/ai-openai/tests/openai-live-image.yaml` is the live test, gated on `OPENAI_API_KEY` exactly as `openai-live-text.yaml` is, at `n: 1` and the cheapest size/quality. `modules/fs/tests/` gains byte-write coverage for the prerequisite.

**Docs and versioning.** New kind docs `modules/ai/docs/ai-image-model.md` (the provider contract, the walkthrough a new backend follows, including the obligation below about polling) and `modules/ai/docs/ai-image.md`, plus `modules/ai-openai/docs/ai-openai-image-model.md`; `modules/fs/docs/` updated for the bytes path; both AI module READMEs and `metadata.description` blocks widen beyond text-only wording, since the description is hub search text. A changeset for `@telorun/ai` (new exported types plus the `usage` additions); none for `ai-openai` or `fs`, whose Node packages are private build-only. Changie `Added` fragments for `ai`, `ai-openai` and `fs`. All three esbuild entry lists gain or keep their controllers. The `apps/authoring-agent` primer gains an `x-telo-binary` section: the annotation carries two authoring rules the agent would otherwise get wrong (never write a byte literal; a union with a byte branch uses `anyOf`, never `oneOf`).

## Decisions

- **Kinds live in `ai` / `ai-openai`, not a new module pair.** Image generation is driven by the same providers, keys and base URLs, and `Ai.Image` reads symmetrically with `Ai.Text`. A separate `image-generation` module would also collide confusingly with the existing `image` module (canvas + overlay, `categories: [Data]`), which is already self-described as image generation. Rejected: following the `embedding`/`embedding-openai` one-module-per-abstract precedent.
- **The contract is declared in the manifest and the method is `invoke`, not a convention method.** Naming it `generate` would put the call shape in a TypeScript interface only — invisible to `telo check`, unimplementable from Rust or Python, and forcing the operation to re-validate by hand what the kernel already validates. Binding is not capability-gated (`bindContract` binds `invoke` on any instance that has one) and contracts resolve to the nearest declaration along `extends`, so declaring on the abstract covers every provider for free. A future `Ai.ImageStream` would add a `stream()` convention method held as `dependency`, exactly mirroring `Ai.Text` / `Ai.TextStream`.
- **`model` is `use: call`,** which follows from the above — `invoke()` is a bound entry point the kernel dispatches, traces and zone-tracks. This is the `Ai.Text` treatment, not the `Embedding.Query` / `Sql.Connection` one, whose `embed()` and `query()` genuinely are plain methods.
- **One operation, not generate + edit.** Editing is prompt + reference images → image; the endpoint split is an OpenAI wire detail the controller absorbs, and providers that generate and edit in a single call map cleanly. Rejected: two kinds with tighter individual input contracts.
- **`intent` is resource config narrowed per provider, not a fixed per-call enum.** Backends split whole-image editing, inpainting, variation and style/structure conditioning differently, so inferring the mode from "images present, mask absent" would make one manifest mean different things per backend. But a fixed enum on the abstract reintroduces the very failure this plan opens by rejecting: five statically-accepted values, three implemented, a runtime `ERR_UNSUPPORTED_INTENT`. Deriving the values from the model's own `$defs` makes an unsupported intent a `telo check` error, lets a backend that does style conditioning add it without touching `ai`, and leaves the abstract fixing no vocabulary at all. Cost, accepted: intent is per-resource, so generating and editing with one model means two `Ai.Image` resources.
- **One request-level `finishReason`, not one per image.** A refusal has no bytes, so per-image reasons would force `data` to be nullable and put a null guard on every happy path. Instead `images` holds what was produced and `finishReason` reports the outcome — all four filtered gives an empty array with `content-filter`, three of four gives three images with `content-filter`. Partial and total refusal read the same, which is the price of keeping `data` non-null; the distinction is recoverable from the array length. Matches `Ai.Text`'s single `finishReason`.
- **`usage` is a tagged quantity, absent when unknown, and text converges onto it additively.** `{ unit, total, details? }` — token triples are an LLM shape, and image backends variously bill credits, compute seconds or per-image. `unit` is an open string, following the open-vocabulary rule categories use, so a new billing unit needs no analyzer release. `Ai.Text` / `Ai.Agent` gain `unit` and `total` as optional fields rather than being rewritten, because replacing their token triple would break every existing provider and consumer to buy nothing the additive form doesn't. Rejected: a `unit: "unknown"` sentinel — absent already means absent, and a sentinel makes every consumer special-case it.
- **`width`/`height` are provider-reported, never derived.** Sniffing PNG/JPEG/WebP headers inside `ai` would put generic image metadata in the wrong module, and importing `@telorun/image` to borrow it would drag a native-dependency package into the `ai` bundle. Consumers needing exact dimensions decode the bytes, which `Image.Overlay` already does.
- **Output is an always-array of raw bytes.** `n` is a real parameter (up to 10 on some models, 1 on others), so a single-image shape would be a lie half the time; this follows `Embedding.Query`'s always-array `embeddings` rather than `Image.Blank`'s single `image`. Raw bytes rather than base64 feed `Image.Overlay` and multimodal message parts directly, and `Fs.FileWrite` once the prerequisite lands.
- **The filesystem prerequisite is in scope rather than deferred.** Shipping a byte producer whose obvious first use needs a `JS.Script` hop would add a third kind to an existing dead end. Rejected: correcting the example to a base64 conversion step and declaring persistence out of scope.
- **The controller asks for base64, and fetches a URL if it gets one anyway.** `response_format: b64_json` is sent only for `dall-e-*` models — `gpt-image-1` rejects the parameter and always returns base64. A response item carrying a URL instead is fetched rather than dropped, so no path returns an empty image silently.
- **The model's own text is surfaced as optional `text`.** Chat-native image models return text interleaved with the images, and some backends rewrite the prompt before generating; dropping either makes an unexpected result unexplainable.
- **Cancellation must abort a poll loop, not just the first request.** Backends that run generation as an async job (create, then poll for the result) sit behind the same blocking `invoke()`; the contract doc states forwarding `signal` through the polling as a provider obligation, alongside the existing `Ai.Model` cancellation note.
- **No streaming in this change.** Partial-image streaming exists on some models; a later `Ai.ImageStream` mirrors the `Ai.Text` / `Ai.TextStream` split without disturbing this contract.
- **No multi-turn conversational editing.** The contract is stateless prompt + references; iterative refinement over a conversation history — a strength of the chat-native image models — is deliberately outside it, and would need a message-shaped input closer to `Ai.Agent` than to this.
- **`Ai.Image` declares a `throws:` block** (invalid input, bad model reference), following `Image.Blank` — the sibling `ai` operations predate the convention and are not retrofitted here. Contract violations are the kernel's ambient `ERR_INPUT_INVALID` / `ERR_OUTPUT_INVALID` and are never declared.

## Example after the change

```yaml
kind: Telo.Application
metadata:
  name: PosterMaker
secrets:
  openaiApiKey: { env: OPENAI_API_KEY, type: string }
imports:
  Ai: oci://ghcr.io/telorun/ai@0.15.0
  AiOpenai: oci://ghcr.io/telorun/ai-openai@0.15.0
  Fs: oci://ghcr.io/telorun/fs@0.6.0
  Run: oci://ghcr.io/telorun/run@0.14.0
targets:
  - !ref MakePoster
---
kind: AiOpenai.OpenaiImageModel
metadata: { name: Painter }
model: gpt-image-1
apiKey: !cel "secrets.openaiApiKey"
options:
  size: 1024x1024
  quality: low
---
kind: Ai.Image
metadata: { name: Draw }
model: !ref Painter
---
kind: Fs.FileWrite
metadata: { name: SavePoster }
---
kind: Run.Sequence
metadata: { name: MakePoster }
steps:
  - name: Generate
    inputs:
      prompt: A lighthouse in a storm, flat vector poster art.
    invoke: !ref Draw
  - name: Save
    inputs:
      path: ./poster.png
      content: !cel "steps.Generate.result.images[0].data"
    invoke: !ref SavePoster
```

Editing is the same kind with `intent: edit` in its config and the reference `images` (plus a `mask` for `inpaint`) on the call; the provider routes to the matching endpoint, and an intent it does not declare fails `telo check`. A manifest that must handle refusals branches on `steps.Generate.result.finishReason` before reading the bytes.
