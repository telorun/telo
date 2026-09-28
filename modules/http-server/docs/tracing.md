# Tracing

When the application's tracing is on (a sink listed in the root Application's
`tracing.sinks`), `Http.Server` makes **every request one span**. The span opens
before anything runs for the request — CORS, a mount's guard, body parsing — and
ends when the response has completed, including a streamed response and one a
mount writes itself (`Mcp.HttpEndpoint`). Every dispatch the request drives runs
beneath it: the mount's guard, a `contentTypeParsers` parser, the route's
handler, the not-found handler, and each MCP tool call. It holds for every mount
kind — `Http.Api`, `Mcp.HttpEndpoint`, `Http.Static`, `Http.Reference` — guarded
or not, and for a request no route matched.

A client that disconnects before its response completes cancels that request's
context, so the guard and the handler both see the cancellation.

With tracing off, a request mints no span ids and costs nothing beyond its
cancellation scope.

## The span

| | |
| --- | --- |
| Name | `<METHOD> <http.route>` — `GET /api/items`, the full matched template including the mount's prefix. A request no route matched is named by its method alone: `GET`. |
| `http.request.method` | The request method. |
| `http.route` | The matched template (`/todos/:id`), never the concrete path. Absent when no route matched. |
| `http.response.status_code` | The status sent. Absent when the connection closed before the response began. |
| `error.type` | On a `rejected` or `failed` span: the deciding error's code, else its class name. |
| Debug-wire ref | `{ kind: Http.Server, name: <server> }`. |

The span is attributed to the server, not to the mount, because the server is
what received the request.

## Outcome

| Outcome | When |
| --- | --- |
| `cancelled` | The connection closed before the response completed. |
| `rejected` | A coded error decided the response: a guard's refusal, a route's or the not-found handler's throw — rendered by any `catches:` rung or by the built-in 500 envelope — or a request that failed validation (`error.type` `ERR_INPUT_INVALID`, a 400). |
| `failed` | An uncoded error reached the framework, which answered 500. |
| `ok` | Anything else — including a 404 with no not-found handler and a 4xx a `returns:` entry chose. |

An uncoded error the framework answers with a 4xx of its own (an unsupported
media type, a body over the size limit) is `rejected`.

## What a trace looks like

```
GET /api/items                  ok        200
├── invoke <guard>              ok
└── invoke <handler>            ok

GET /api/items                  rejected  401  error.type=ERR_UNAUTHENTICATED
└── invoke <guard>              rejected

GET /probes/ready               ok        200
└── invoke <handler>            ok
```

A refused request holds no handler span: the guard answered it.

## Continuing a caller's trace

A request carrying a W3C `traceparent` header joins the caller's trace: the
request span takes the header's trace id, and its parent is the header's
parent span — exported exactly as the caller sent it. `tracestate` is read with
it. A header that is malformed, or whose trace or parent id is all zeros, is
ignored in full and the request roots a trace of its own.

So `traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01` makes
the request span part of trace `4bf92f3577b34da6a3ce929d0e0e4736`, parented by
span `00f067aa0ba902b7`.

## Mounts

A mount receives the request's scope as the third argument of
`register(app, prefix, requestScope)`; its type, `RequestScope`, is published
from `@telorun/http-dispatch`. `requestScope.forRequest(request)` returns the
span's `context`, which the mount dispatches on, and `reject(error)`, which
reports an error the mount rendered itself (a `catches:` rung, a validation
refusal) so the span's outcome reflects it. An error the mount rethrows reaches
the server, which reports it. `Http.Api` and `Mcp.HttpEndpoint` registered
without a scope refuse each request (`ERR_HTTP_REQUEST_SCOPE_MISSING` /
`ERR_MCP_REQUEST_SCOPE_MISSING`, a 500) rather than root a trace of their own.
