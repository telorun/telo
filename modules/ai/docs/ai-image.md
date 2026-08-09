---
description: "Ai.Image: buffered image generation and editing. Manifest fields, the intent config, invocation inputs, result shape, refusals, and saving the bytes."
sidebar_label: Ai.Image
---

# `Ai.Image`

> Examples below assume this module is imported with an `imports:` entry under alias `Ai` (and `ai-openai` as `AiOpenai`). Kind references follow those aliases — substitute if you import under different names.

`Ai.Image` is a `Telo.Invocable` that turns a prompt into pictures using any [`Ai.ImageModel`](./ai-image-model.md) implementation. It owns option-merging and input validation; the model handles the HTTP call.

```yaml
kind: Telo.Application
metadata: { name: poster-maker, version: 1.0.0 }
imports:
  Ai: oci://ghcr.io/telorun/ai@0.15.0
  AiOpenai: oci://ghcr.io/telorun/ai-openai@0.15.0
secrets:
  openaiApiKey: { env: OPENAI_API_KEY, type: string }
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
```

## Manifest fields

| field | required | notes |
| --- | --- | --- |
| `model` | yes | `!ref` to any `Ai.ImageModel` implementation |
| `intent` | no | what the reference images passed to this resource are for; omit for text-to-image |
| `options` | no | request-level defaults (size, quality, count, …); per-call `inputs.options` wins |

## Invocation

| input | notes |
| --- | --- |
| `prompt` | what to draw; required when no `intent` is configured |
| `images` | reference pictures, each `{ data, mediaType }`; required when `intent` is set, rejected when it is not |
| `mask` | `{ data, mediaType }` whose transparent region marks what to repaint |
| `options` | per-call overrides, shallow-merged over the resource's |

`Ai.Image` enforces only what follows from the shape: an intent is what says the references are *for*, so one implies the other, and with neither there is nothing to work from but a prompt. **What a particular mode needs — whether it can run without a prompt, whether it takes a mask — is the provider's rule**, because the provider owns the vocabulary. Ask your provider's docs; the OpenAI one is [here](../../ai-openai/docs/ai-openai-image-model.md).

The result is `{ images, finishReason, usage?, text? }` — see the [provider contract](./ai-image-model.md) for the full shape. `images[].data` is **raw bytes**, so it goes straight into `Fs.FileWrite`, `Image.Overlay`, or a multimodal message part.

```yaml
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

## Intent is configuration, not a per-call input

The mode lives on the resource; the bytes ride the call. That split is deliberate: `intent`'s accepted values are derived from the referenced model's `$defs/Intent` (`x-telo-schema-from`), so **an intent your backend cannot serve fails `telo check`** rather than throwing at dispatch.

The cost is that intent is fixed per resource — generating and editing with one model means two `Ai.Image` resources, which also reads better declaratively:

```yaml
kind: Ai.Image
metadata: { name: Draw }
model: !ref Painter
---
kind: Ai.Image
metadata: { name: Retouch }
model: !ref Painter
intent: edit
---
kind: Ai.Image
metadata: { name: Repaint }
model: !ref Painter
intent: inpaint
```

Then pass the references on the call:

```yaml
  - name: Edit
    inputs:
      prompt: add a storm over the water
      images:
        - data: !cel "steps.Generate.result.images[0].data"
          mediaType: !cel "steps.Generate.result.images[0].mediaType"
    invoke: !ref Retouch
```

## Refusals are results, not errors

A model that declines a prompt on content grounds returns `finishReason: "content-filter"` with whatever images survived — an empty array when everything was refused, a short one when only part was. **Check `finishReason` (or the array length) before reading `images[0]`**, or a refused generation surfaces as an index error rather than as the refusal it is.

There is deliberately no per-image reason: a refusal carries no bytes, so a per-image field would force `data` to be nullable and put a null guard on every happy path. Partial and total refusal share the reason and are told apart by how many images came back.

## Usage

`usage` is a tagged quantity — `{ unit, total, details? }` — because image backends bill in different things (tokens, credits, compute seconds, per image). `unit` is an open string; `total` is the one number a spend aggregator can sum. It is **omitted entirely** when the provider reports nothing, so absent means absent.

`Ai.Text` and `Ai.Agent` report the same `unit` / `total` pair alongside their token triple, so one consumer totals spend across text and image calls.

## Errors

| code | when |
| --- | --- |
| `ERR_INVALID_INPUT` | `prompt` missing where the intent requires it; `images` missing under an intent, or supplied without one; `mask` missing under `inpaint`; `options` not an object |
| `ERR_INVALID_REFERENCE` | `model` is not a live `Ai.ImageModel` instance |

Input and output contract violations surface as the kernel's ambient `ERR_INPUT_INVALID` / `ERR_OUTPUT_INVALID`.

## Not covered

- **Streaming.** Some models emit partial images; a future `Ai.ImageStream` would mirror the `Ai.Text` / `Ai.TextStream` split.
- **Multi-turn conversational editing.** The contract is stateless prompt + references; iterative refinement over a conversation history would need a message-shaped input closer to `Ai.Agent`.
