# HTTP Client

Outgoing HTTP calls for Telo. Language- and engine-neutral request/response contract, with shared `Http.Client` defaults and per-call `Http.Request` overrides.

## Why use this

- **Engine-neutral contract** — `fetch`, `reqwest`, or anything else; the same manifest serializes input and deserializes output the same way.
- **Shared client defaults** — `Http.Client` defines base URL, headers, timeout, and redirect behaviour once; `Http.Request` overrides per call.
- **Network vs. HTTP errors** — 4xx/5xx return a normal response object; only true network failures throw a structured `NetworkError`.
- **JSON-aware** — `content-type: application/json` request bodies are serialized; JSON responses are parsed automatically.
- **Buffer or stream** — pick `mode: stream` to receive a readable stream without buffering the response body.
- **Built-in retries** — `retries: N` retries on network errors only, leaving HTTP responses to manifest logic.
- **Authentication on the client** — attach an `Http.Credential` and every request through the client is authenticated, with one automatic retry when the server rejects it.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Http.Client` | Long-lived client carrying base URL, default headers, timeout, redirect policy, and an optional credential. |
| `Http.Credential` | Abstract: given the request about to be sent, return the headers or query parameters to merge into it. |
| `Http.BearerToken` | A fixed token in the `Authorization` header — the scheme most APIs accept. |
| `Http.ApiKeyHeader` | A fixed key in a header the service names (`x-api-key` and its equivalents). |
| `Http.QueryKey` | A fixed key in a query parameter, for services that offer only that. |
| `Http.Request` | Per-call HTTP request invocable; references an `Http.Client` for shared defaults. |

## Authenticating requests

`Http.Credential` is a contract. Three static implementations ship here for the
cases where the material is a value you already hold; `OAuthClient.Credential`
covers OAuth 2.0, and a scheme that signs the request (HMAC, SigV4) implements
the same contract. Attach one to a client and the calls through it need no
header wiring:

```yaml
kind: Http.BearerToken
metadata: { name: apiToken }
token: !cel "secrets.apiToken"
---
kind: Http.ApiKeyHeader
metadata: { name: anthropicKey }
header: x-api-key
key: !cel "secrets.anthropicKey"
---
kind: Http.QueryKey
metadata: { name: studioKey }
parameter: key
key: !cel "secrets.googleAiKey"
```

Use these rather than an `apiKey` field on whatever kind is making the call: an
`apiKey` beside a `credential` reference is two ways to say one thing, and the
`401` re-acquire-and-retry below is inherited only by the credential path.
Material that resolves to nothing is refused at the credential
(`ERR_INVALID_CREDENTIAL`) rather than sent and answered `401` — a failure
reported one indirection from the line that has to change.

```yaml
kind: Http.Client
metadata: { name: Sheets }
baseUrl: https://sheets.googleapis.com/v4
credential: !ref GoogleAuth
```

The credential is consulted once per request and receives the request about to be
sent — method, URL, headers, query — so a scheme that signs the request, rather
than just adding a token, satisfies the same contract. What it returns overrides
the client's default headers and query parameters, and is overridden in turn by
the individual request's own: an explicit per-call `Authorization` is never
silently replaced.

A credential's returned headers and query are marked `x-telo-sensitive`, so the
material is carried as `[redacted]` in trace payloads and on the debug wire
rather than verbatim — which matters because a credential is a dispatched
invocable, and invoke outputs ride that wire on every call under `--inspect`.

A response of `401` re-invokes the credential with `forceRefresh: true` and
retries the call **once**; a second rejection propagates. This lives here rather
than in each credential kind, because a header is computed before the call and
cannot react to a token the server has just rejected — so every credential type
inherits the behaviour. What forcing means is the implementation's own: a token
credential bypasses its cache and renews, a static API key returns the same header
unchanged.

Implementing one is a plain `Telo.Invocable` extending the abstract:

```yaml
kind: Telo.Definition
metadata: { name: ApiKey }
capability: Telo.Invocable
extends: Http.Credential
controllers: [ ... ]
```

## Example

```yaml
kind: Telo.Application
metadata: { name: fetcher, version: 1.0.0 }
imports:
  Http: oci://ghcr.io/telorun/http-client@<version>
targets: [ !ref GetUser ]
---
kind: Http.Client
metadata: { name: GitHub }
baseUrl: https://api.github.com
headers:
  accept: application/vnd.github+json
timeout: 5000
---
kind: Http.Request
metadata: { name: GetUser }
client: !ref GitHub
inputs:
  url: /users/octocat
  method: GET
