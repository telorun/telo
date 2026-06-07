# HTTP Server

Language- and framework-agnostic HTTP server for Telo. Declarative routes, schema-validated requests, and a typed return/catch rendering pipeline.

## Why use this

- **Framework-neutral** — the underlying engine (Fastify, Actix, …) is an implementation detail; the same manifest runs on any compliant adapter.
- **OpenAPI-style paths** — `/users/{id}` syntax everywhere; the adapter translates to its native router.
- **Schema-driven validation** — `request.schema` (`body`, `query`, `params`, `headers`) yields a standardized HTTP 400 with `details[]` on failure.
- **Typed returns and catches** — render successful values and structured `InvokeError`s into status + headers + per-MIME bodies via CEL.
- **Composable mounts** — attach `Telo.Mount` resources (HTTP APIs, MCP endpoints, custom mounts) under any path prefix.
- **CORS and content-type parsers** — first-class manifest fields; no controller code needed.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Http.Server` | Long-lived HTTP listener that hosts mounts on configured paths and ports. |
| `Http.Api` | Mountable router exposing route definitions with returns/catches rendering. |

## Example

```yaml
kind: Telo.Application
metadata: { name: hello-http, version: 1.0.0 }
imports:
  Http: std/http-server@0.9.0
  JS: std/javascript@0.4.1
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
      name: "${{ request.params.name }}"
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
            body: { message: "${{ result.message }}" }
---
kind: JS.Script
metadata: { name: Greet }
code: |
  return { message: `Hello, ${inputs.name}!` };
```

## Reference

- [`Http.Server` / `Http.Api` returns & catches](docs/returns-and-catches.md) — outcome lists, MIME negotiation, stream mode.

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
- If the `content-type` is `application/json`, the `body` MUST be parsed into a native object/dictionary before evaluation.

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
      "message": "must be an integer"
    },
    {
      "location": "query",
      "path": "active",
      "message": "is a required property"
    }
  ]
}
```

- **`location` enum:** `body` | `query` | `params` | `headers`.
- **Module responsibility:** the module author must write an error handler/mapper that transforms the native framework's validation output into the Telo `details` array.

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
