---
description: "OpenAI.ImageModel: OpenAI-compatible provider for Ai.ImageModel. Routes generation, edit, inpaint and variation against the images HTTP API through an injected Http.Request (no vendor SDK). Schema, options, intents, refusals."
sidebar_label: OpenAI.ImageModel
---

# `OpenAI.ImageModel`

> Examples below assume this module is imported with an `imports:` entry under alias `OpenAI` (and `ai` as `Ai`). Kind references follow those aliases — substitute if you import under different names.

OpenAI-compatible provider for the [`Ai.ImageModel`](../../ai/docs/ai-image-model.md) abstract. A **`Telo.Provider`** — a configured image client referenced by [`Ai.Image`](../../ai/docs/ai-image.md), never invoked directly as a target or step. Calls the OpenAI images HTTP API through the referenced `Http.Request` — no vendor SDK — so the same controller serves OpenAI and every OpenAI-compatible endpoint via the client's `baseUrl`.

```yaml
kind: Telo.Application
metadata: { name: poster-maker, version: 1.0.0 }
imports:
  Ai: oci://ghcr.io/telorun/ai@0.18.0
  OpenAI: oci://ghcr.io/telorun/openai@0.2.0
  Http: oci://ghcr.io/telorun/http-client@0.22.0
secrets:
  openaiApiKey: { env: OPENAI_API_KEY, type: string }
---
kind: Http.BearerToken
metadata: { name: openaiKey }
token: !cel "secrets.openaiApiKey"
---
kind: Http.Client
metadata: { name: openaiClient }
baseUrl: https://api.openai.com/v1
credential: !ref openaiKey
---
kind: Http.Request
metadata: { name: openaiRequest }
client: !ref openaiClient
---
kind: OpenAI.ImageModel
metadata: { name: Painter }
model: gpt-image-1
request: !ref openaiRequest
options:
  size: 1024x1024
  quality: low
---
kind: Ai.Image
metadata: { name: Draw }
model: !ref Painter
```

## Schema

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `model` | string | yes | Image model identifier (e.g. `gpt-image-1`, `dall-e-3`, `dall-e-2`). |
| `request` | `!ref` | yes | The `Http.Request` every call goes through. Its client carries the base URL (`https://api.openai.com/v1`, Azure, a gateway) and the credential. |
| `options` | object | no | camelCase image request params (`size`, `quality`, `n`, `outputFormat`, `background`, …), normalized to snake_case. Merged beneath `Ai.Image`'s options and its per-call inputs. |

Nothing here holds a key: auth is the client's credential, and the 401 re-acquire-and-retry `http-client` owns is inherited. A non-2xx answer that is not a content refusal raises `ERR_OPENAI_REQUEST_FAILED` with the endpoint's own message.

## Endpoint routing

The configured intent selects the endpoint. `$defs/Intent` declares `edit | inpaint | variation`, so `Ai.Image` rejects anything else at `telo check` time rather than at dispatch.

| `intent` | request |
| --- | --- |
| (omitted) | `POST /images/generations` — JSON body |
| `edit`, `inpaint` | `POST /images/edits` — multipart; the mask is its own part |
| `variation` | `POST /images/variations` — multipart; the prompt is not sent |

A single reference goes on the `image` field; several go on `image[]`, which only the multi-reference models accept. The multipart form is framed as bytes and sent through the same request under the boundary-bearing content type — a byte body like any other to `Http.Request`, and a replayable one, so the credential retry applies to an edit as it does to a generation.

Per-mode requirements are this provider's, not `Ai.Image`'s: `inpaint` requires a `mask`, `edit` requires a `prompt`, and `variation` needs neither. An intent outside the declared set raises `ERR_INVALID_INPUT` rather than falling through to `/images/edits` — the backstop for a manifest that predates `$defs/Intent`.

## Response format

`response_format: b64_json` is sent **only for `dall-e-*` models**: `gpt-image-1` rejects the parameter outright and always answers with base64. If a response item nonetheless carries a `url` (a gateway, or a model that ignores the parameter), the controller **fetches the bytes** rather than returning an image-shaped hole.

## Dimensions and usage

`width` / `height` are read back from the requested `size` when it pins one (`1024x1024`), and omitted otherwise (`auto`, or no size at all). Nothing is decoded from the bytes — this controller has no image library, and guessing would be worse than omitting.

`gpt-image-1` reports token usage, normalized to `{ unit: "tokens", total, details }` with the input/output split in `details`. The dall-e models report nothing, so `usage` is omitted entirely.

## Refusals

A content refusal (`moderation_blocked`, `content_policy_violation`, `content_filter`) comes back as `finishReason: "content-filter"` with an empty `images` array and **the provider's explanation in `text`** — a documented outcome of the contract, not an error, and not one that discards why. **Every other non-OK response throws**, carrying the provider's own message. Check `finishReason` before reading `images[0]`.

## Cancellation

The abort signal from the `InvokeContext` is forwarded to the generation request and to any URL download that follows it.
