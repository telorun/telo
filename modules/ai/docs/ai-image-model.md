---
description: "Ai.ImageModel abstract: the image-generation provider contract every backend implements (invoke method, request/result shapes, intent narrowing, cancellation). Walkthrough for adding a new provider."
sidebar_label: Ai.ImageModel
---

# `Ai.ImageModel` — the provider contract

> Examples below assume this module is imported with an `imports:` entry under alias `Ai`. Kind references (`Ai.ImageModel`, `Ai.Image`, …) follow that alias — if you import the module under a different name, substitute accordingly.

`Ai.ImageModel` is a `Telo.Abstract` declared in `@telorun/ai`. Any module can declare a `Telo.Definition` that **`extends: Ai.ImageModel`** and ship as a drop-in provider for [`Ai.Image`](./ai-image.md). `@telorun/ai-openai` is the first-party implementation.

```yaml
kind: Telo.Abstract
metadata:
  name: ImageModel
capability: Telo.Provider
```

## The contract is declared, not conventional

This differs from [`Ai.Model`](./ai-model.md) in one load-bearing way. `Ai.Model` documents `invoke` / `stream` as **conventions** — the shapes live in TypeScript, and the consuming kind re-validates them by hand. `Ai.ImageModel` instead declares `inputType` and `outputType` **in the manifest**, and its method is named `invoke`, which is the kernel's bound entry point.

Three things follow, and they are the reason for the choice:

- The kernel binds `invoke` at its single instance-production site and **AJV-checks both directions at dispatch**. A provider that returns the wrong shape fails with `ERR_OUTPUT_INVALID` naming the offending field, not with a downstream `undefined`.
- `telo check` can see the shape, so mistakes surface statically.
- A provider written in **any language** implements a manifest-declared contract. A TypeScript interface would make image providers Node-only in practice, against the polyglot goal.

`@telorun/ai/types` still exports matching TypeScript types (`AiImageModelInstance`, `ImageInvokeInput`, `ImageGenerationResult`) — they are convenience typing for Node providers, not the contract.

## Runtime instance contract

A provider's controller constructs an instance exposing **one operation** plus the usual lifecycle hooks:

- **`invoke(input, ctx) → result`** — buffered generation.
- **`snapshot()`** — resource state for CEL; **must omit secrets** (use the `redact` helper).
- Optional `init` / `teardown`.

**`ImageInvokeInput`** — the argument:

| field | type | notes |
| --- | --- | --- |
| `prompt` | string (optional) | what to draw; absent only under an intent that generates from the reference alone |
| `intent` | string (optional) | what the `images` are for; absent means plain text-to-image |
| `images` | list of `{ data, mediaType }` (optional) | reference pictures the intent operates on |
| `mask` | `{ data, mediaType }` (optional) | region to repaint; present under an inpainting intent |
| `options` | object (optional) | request options, already merged by `Ai.Image` from its own and the caller's |

There is **no `signal` member**. Cancellation rides the `InvokeContext` passed as the second argument, the way every bound entry point receives it — an `AbortSignal` is not declarable data, and the input is contract-checked against a manifest schema.

`data` is **raw bytes**, never base64 — declared with `x-telo-binary: true`, so a manifest literal at that slot is a static error (bytes always arrive by reference) and a non-byte value is rejected by the contract at dispatch. That is what lets a result feed `Fs.FileWrite`, `Image.Overlay` and multimodal message parts with no conversion step.

**Result** — declared once as the shared `ImageResult` type and referenced by both this abstract and `Ai.Image`, so the two cannot drift:

| field | type | notes |
| --- | --- | --- |
| `images` | list of `{ data, mediaType, width?, height?, details? }` | one entry per produced image, in provider order |
| `finishReason` | `stop` \| `content-filter` \| `error` \| `other` | why the run ended |
| `usage` | `{ unit, total, details? }` (optional) | omit entirely when the backend reports nothing |
| `text` | string (optional) | a rewritten prompt, or commentary from a chat-native image model |

## Obligations

**Report refusals as a result, not an error.** A content refusal is a documented outcome: return `finishReason: "content-filter"` with whatever images survived. All-refused is an empty array; partly-refused is a short one. Throwing instead would make a routine outcome indistinguishable from a broken key. Everything else — a bad key, a rate limit, a malformed response — still throws.

**Report dimensions only when you know them.** `width` / `height` are optional precisely so a provider never guesses. Echoing back a requested size is honest; decoding the bytes to find out is not this layer's job, and inventing a number is worse than omitting one.

**Forward cancellation through a poll loop.** A backend that runs generation as an async job (create, then poll) sits behind the same blocking `invoke`. Forward `ctx.cancellation.signal` through the **polling**, not merely the first request — an abandoned invoke must stop polling, not keep billing. See [Invoke Cancellation](../../../kernel/docs/invoke-cancellation.md).

**Declare the intents you serve.** See below.

## Narrowing intents with `$defs/Intent`

Reference-image work splits differently per backend: whole-image editing, inpainting, variation, style and structure conditioning are separate endpoints for some providers and an explicit task-type field for others. Rather than fixing an enum on this abstract — which would statically accept modes a given backend cannot serve, and fail only at dispatch — **each provider declares its own vocabulary**:

```yaml
kind: Telo.Definition
metadata: { name: OpenaiImageModel }
capability: Telo.Provider
extends: Ai.ImageModel
schema:
  type: object
  # … model, apiKey, baseUrl, options …
  $defs:
    Intent:
      type: string
      enum: [ edit, inpaint, variation ]
```

`Ai.Image` derives its `intent` field from that (`x-telo-schema-from: "model/$defs/Intent"`), so naming a mode your backend has no route for is a **`telo check` error**, and a backend that supports style conditioning adds `style` without touching `@telorun/ai`.

A provider that serves no reference-image modes simply omits `$defs/Intent`.

**Owning the vocabulary means owning its rules.** `Ai.Image` enforces only what follows from the shape — an intent requires reference images, and no intent requires a prompt. Everything mode-specific is yours: that `inpaint` needs a mask, that `variation` can run without a prompt, that `style` takes exactly one reference. `@telorun/ai` must never name-match your intents, or a backend whose modes are called `outpaint` and `remix` would silently lose those rules.

**Validate the intent in the controller too.** `$defs/Intent` is what makes an unknown one a static error; the controller check is the backstop for a consumer whose manifest predates that declaration. Without it, an unrecognised intent is silently routed to whichever endpoint your fallback branch picks — a wrong answer rather than an error.

## Adding a provider

1. Declare a `Telo.Definition` with `capability: Telo.Provider` and `extends: <Alias>.ImageModel`. Do **not** restate `inputType` / `outputType` — they are inherited, and contracts replace rather than merge.
2. Add config fields to `schema` (model id, credentials, base URL, default options), plus `$defs/Intent` if you serve reference-image modes.
3. Implement `invoke(input, ctx)` and `snapshot()`.
4. Export the kind from your library's `exports.kinds`.

Nothing else needs to know your module exists: an author points `Ai.Image`'s `model` at your kind and every operation works unchanged.
