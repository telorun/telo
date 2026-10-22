---
description: "Anthropic.Client: an Http.Client preset for Anthropic's API — the endpoint, a ten-minute timeout and the credential every call carries."
sidebar_label: Anthropic.Client
---

# `Anthropic.Client`

> Examples assume this module is imported under alias `Anthropic` and `http-client` under `Http`. Substitute your own aliases.

`Anthropic.Client` is the account a Claude model calls through: an `Http.Client` with Anthropic's endpoint and a timeout sized for inference already set. It extends `Http.Client`, so it fits every slot one does — above all an `Http.Request`'s `client`, which is what `Anthropic.MessagesModel` and `Anthropic.MessagesModelStream` call through.

```yaml
kind: Anthropic.Client
metadata: { name: anthropicClient }
credential:
  kind: Http.ApiKeyHeader
  header: x-api-key
  key: !cel "secrets.anthropicApiKey"
---
kind: Anthropic.MessagesModel
metadata: { name: claude }
model: claude-sonnet-4-5
request: { kind: Http.Request, client: !ref anthropicClient }
maxTokens: 4096
```

## Fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `credential` | ref | yes | Authenticates every call — an `Http.ApiKeyHeader` on `x-api-key`. Its header is marked sensitive, so the key is redacted in trace payloads. |
| `baseUrl` | string | no (`https://api.anthropic.com/v1`) | The endpoint up to its version segment, or a gateway's. |
| `timeout` | integer ≥ 1 | no (`600000`) | Milliseconds a call may take. |
| `headers` | map | no | Headers added to every call. |

## Why the timeout is ten minutes

A complete answer arrives in one response, so a buffered call must finish within the timeout — and a long answer, or one with extended thinking, takes minutes. A plain `Http.Client` defaults to 10 seconds, which ends most of them with `ERR_MODEL_TIMEOUT`. A streamed call must only start within the timeout. Set `timeout` lower to fail faster, or higher for the longest answers you allow.

Retries are the request's: put a `retry:` policy on the `Http.Request` the model calls through.

## What it publishes

`resources.<name>` reads as the `Http.Client` it is — `baseUrl`, `headers`, `timeout`, `followRedirects`. The credential is not part of the reading.
