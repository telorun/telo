# Request bodies

> Examples below assume the `http-server` module is imported under alias `Http`, and `run` under `Run`.

How a request body reaches a handler — buffered, parsed by a resource of yours, or streamed — the one byte limit that applies to every one of them, and what happens to a body nobody reads.

## Three ways a body arrives

| Body | Arrives as | Declared by |
| --- | --- | --- |
| `application/json`, `text/plain` | The parsed value, read whole before the handler runs. | Nothing — built in. |
| A content type you parse yourself | Whatever your parser returned, read whole first. | `contentTypeParsers: [{ contentType, parser }]` |
| A content type you stream | A byte stream the handler pulls. Nothing is buffered and no schema validation runs. | `contentTypeParsers: [{ contentType, stream: true }]` |
| `multipart/*` | A byte stream, as above. | Nothing — built in. |

A route takes a streamed body by declaring its `request.schema.body` as a stream:

```yaml
kind: Http.Server
metadata: { name: server }
port: !cel "ports.http"
contentTypeParsers:
  - contentType: application/gzip
    stream: true
mounts:
  - path: /
    mount: !ref api
---
kind: Http.Api
metadata: { name: api }
routes:
  - request:
      path: /upload
      method: POST
      schema:
        body:
          x-telo-type: { name: Telo.Stream, of: Telo.Bytes }
    inputs:
      input: !cel "request.body"
    handler: !ref store
    returns:
      - status: 204
```

A route declaring a stream body for a content type that arrives parsed fails with `ERR_REQUEST_BODY_NOT_STREAMED`, which names the `contentTypeParsers` entry to add. A `contentTypeParsers` entry is either `parser` or `stream`, never both.

A multipart body needs no entry: the server hands it over as raw bytes, which is what a multipart decoder reads. An entry naming an exact multipart type still takes precedence for that type alone.

## The body limit

No more than `maxBodyBytes` of a request body is ever buffered or handed to a handler, and a body is handed on only as far as something asks for it: when the response is finished before the body has arrived in full, the connection is closed instead of drained, and whatever the host still takes off the socket while it closes is discarded.

The limit is in bytes:

- **`Http.Server.maxBodyBytes`** applies to every mount — an `Http.Api`, an MCP endpoint, any other. Default `1048576` (1 MiB).
- **`Http.Api.routes[].maxBodyBytes`** replaces the server's value for that one route, larger or smaller.

Both are integers of at least 1 and both are resolved at startup, so either may come from a variable. There is no value that switches the limit off: a route that takes large uploads states how large.

```yaml
kind: Http.Server
metadata: { name: server }
port: !cel "ports.http"
maxBodyBytes: 65536             # every route, unless it says otherwise
mounts:
  - path: /
    mount: !ref api
---
kind: Http.Api
metadata: { name: api }
routes:
  - request: { path: /documents, method: POST }
    handler: !ref saveDocument
    returns:
      - status: 204
  - request:
      path: /uploads
      method: POST
      schema:
        body:
          x-telo-type: { name: Telo.Stream, of: Telo.Bytes }
    maxBodyBytes: 52428800      # 50 MiB, for this route alone
    inputs:
      input: !cel "request.body"
      contentType: !cel "request.headers['content-type']"
    handler: !ref decodeUpload
    returns:
      - status: 204
```

The limit covers streamed and multipart bodies as well as buffered ones, so an upload route over 1 MiB must raise it. A multipart decoder has limits of its own; raising one without the other only moves the refusal.

## What a refusal looks like

A body over the limit is answered `413` with `Connection: close`:

```json
{
  "error": {
    "code": "ERR_REQUEST_BODY_TOO_LARGE",
    "message": "Request body exceeds maxBodyBytes (1048576).",
    "data": { "maxBodyBytes": 1048576, "contentLength": 5242880 }
  }
}
```

