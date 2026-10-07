# HTTP Server

Language- and framework-agnostic HTTP server for Telo. Declarative routes, schema-validated requests, and a typed return/catch rendering pipeline.

## Why use this

- **Framework-neutral** — the underlying engine (Fastify, Actix, …) is an implementation detail; the same manifest runs on any compliant adapter.
- **OpenAPI-style paths** — `/users/{id}` syntax everywhere; the adapter translates to its native router.
- **Schema-driven validation** — `request.schema` (`body`, `query`, `params`, `headers`) yields a standardized HTTP 400 with `details[]` on failure.
- **Typed returns and catches** — render successful values and structured `InvokeError`s into status + headers + per-MIME bodies via CEL.
- **OpenAPI operation metadata** — a route may declare `operationId`, `summary`, `description`, and `tags`; they are rendered into the generated OpenAPI document.
- **Composable mounts** — attach `Telo.Mount` resources (HTTP APIs, MCP endpoints, custom mounts) under any path prefix.
- **Inbound guards** — a mount's `guard:` runs one invocable for every request to that mount's routes, before the body is read, so authentication or an origin check is declared once and a refusal renders through `catches:`.
- **Browsable API docs** — `Http.Reference` renders the generated OpenAPI document as an interactive page under a prefix you choose, and a mount's `when:` leaves it out of a production deployment.
- **Serve a frontend** — `Http.Static` serves a directory of assets (a built SPA, plain HTML) so one application delivers both its API and its UI.
- **CORS and content-type parsers** — first-class manifest fields; no controller code needed.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Http.Server` | Long-lived HTTP listener that hosts mounts on configured paths and ports. |
| `Http.Api` | Mountable router exposing route definitions with returns/catches rendering. |
| `Http.Reference` | Mountable API reference: the server's OpenAPI document rendered as a browsable page, plus the document itself as JSON and YAML. |
| `Http.Static` | Mountable static-file server for a directory of assets (built SPA, plain HTML, images). |

## Example

```yaml
kind: Telo.Application
metadata: { name: hello-http, version: 1.0.0 }
imports:
  Http: oci://ghcr.io/telorun/http-server@0.19.1
  JS: oci://ghcr.io/telorun/javascript@0.7.0
targets: [ !ref Server ]
---
kind: Http.Server
metadata: { name: Server }
port: 8080
mounts:
  - path: /api
    mount: !ref Api
---
kind: Http.Api
metadata: { name: Api }
routes:
  # Declare request.schema and the response content.schema so the route is
  # type-checked AND fully described in the generated OpenAPI document. Put
  # `examples` on each field so the spec shows sample payloads.
  - request:
      method: GET
      path: /hello/{name}
      schema:
        params:
          type: object
          properties:
            name:
              type: string
              description: Name to greet.
              examples: [ "Ada" ]
    inputs:
      name: !cel "request.params.name"
    handler: !ref Greet
    returns:
      - status: 200
        content:
          application/json:
            schema:
              type: object
              properties:
                message:
                  type: string
                  description: The greeting.
                  examples: [ "Hello, Ada!" ]
            body: { message: !cel "result.message" }
---
kind: JS.Script
metadata: { name: Greet }
code: |
  return { message: `Hello, ${inputs.name}!` };
