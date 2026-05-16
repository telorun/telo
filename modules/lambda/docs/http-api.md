---
sidebar_label: Lambda.HttpApi
---

# Lambda.HttpApi

Working example: [`examples/aws/lambda/http-api.yaml`](https://github.com/telorun/telo/blob/main/examples/aws/lambda/http-api.yaml).

Handle API Gateway HTTP API v2 events. Define routes — `request.method` + `request.path`, optional schemas, a handler, and `returns:` / `catches:` to shape the response — and `Lambda.HttpApi` matches the incoming request to a route, invokes the handler, and renders the response.

## Routes

```yaml
kind: Lambda.HttpApi
metadata: { name: Web }
routes:
  - request:
      method: GET
      path: "/users/{id}"
    handler:
      kind: My.Handler
      name: GetUser
    inputs:
      id: !cel "request.params.id"
    returns:
      - status: 200
        content:
          application/json:
            body: !cel "result"
    catches:
      - code: NOT_FOUND
        status: 404
        content:
          application/json:
            body: !cel '{ error: { code: error.code, message: error.message } }'
```

**`request.method`** — `GET`, `POST`, `PUT`, `DELETE`, `PATCH`, `HEAD`, or `OPTIONS`.

**`request.path`** — OpenAPI-style template. `{paramName}` matches one path segment and binds it to `request.params.paramName`. `{name+}` (only as the trailing segment) is greedy and captures all remaining segments as a single `/`-joined string — same convention as API Gateway's `{proxy+}`.

**`request.schema`** — optional `params` / `query` / `body` / `headers` JSON Schemas. Used for typing CEL access in `inputs:` and friends.

**`handler`** — any `Telo.Invocable`. Receives the CEL-expanded `inputs` and returns a result.

**`returns:` / `catches:`** — shape the response. The full contract (status, when, mode, headers, per-MIME content, encoders) is the same as `Http.Api`'s; see [HTTP Server: returns & catches](../../http-server/docs/returns-and-catches.md) for the reference.

## CORS

Optional, declared on the kind itself (not per-route):

```yaml
kind: Lambda.HttpApi
metadata: { name: Web }
cors:
  origin: "*"
  methods: [GET, POST]
  allowedHeaders: [Content-Type, Authorization]
  credentials: true
  maxAge: 3600
routes: [...]
```

The matching `Access-Control-*` headers are emitted on every response. API Gateway handles OPTIONS preflights at its own layer, so you don't declare them as routes.

- `origin: "*"` emits a wildcard.
- `origin: ["https://a.example", "https://b.example"]` echoes the request's `Origin` only when it's in the allowlist; otherwise the header is omitted (the browser blocks the response).
- `methods` and `allowedHeaders` are joined with `,` for the corresponding response header.
- `credentials: true` emits `Access-Control-Allow-Credentials: true`.
- `maxAge` is forwarded as `Access-Control-Max-Age`.

## Unmatched requests

When no route matches, `Lambda.HttpApi` returns a JSON 404:

```json
{ "error": { "code": "NOT_FOUND", "message": "No route matched <method> <path>" } }
```

Customize the not-found behaviour by adding a greedy catch-all route as the last entry:

```yaml
routes:
  - request: { method: GET, path: "/health" }
    ...
  - request: { method: GET, path: "/{proxy+}" }
    handler: { kind: My.NotFound }
    inputs:
      path: !cel "request.params.proxy"
    returns:
      - status: 404
        content:
          application/json:
            body: !cel '{ error: { code: "NOT_FOUND", path: inputs.path } }'
```

## Streaming responses

Not currently supported. `mode: stream` entries throw at runtime; use buffer mode (the default) for now.
