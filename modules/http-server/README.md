# Telo HTTP Standard Specification (v1.0 Draft)

## Overview

The `Http.Server` and `Http.Api` manifests in Telo are designed to be strictly **language-agnostic** and **framework-agnostic**. To maintain the "Zero Lock-in" promise, the underlying HTTP engine (e.g., Fastify in Node.js, Actix in Rust) is treated purely as an implementation detail.

All HTTP modules integrated into the Telo runtime **must** adhere to this behavioral contract. This ensures that a YAML manifest written today will execute with exactly the same I/O and validation behavior regardless of the underlying language or framework.

---

## 1. Routing Contract (Path Definitions)

Different web frameworks use different syntaxes for path parameters (e.g., `/users/:id` vs. `/users/{id}`).

Telo standardizes on the **OpenAPI specification format** for paths.

- **Standard:** Path parameters MUST be enclosed in curly braces: `{parameterName}`.
- **Module Responsibility:** The underlying HTTP module must parse the Telo path and translate it into its framework's native routing syntax at startup.

**Example Manifest Path:** `/api/v1/users/{userId}`

- _Node.js (Fastify) Adapter translates to:_ `/api/v1/users/:userId`
- _Rust (Actix) Adapter translates to:_ `/api/v1/users/{userId}`

---

## 2. The I/O Context Contract

When an incoming HTTP request is received, the underlying framework must normalize it into a standard **Telo Request Object** before passing it to the Handler/CEL engine. Conversely, it must accept a standard **Telo Response Object** to send back to the client.

### 2.1. Standardized Telo Request Object (Input)

The HTTP module must construct and pass the following exact payload to the execution environment:

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

- **Constraint:** All `headers` keys MUST be normalized to lowercase.
- **Constraint:** If the `content-type` is `application/json`, the `body` MUST be parsed into a native object/dictionary before evaluation.

### 2.2. Standardized Telo Response Object (Output)

After the Handler executes and the `response.mapping` evaluates, the engine will return an object to the HTTP module. The module must map this directly to the native HTTP response.

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

---

## 3. Validation & Error Handling Contract

When a request fails schema validation (defined in the `request.schema` of the manifest), the underlying engine (e.g., AJV in Fastify) will generate native errors. **These internal errors must not leak to the client.**

All Telo HTTP modules MUST intercept framework-specific validation errors and return a standardized HTTP 400 Bad Request payload.

### Standardized Validation Error Format

The response body must strictly follow this JSON structure:

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

- **`location` enum:** `body` | `query` | `params` | `headers`
- **Module Responsibility:** The module author must write an error handler/mapper that transforms the native framework's validation output into the Telo `details` array.

---

## 4. Manifest Schema Upgrades

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