`data.contentLength` is the request's declared `Content-Length`, and is absent for a body sent chunked.

**The answer is the server's own.** No `catches:` list — a route's, a router's or the server's, a catch-all included — sees it, it takes no part in throws coverage, and a `catches:` entry naming `ERR_REQUEST_BODY_TOO_LARGE` is reported as `UNDECLARED_THROW_CODE`, since no handler raises that code.

When the refusal happens depends on how the size becomes known:

| Request | Refused | The handler |
| --- | --- | --- |
| Declares a `Content-Length` over the limit — any kind of body | Before anything is read. | Never runs. |
| A buffered body sent chunked | When the bytes read pass the limit. | Never runs. |
| A streamed or multipart body sent chunked | On the chunk that crosses the limit, while the handler is reading. | Is cancelled. |

## A streamed body that crosses the limit

Nothing is known about a chunked upload's size until it arrives, so a streamed body is counted as the handler pulls it. On the chunk that takes the total over the limit:

1. The server cancels the request's own invocation, with reason `request-body-too-large`.
2. The body stream fails with that cancellation (`ERR_INVOKE_CANCELLED`). The chunk that crossed the limit is not delivered — the handler never sees a byte past it.
3. The server answers `413` at that moment, without waiting for the handler.

Whatever the handler does next is not rendered: a value it returns, an error it throws, a `try:` around the step that was reading. A cancellation of the running invocation is not caught by `try:`, and no step after it is dispatched.

If the response had already started — a route streaming its answer while it reads its body — there is no status left to send, and the connection is closed instead.

### Effects before the overflow are not undone

A handler that wrote the first chunks somewhere — rows, a file, an object in a bucket — before the limit was crossed has written them. The server refuses the request; it does not roll back what the handler already did. A handler that must leave nothing behind writes inside something that can be abandoned: a transaction that commits only once the body has ended, or a temporary object that is promoted after the last chunk.

## A body that is not read to its end

The server decides this when the response is finished, for every response — a handler's, a `catches:` entry's, the built-in 500 envelope, a guard's refusal, a 404, a 415:

| When the response is finished | The response | The connection |
| --- | --- | --- |
| The body has arrived in full — read or not. | As written, with no `Connection: close`. | Kept for the next request. |
| The body has not arrived in full and no header was sent yet: a handler that never read it, one that read part of it, a handler that failed on an earlier step, a request refused before its body was looked at. | As written, plus `Connection: close`. | Closed after the response; the remainder is discarded, never handed on. |
| The body has not arrived in full and the response had already started — a route streaming its answer. | As written. | Closed at the end of the response; the remainder is discarded, never handed on. |

While the connection closes, the host may still take some of the remainder off the socket and discard it. The amount does not grow with the body or with `maxBodyBytes` — about 2 MiB on Node, never more than 8 MiB — and none of it is buffered or handed to a handler.

The close is not immediate. Closing a socket that still holds unread request body makes the operating system reset the connection, and a reset can discard a response the client has not read yet. So the server stops reading, sends the response with the end of its side of the connection, and holds the socket for one second before destroying it.

No `413` is sent for a body nobody pulled: the limit is judged on a declared `Content-Length` and on the bytes something reads. A body counts as arrived once its declared length has been received or the end of a chunked body has been seen.

A client must expect the connection to close while it is still sending.

## What depends on the host

On every host, no more than `maxBodyBytes` of a request body is buffered or handed to a handler, a body over the limit is answered `413`, and a remainder nobody reads is discarded. Closing the connection, and with it the bound on what is read off the socket, is a property of the Node runtime the `telo` binary runs on. Under Bun the response still carries `Connection: close`, but the connection stays open and an unread or over-limit body is read off the wire to its end and discarded — never buffered, never handed to a handler.

## Tracing

A refused request's span ends `rejected` with `error.type` `ERR_REQUEST_BODY_TOO_LARGE`. See [Tracing](tracing.md).
