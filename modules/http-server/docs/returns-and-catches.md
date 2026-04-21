---
description: "HTTP route outcome mapping: returns and catches lists render success values or structured domain errors with CEL conditions"
sidebar_label: returns & catches
---

# `returns:` and `catches:`

Every route in an `Http.Api` defines two outcome lists:

- `returns:` — rendering rules for values the handler resolved with.
- `catches:` — rendering rules for structured `InvokeError` throws from the handler.

Plain `Error` / `RuntimeError` throws (operational failures) skip `catches:` entirely and are handed to Fastify's default 5xx renderer. This keeps domain failures distinct from infrastructure failures.

```yaml
- request: { path: /{namespace}/{name}/{version}, method: PUT }
  handler:
    kind: Auth.VerifyToken
    name: VerifyPublishToken
  inputs:
    authorization: "${{ request.headers.authorization }}"

  returns:
    - status: 201
      body:
        published: "${{ result.published }}"

  catches:
    - when: "${{ error.code == 'UNAUTHORIZED' }}"
      status: 401
      body:
        error: "${{ error.message }}"
    - when: "${{ error.code == 'VERSION_EXISTS' }}"
      status: 409
      body:
        error: "${{ error.message }}"
        conflict: "${{ error.data.existing }}"
    - status: 500 # catch-all for any declared code not matched above
      body:
        error: "${{ error.message }}"
        code: "${{ error.code }}"
```

## Rules

- **CEL context.** `returns:` entries see `{ result, request }`. `catches:` entries see `{ error, request }`. Cross-channel references (`result.*` in `catches:`, `error.*` in `returns:`) are rejected by the analyzer.
- **Matching.** Both lists are scanned top-to-bottom. The first entry whose `when:` evaluates truthy wins. The first entry with no `when:` is the list's catch-all; entries following it are unreachable and rejected by the analyzer.
- **`returns:` is required.** Every route must define at least one `returns:` entry. `catches:` is optional when the handler's declared throw union is empty.
- **Streams on `returns:` only.** `mode: stream` is forbidden on `catches:` entries — structured errors are always serialised as JSON.
- **Unmatched `InvokeError`.** When a handler throws an `InvokeError` but no `catches:` entry matches and no catch-all is present, the dispatcher renders `500 { error: { code, message, data } }`.

## Mid-stream throws

If a `mode: stream` `returns:` entry matches, the response is committed (status + headers flushed) before the stream body begins. A throw after that point cannot trigger `catches:` — the chunked transfer is aborted and the socket closed. Authors who need catchable failure inside a streaming pipeline must validate upfront and throw before the stream starts.

## `notFoundHandler`

`Http.Server.notFoundHandler` accepts the same `returns:` and `catches:` split as a route handler. The `invoke:` resource runs when Fastify can't match any mounted route; its return value flows through `returns:`, its `InvokeError` throws through `catches:`.
