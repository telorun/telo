---
description: "OpenAI.Client: an Http.Client preset for OpenAI and OpenAI-compatible APIs — the endpoint, a ten-minute timeout and an optional credential."
sidebar_label: OpenAI.Client
---

# `OpenAI.Client`

> Examples assume this module is imported under alias `OpenAI` and `http-client` under `Http`. Substitute your own aliases.

`OpenAI.Client` is the account every OpenAI kind calls through: an `Http.Client` with OpenAI's endpoint and a timeout sized for inference already set. It extends `Http.Client`, so it fits every slot one does — above all an `Http.Request`'s `client`, which is what the chat, responses, image and embedding kinds call through.

```yaml
kind: OpenAI.Client
metadata: { name: openaiClient }
credential:
  kind: Http.BearerToken
  token: !cel "secrets.openaiApiKey"
---
kind: OpenAI.ChatModel
metadata: { name: gpt }
model: gpt-4o-mini
request: { kind: Http.Request, client: !ref openaiClient }
```

A self-hosted OpenAI-compatible server is the same kind with its own `baseUrl` and, when it asks for no key, no credential:

```yaml
kind: OpenAI.Client
metadata: { name: localClient }
baseUrl: http://localhost:11434/v1
```

## Fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `credential` | ref | no | Authenticates every call — an `Http.BearerToken` holding the API key. Its header is marked sensitive, so the key is redacted in trace payloads. |
| `baseUrl` | string | no (`https://api.openai.com/v1`) | The endpoint — OpenAI's, Azure's, a gateway's or a self-hosted server's. |
| `timeout` | integer ≥ 1 | no (`600000`) | Milliseconds a call may take. |
| `headers` | map | no | Headers added to every call (an organization or project id, a gateway's own). |

## Why the timeout is ten minutes

A complete answer or a generated image arrives in one response, so a buffered call must finish within the timeout — and a long answer, a reasoning model or a local model on modest hardware takes minutes. A plain `Http.Client` defaults to 10 seconds, which ends most of them with `ERR_MODEL_TIMEOUT`. A streamed call must only start within the timeout. Set `timeout` lower to fail faster, or higher for the slowest calls you allow.

Retries are the request's: put a `retry:` policy on the `Http.Request` the model calls through.

## What it publishes

`resources.<name>` reads as the `Http.Client` it is — `baseUrl`, `headers`, `timeout`, `followRedirects`. The credential is not part of the reading.