```

## Reference

- [`Http.Server` / `Http.Api` returns & catches](docs/returns-and-catches.md) — outcome lists, MIME negotiation, stream mode.
- [Mount guards](docs/mount-guard.md) — `mounts[].guard`: per-mount inbound checks, their CEL context, ordering against CORS and body parsing, and how a refusal renders.
- [API reference docs](docs/api-reference.md) — `Http.Reference`, choosing its prefix, and leaving the docs out of production with `when:`.
- [Serving static files & frontends](docs/static-files.md) — `Http.Static`, `!module-path` and host-path roots, SPA fallback, asset caching.
- [Log events](docs/log-events.md) — the `event_name` and attributes every implementation of this kind emits, and how to turn request logging off.
- [Tracing](docs/tracing.md) — the one span each request is, its name, attributes and outcome, what runs beneath it, and continuing a caller's `traceparent`.

## Implementation Contract

The `Http.Server` and `Http.Api` manifests in Telo are designed to be strictly language-agnostic and framework-agnostic. To maintain the "Zero Lock-in" promise, the underlying HTTP engine (e.g. Fastify in Node.js, Actix in Rust) is treated purely as an implementation detail. All HTTP modules integrated into the Telo kernel MUST adhere to this behavioural contract.

### 1. Routing (path definitions)

Telo standardizes on the OpenAPI specification format for paths.

- **Standard:** path parameters MUST be enclosed in curly braces: `{parameterName}`.
- **Module responsibility:** the underlying HTTP module must parse the Telo path and translate it into its framework's native routing syntax at startup.

**Example manifest path:** `/api/v1/users/{userId}`

- Node.js (Fastify) adapter translates to: `/api/v1/users/:userId`
- Rust (Actix) adapter translates to: `/api/v1/users/{userId}`

### 2. I/O context contract

When an incoming HTTP request is received, the underlying framework must normalize it into a standard Telo Request Object before passing it to the handler/CEL engine. Conversely, it must accept a standard Telo Response Object to send back to the client.

#### 2.1 Standardized Telo Request Object (input)

```json
{
  "request": {
    "method": "POST",
    "path": "/api/v1/users/123",
    "params": { "userId": "123" },
    "query": { "active": "true" },
    "headers": {
      "content-type": "application/json",
      "authorization": "Bearer token..."
    },
    "body": {
      "name": "Alice",
      "age": 30
    }
  }
}
```

- All `headers` keys MUST be normalized to lowercase.
- **Every member of `request` MUST be a value in the CEL value domain**, because `request` is a CEL binding: a map is handed over in the form a host hands a map over — for the Node adapter a plain object — and the member-read seam answers *this value holds no members* for anything else rather than performing a host property read, which is what stops a computed key (`request.query[k]`) from ever reaching a prototype, a method or `constructor`. A framework's own request bags are routinely NOT that: Fastify's query parser builds each one with a prototype of its own, so the adapter copies each bag's own entries over before binding it. An adapter that skips this does not mis-render anything — every expression reading the bag fails, and the route answers 500.
- If the `content-type` is `application/json`, the `body` MUST be parsed into its native JSON value before evaluation — an object, an array, a string, a number.
- `request.body` is **untyped** in a route's `inputs:` until the route's `request.schema.body` declares it, and always untyped in `notFoundHandler.inputs`, which has no route to declare one. A body is whatever the client sent, so an undeclared one passes `telo check` into a handler argument of any type (`items: !cel "request.body"` into an array) and its members are read unchecked; what the handler then receives is held to its `inputType` at dispatch. Declaring `request.schema.body` types `request.body` and everything beneath it, so a misspelled field is `CEL_UNKNOWN_FIELD` and a body wired into an argument of another type is `CEL_TYPE_ERROR`. `request.query`, `request.headers` and `request.params` are maps whether or not a schema is declared.
- A slot of `request.schema` declaring `type: integer` arrives in CEL as an `int`, whatever number form the client sent it in — `request.body.price + 1` is integer arithmetic.
- **A part of a request is read as its encoding carries it.** A query, path-parameter or header value is text by transport, so it is read into the type its schema declares: `?limit=5` against `type: integer` arrives as the integer `5`, and text that is no integer is a 400. A body arrives parsed and already typed, so it is validated as the value it is and never converted: `"5"` at a property declared `integer`, or a `null` at one declared `string`, `integer`, `number` or `boolean`, is a 400 naming the property. A property that may be `null` says so in its schema (`type: [string, "null"]`). The same holds for a body a `contentTypeParsers` entry's `parser` produced: it is validated as the value the parser returned.
- A slot of `request.schema` declaring a value type with a plain encoding (`x-telo-type: Telo.Timestamp`, `Telo.Duration`, `Telo.Bytes`) is validated — and documented in the OpenAPI document — as the text a client sends (`type: string, format: date-time` for a timestamp), and arrives in CEL as the value itself: `request.body.at + duration('1h')` is timestamp arithmetic. Text the type's encoding does not read is a 400 with the envelope below, one detail per refused field, its `path` naming the field inside the location (`at`, `items[0].at`).

#### 2.2 Standardized Telo Response Object (output)

After the handler executes and the `response.mapping` evaluates, the engine returns an object to the HTTP module. The module must map this directly to the native HTTP response.

```json
{
  "status": 200,
  "headers": {
    "x-telo-runtime": "0.1.0",
    "content-type": "application/json"
  },
  "body": {
    "id": "123",
    "status": "created"
  }
}
```

A JSON body's reader is not Telo, so a CEL value in it is written in its plain encoding and never type-tagged, whether or not the route declares a response schema: a timestamp as RFC 3339 text in UTC (`"2026-01-15T07:30:00.000Z"`), a duration as seconds (`"5400s"`), bytes as base64url without padding, a `uint` as its digits, NaN and ±Infinity as `"NaN"` / `"Infinity"` / `"-Infinity"`, and a map with int or bool keys as an object keyed by their text. A response schema slot declaring such a type is documented as that text.

### 3. Validation and error handling

When a request fails schema validation (defined in the `request.schema` of the manifest), the underlying engine (e.g. AJV in Fastify) will generate native errors. These internal errors must not leak to the client. All Telo HTTP modules MUST intercept framework-specific validation errors and return a standardized HTTP 400 Bad Request payload.

```json
{
  "error": "ValidationError",
  "message": "Request validation failed",
  "status": 400,
  "details": [
    {
      "location": "body",
      "path": "user.age",
      "message": "must be integer"
    }
  ]
}
```

- **A JSON body is not coerced; query, path and header values are.** `{"n": "5"}` or `{"n": null}` against `n: { type: integer }` is refused with `{ "location": "body", "path": "n", "message": "must be integer" }`, while `?n=5` is accepted and read as `5`.
- **One detail per finding of the validator.** The validator stops at the first part of the request it refuses (path parameters, then the body, then the query, then the headers) and at the first finding in it.
- **`location`** — the part of the request that was validated: `body` | `query` | `params` | `headers`.
- **`path`** — the path of the refused value from that part's root: property names joined by `.` (`note`, `address.street`), and a list position written in brackets against the list that holds it, with no dot (`items[0].name`; `[0].name` when the part is itself a list). A query, path or header parameter is its own name (`limit`). A missing required property and a property the schema does not declare are each named themselves — the parent's path plus the name — and a finding about the part as a whole has the empty path.
- **`message`** — the validator's own sentence, read after the path: `must be integer`, `must NOT have more than 5 characters`, `must match format "date"`, `must NOT have additional properties`. A missing required property reads `is a required property`.
- **Module responsibility:** the module builds `details` from the validator's structured findings, never from the text of its error message.

### 4. Manifest schema upgrades

To fully support this contract, the `Http.Api` JSON Schema definition includes the following structural definitions for the `request` block:

```yaml
request:
  type: "object"
  properties:
    path:
      type: "string"
      description: "Must use OpenAPI style path parameters, e.g., /users/{id}"
    method:
      type: "string"
      enum: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]
    consumes:
      type: "array"
      items: { type: "string" }
      default: ["application/json"]
    produces:
      type: "array"
      items: { type: "string" }
      default: ["application/json"]
    schema:
      type: "object"
      properties:
        params:
          type: "object"
          description: "Validation schema for path parameters"
        query:
          type: "object"
          description: "Validation schema for query string parameters"
        headers:
          type: "object"
          description: "Validation schema for HTTP headers"
        body:
          type: "object"
          description: "Validation schema for the request payload"
  required: ["path", "method"]
