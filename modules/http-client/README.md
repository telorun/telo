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
| `Http.Request` | Per-call HTTP request invocable; references an `Http.Client` for shared defaults. |

## Authenticating requests

`Http.Credential` is a contract, not an implementation — implement it for API
keys, HMAC signing or SigV4, or use `OAuthClient.Credential` for OAuth 2.0. Attach
one to a client and the calls through it need no header wiring:

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
- **Body deserialization:**
  - **JSON:** if the response `content-type` includes `application/json`, the module MUST attempt to parse the body as JSON. If the response is empty (0 bytes) but claims to be JSON, the module MUST return `null` for the body rather than throw.
  - **Text/other:** for any other content type, or if JSON parsing fails gracefully, the `body` MUST be returned as a raw string.

### 3. Error handling (network vs. HTTP)

It is crucial to differentiate between an HTTP error (the external server responded) and a network error (the kernel couldn't reach the server).

#### 3.1 HTTP status errors (4xx and 5xx)

- **Standard:** by default, HTTP status codes like `400`, `404`, or `500` MUST NOT throw a kernel execution error.
- They are considered successful network executions. The module MUST return the standard Telo Response Object with the respective `status` code. Manifest authors handle these via CEL mappings (e.g. `${{ result.status == 200 ? result.body : throw('API Failed') }}`).

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
- **Redirects:** the module MUST automatically follow `301` and `302` redirects, up to a maximum of 5, to prevent infinite redirect loops.

### 5. What is logged

A completed request logs at `debug` with `http.request.method`, `http.response.status_code` and the elapsed time. Two things log higher, because only the *final* outcome reaches the caller:

- a network failure that is **retried** logs at `warn` with `http.request.resend_count` — otherwise a request that failed twice and succeeded on the third attempt is indistinguishable from one that worked first time;
- the **401 re-acquire-and-retry** logs at `info`, so a credential that has to be refreshed on every call does not look like one that never expires.

**The URL is reported as `url.scheme`, `server.address`, `server.port` and `url.path` — never `url.full`.** The query string and any userinfo are dropped rather than scrubbed, so a presigned URL's `X-Amz-Signature`, a `sig` parameter, or `https://user:pass@host` cannot reach a record; a drop cannot be defeated by a parameter name nobody thought to list. The result is deliberately *not* published as `url.full`, which means the absolute URL — a consumer correlating on it would get a value that silently differs from the request actually made. Request and response **headers are never captured**, per the logging spec's opt-in rule for them.
