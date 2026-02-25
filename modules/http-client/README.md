# Telo HTTP Client Standard Specification (v1.0 Draft)

## Overview

The `Http.Request` (and optionally `Http.Client`) definitions represent outgoing HTTP calls made by the Telo runtime to external services.
Because different programming languages implement HTTP clients differently (e.g., `fetch` in Node.js, `reqwest` in Rust), all Telo HTTP Client modules MUST adhere to this exact behavior to ensure cross-language compatibility.

---

## 1. The Request Contract (Input Serialization)

When the Telo runtime executes an `Http.Request`, the underlying module must construct the outgoing request according to strict rules.

- **Headers Normalization:** All header keys provided in the manifest MUST be normalized to lowercase before sending.
- **Query Parameters:** If `query` is provided as an object, the module MUST safely URL-encode the keys and values and append them to the `url`.
- **Payload Serialization (Body):**
- If the `headers` include `content-type: application/json` (which should be the default if `body` is an object), the module MUST serialize the `body` to a JSON string.
- If the `content-type` is `application/x-www-form-urlencoded`, the module MUST serialize the object into a URL-encoded string.

---

## 2. The Response Contract (Output Deserialization)

The output of an `Http.Request` becomes available to the Telo engine (e.g., for mapping via CEL expressions). The underlying engine MUST return a standardized **Telo Response Object**.

### Standardized Return Object

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

- **Header Normalization:** The module MUST normalize all incoming response headers to lowercase keys.
- **Body Deserialization Rules:**
- **JSON:** If the response header `content-type` includes `application/json`, the module MUST attempt to parse the response body as a JSON object. _Edge Case:_ If the response is empty (0 bytes) but claims to be JSON, the module MUST return `null` for the body, not throw a parsing error.
- **Text/Other:** For any other content type, or if JSON parsing fails gracefully, the `body` MUST be returned as a raw String.

---

## 3. Error Handling Contract (Network vs. HTTP)

It is crucial to differentiate between an HTTP error (the external server responded) and a Network error (the runtime couldn't reach the server).

### 3.1. HTTP Status Errors (4xx and 5xx)

- **Standard:** By default, HTTP status codes like `400`, `404`, or `500` **MUST NOT** throw a runtime execution error.
- They are considered successful _network_ executions. The module MUST return the standard Telo Response Object with the respective `status` code. It is up to the Telo manifest author to handle these via CEL mappings (e.g., `${{ result.status == 200 ? result.body : throw('API Failed') }}`).

### 3.2. Network & Engine Errors

If the request fails at the network layer (e.g., DNS resolution failure, connection refused, SSL error), the module MUST throw a standardized **Telo Network Error** that stops execution.

**Standardized Error Format:**

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

_Valid `code` enumerations MUST include:_ `TIMEOUT`, `CONNECTION_REFUSED`, `DNS_RESOLUTION_FAILED`, `SSL_ERROR`. Modules must map their native engine errors to these generic codes.

---

## 4. Execution Policies (Timeouts & Redirects)

To prevent hanging processes, Telo enforces strict default limits on outgoing requests.

- **Timeouts:** The module MUST enforce a default request timeout of **10,000 milliseconds (10 seconds)** unless overridden in the manifest. If the timeout is reached, it MUST throw a `NetworkError` with the code `TIMEOUT`.
- **Redirects:** The module MUST automatically follow `301` and `302` redirects, up to a maximum of **5 redirects**, to prevent infinite redirect loops.
