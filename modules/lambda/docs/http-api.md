---
sidebar_label: Lambda.HttpApi
---

# Lambda.HttpApi

API Gateway HTTP API v2 trigger. Dispatched by a `Lambda.Function` when the incoming AWS event's `requestContext.http` shape matches. The kind owns its routes and response rendering; the Function only owns transport.

## Shape

```yaml
kind: Lambda.HttpApi
metadata: { name: Web }
cors:
  origin: "*"
  methods: [GET, POST]
routes:
  - request:
      method: GET
      path: "/users/{id}"
    handler: { kind: My.Handler, name: GetUser }
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

## Routes

Each entry under `routes:` declares one HTTP route:

- `request.method` — `GET` / `POST` / `PUT` / `DELETE` / `PATCH` / `HEAD` / `OPTIONS`. Same enum as `http-server.Api.routes[].request.method`; both transports anchor at the shared `HttpDispatch.Request/$defs/Matcher` carrier.
- `request.path` — OpenAPI-style template with `{paramName}` placeholders, e.g. `/users/{id}/orders/{orderId}`. Path-param values are extracted into `request.params` for the route's CEL context.
- `request.schema` — optional JSON Schemas for `query` / `body` / `headers` / `params`. The analyzer types `request.<key>` properties accordingly so CEL expressions get typed access (e.g. `!cel "request.query.limit"` is typed as the schema's `limit` shape).
- `handler` — `Telo.Invocable` reference. Receives `inputs:` (CEL-expanded against the request context) and produces a result.
- `returns:` / `catches:` — rendering rules anchored at `HttpDispatch.Outcomes/$defs/{Returns,Catches}` — same shape as `http-server.Api.routes[]`. See [HTTP Server: returns & catches](../http-server/docs/returns-and-catches.md) for the full contract (status, when, mode, headers, content[mime].body, schema, encoder).

## Streaming

Not supported in v1. AWS response streaming requires either the managed-runtime `awslambda.streamifyResponse` wrapper or custom-runtime chunked Runtime API POSTs. `mode: stream` entries throw a clear diagnostic at runtime. Tracked as a follow-up.

## CORS

Optional. The controller emits the matching `Access-Control-*` headers on every dispatched response (not on OPTIONS preflights — AWS handles those at the API Gateway layer):

- `origin: "*"` — sets `Access-Control-Allow-Origin: *`.
- `origin: ["https://a.example", "https://b.example"]` — echoes the request's `Origin` when it's in the allowlist; otherwise omits the header.
- `methods`, `allowedHeaders` — joined with `,` for the corresponding response header.
- `credentials: true` — adds `Access-Control-Allow-Credentials: true`.
- `maxAge: N` — adds `Access-Control-Max-Age: N`.

## Default 404

When no route matches the incoming request, the controller returns a JSON-shaped 404 envelope:

```json
{ "error": { "code": "NOT_FOUND", "message": "No route matched <method> <path>" } }
```

Surface a custom not-found shape by adding a greedy catch-all route as the last entry, e.g. `request: { method: GET, path: "/{proxy+}" }`. The `{name+}` suffix matches one or more remaining path segments and binds them to `request.params.<name>` as a `/`-joined string (mirrors AWS API Gateway's `{proxy+}` syntax — must be the trailing segment of the path).

## Parity with http-server.Api

The matcher schema (`method` / `path` / `query` / `body` / `headers`) and the outcome schemas (`returns` / `catches`) both anchor at carriers in `@telorun/http-dispatch`. A route definition can be moved between `Lambda.HttpApi` and `Http.Api` field-for-field — the `inputs:` CEL context shape is identical.