```

## Implementation Contract

### 1. Request contract (input serialization)

When the Telo kernel executes an `Http.Request`, the underlying module must construct the outgoing request according to strict rules.

- **Headers normalization:** all header keys provided in the manifest MUST be normalized to lowercase before sending.
- **Query parameters:** if `query` is provided as an object, the module MUST safely URL-encode the keys and values and append them to the `url`.
- **Payload serialization (body):**
  - If the `headers` include `content-type: application/json` (the default when `body` is an object), the module MUST serialize the `body` to a JSON string.
  - If the `content-type` is `application/x-www-form-urlencoded`, the module MUST serialize the object into a URL-encoded string.
  - **Raw bytes** (`Telo.Bytes`) and a **byte stream** (`Telo.Stream of Telo.Bytes`) MUST be sent verbatim, never serialized. They default the content type to `application/octet-stream` where the request declares none.
  - A **string** body is sent as-is unless `bodyEncoding: base64`, which decodes it to bytes first — the escape hatch for a payload that reaches the manifest as text.

**A byte-stream body is single-shot.** It has been consumed by the first attempt, so any re-send — a retry, or the credential's 401 re-acquire — MUST raise `ERR_HTTP_BODY_NOT_REPLAYABLE` rather than transmit an empty payload, which a server would answer `200` and which would look like a successful upload. Chunk a large upload (see `Stream.Chunk`) so each request carries replayable bytes.

### 2. Response contract (output deserialization)

The output of an `Http.Request` becomes available to the Telo engine (e.g. for mapping via CEL expressions). The underlying engine MUST return a standardized Telo Response Object.

```json
{
  "status": 200,
  "headers": {
    "content-type": "application/json",
    "x-ratelimit-remaining": "99"
  },
  "body": {
    "userId": 1,
    "title": "Hello World"
  }
}
```

- **Header normalization:** the module MUST normalize all incoming response headers to lowercase keys.
- **Body deserialization** is chosen per call by `responseType`:
  - **`json`** (default): if the response `content-type` includes `application/json`, the module MUST attempt to parse the body as JSON. If the response is empty (0 bytes) but claims to be JSON, the module MUST return `null` rather than throw. For any other content type the `body` is a raw string.
  - **`text`**: always a string — the honest name for the old fallback, so a caller that wants text says so rather than getting it by omission.
  - **`bytes`**: the body buffered as raw bytes. Required for any binary payload: reading one as text corrupts it.
  - **`stream`**: a byte stream, returned as `{ output }` without buffering.

  `responseType` is an INPUT, so a kind wrapping `Http.Request` can vary it per call. The config-level `mode` is deprecated and maps onto it (`buffer` → `json`, `stream` → `stream`) only when a call declares none.

### 3. Error handling (network vs. HTTP)

It is crucial to differentiate between an HTTP error (the external server responded) and a network error (the kernel couldn't reach the server).

#### 3.1 HTTP status errors, and what counts as success

**`success` defines what a failure IS; `throwOnHttpError` decides what happens to one.** The two are orthogonal — neither implies the other. `success` takes a list of statuses or a CEL boolean over `status`, `headers` and `body`, and defaults to `status < 400`.

- **Standard:** by default, statuses like `400`, `404` or `500` MUST NOT throw. They are successful network executions, returned as the standard Telo Response Object with their `status`.
- A response classified successful is **never retried** and **never followed as a redirect**. That is what lets a resumable upload declare `success: [200, 201, 308]` and have its `308` returned rather than chased.
- `body` is `null` when the response is streamed, so a predicate reading it must guard for null — the analyzer requires the guard.

#### 3.1.1 Retrying

`retryOn` names the FAILED responses worth another try — again a status list or a CEL predicate over the same scope — and is consulted only for responses `success` already rejected, so a status named by both is a success and no precedence rule is needed. It defaults to `408, 429, 500, 502, 503, 504` when `retry.attempts` is non-zero.

`retry` carries `attempts`, `initialDelay`, `factor`, `maxDelay`, `jitter` (`full` by default, picking each delay uniformly from `[0, delay]` so a fleet that failed together does not re-attempt together) and `honorRetryAfter` (a `Retry-After` header raises the delay, never lowers it). Network failures and retryable statuses share one attempt counter: an author who says five attempts means five, not five per failure mode. `Http.Client` supplies defaults, since backoff is a property of the API being called rather than of one call; `retries` is a deprecated alias for `retry.attempts`.

#### 3.2 Network and engine errors

If the request fails at the network layer (e.g. DNS resolution failure, connection refused, SSL error), the module MUST throw a standardized Telo Network Error that stops execution.

```json
{
  "error": "NetworkError",
  "code": "CONNECTION_REFUSED",
  "message": "Failed to connect to api.external.com",
  "details": {
    "url": "https://api.external.com/data"
  }
}
```

Valid `code` values MUST include: `TIMEOUT`, `CONNECTION_REFUSED`, `DNS_RESOLUTION_FAILED`, `SSL_ERROR`. Modules must map their native engine errors to these generic codes.

### 4. Execution policies (timeouts and redirects)

- **Timeouts:** the module MUST enforce a default request timeout of 10,000 ms unless overridden. Timeout failures MUST throw a `NetworkError` with code `TIMEOUT`.
- **Redirects:** the module MUST automatically follow `301` and `302` redirects, up to a maximum of 5, to prevent infinite redirect loops. **Classification runs first:** a status named by `success` is returned rather than followed. Only the status and headers are consulted for that decision — the body is not read yet, and reading it would buffer a response the caller may have asked to stream.

### 5. What is logged

A completed request logs at `debug` with `http.request.method`, `http.response.status_code` and the elapsed time. Two things log higher, because only the *final* outcome reaches the caller:

- a network failure that is **retried** logs at `warn` with `http.request.resend_count` — otherwise a request that failed twice and succeeded on the third attempt is indistinguishable from one that worked first time;
- the **401 re-acquire-and-retry** logs at `info`, so a credential that has to be refreshed on every call does not look like one that never expires.

**The URL is reported as `url.scheme`, `server.address`, `server.port` and `url.path` — never `url.full`.** The query string and any userinfo are dropped rather than scrubbed, so a presigned URL's `X-Amz-Signature`, a `sig` parameter, or `https://user:pass@host` cannot reach a record; a drop cannot be defeated by a parameter name nobody thought to list. The result is deliberately *not* published as `url.full`, which means the absolute URL — a consumer correlating on it would get a value that silently differs from the request actually made. Request and response **headers are never captured**, per the logging spec's opt-in rule for them.