```

### 5. External URL & OpenAPI `servers`

A server is usually reached through a reverse proxy / ingress, so its own bound
`host:port` is not the URL clients use. The generated OpenAPI `servers` block is a
**single origin** — each operation is documented at its full `<mountPrefix><path>`,
so different APIs mounted at different prefixes stay distinct (an `Http.Api` mounted
at `/admin` is documented at `/admin/...`, never flattened to `/...`). The origin
resolves identically across runtimes (Node/Rust/Go) — the inputs are standard HTTP,
never a framework's proxy-config object:

| Manifest | `servers[].url` |
| --- | --- |
| `baseUrl: <url>` | `<url>` — explicit, fixed; wins over everything |
| `trustForwardedHeaders: true` | `<X-Forwarded-Proto>://<X-Forwarded-Host>`, derived per request |
| neither (default) | `/` — **relative**; the client resolves it against the origin the document was loaded from |

- The default is **relative** so the document is correct behind any proxy, ingress,
  or origin with zero configuration.
- `trustForwardedHeaders` is a **boolean** on purpose: the only portable cross-runtime
  signal is the standard `X-Forwarded-Proto` / `X-Forwarded-Host` (RFC 7239 `Forwarded`)
  headers. Fine-grained "trusted proxy IP/CIDR/hop" lists are framework-specific and
  MUST NOT leak into the manifest. Default `false`; only enable behind a trusted proxy
  (a client with direct network access could otherwise spoof the headers).
- When `trustForwardedHeaders` is set, the request protocol/host exposed to handlers
  MUST also reflect the forwarded headers.

### 6. Log events

Every implementation emits the same log events — `http.server.started`,
`http.server.request.started`, `http.server.request`, `http.server.stopped` —
with the same OpenTelemetry attributes. See [log events](docs/log-events.md) for
the table.

The `event_name` and the attributes are the contract; the message text is not.
Message strings come from whatever framework is underneath and differ per
runtime, so **a consumer MUST key on `event_name`, never on the message**.

Severity follows the response: `info`, except a **5xx**, which is `error`. A
mount entry MAY carry `logging.level` to set its own floor — `warn` silences a
health check polled every second, while its 5xx still surfaces because that is
logged at `error`.

Two consequences for an implementer:

- **Disable the framework's own request logging** and emit from middleware
  (Fastify's `onResponse`, a `tower` layer, an `http.Handler` wrapper). Passing a
  framework's own access lines through is how a runtime ends up shipping Pino's
  or `tower-http`'s record shape instead of this kind's.
- **One `info` record per request, on completion.** The received-side record is
  `debug`; it exists only so a request that hangs and never completes still
  leaves a trace.
