# Mount guards

> Examples below assume the `http-server` module is imported under alias `Http`, and `run` under `Run`.

A mount entry on `Http.Server` may carry a `guard:` — an invocable run for every request that matches one of **that mount's** routes, before the request body is read. It is where inbound authentication, an origin allowlist or a tenant check lives, declared once per mount instead of repeated in every route's `inputs:`.

```yaml
kind: Http.Server
metadata: { name: server }
port: !cel "ports.http"
cors:
  origin: "*"
  allowedHeaders: [ authorization, content-type ]
mounts:
  - path: /api
    mount: !ref api
    guard:
      invoke: !ref requireToken
      inputs:
        authorization: !cel "'authorization' in request.headers ? string(request.headers['authorization']) : ''"
      catches:
        - when: !cel "error.code == 'ERR_UNAUTHENTICATED'"
          status: 401
          headers:
            WWW-Authenticate: Bearer
          content:
            application/json:
              body: { error: !cel "error.message", code: !cel "error.code" }
  # No guard: health checks stay reachable.
  - path: /probes
    mount: !ref probes
---
kind: Run.Sequence
metadata: { name: requireToken }
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    additionalProperties: false
    required: [ authorization ]
    properties:
      authorization: { type: string, x-telo-sensitive: true }
steps:
  - name: check
    if: !cel "inputs.authorization != 'Bearer ' + secrets.apiToken"
    then:
      - name: refuse
        throw: { code: ERR_UNAUTHENTICATED, message: "a bearer token is required" }
```

## Shape

| Field | Meaning |
| --- | --- |
| `invoke` | The resource called for each request — any invocable or runnable (a `Run.Sequence`, a custom kind). Required. |
| `inputs` | CEL mapped into the guard's input. The context is `request` with `headers` (lowercase keys), `query`, `path`, `method` and `ip` — no `body` and no `params`, because the guard runs before either exists. Without `inputs:` the guard is called with `{}`. |
| `catches` | Rendering rules for the guard's structured throws, the same entry shape as a route's `catches:` (`status`, `when`, `headers`, `content`). Entries see `error` and the same `request` as `inputs:`. |

## Behaviour

- **A normal return lets the request through** to its route. The returned value is discarded.
- **A throw refuses the request.** An `InvokeError` is rendered by `guard.catches` first, then by the server's `catches:`. One no entry claims is the built-in `500 { error: { code, message, data } }` envelope, and a plain (non-`InvokeError`) failure is the framework's 500 — a guard that fails never lets a request through.
- **It runs after CORS and before the body is parsed.** A refused request carries the CORS headers, so a browser can read the 401; an unauthenticated request with a malformed body is answered by the guard, not by body parsing.
- **Preflight never reaches a guard.** An `OPTIONS` preflight is answered by the server's `cors`, so a browser can ask whether it may send `Authorization` before it has one.
- **Scope is one mount.** A sibling mount without a guard is unaffected, and a request that matches no route goes to the not-found handler (or the 404) unguarded.

The guard is dispatched like a route handler: on the request's context, so its span is a child of the request's span (see [Tracing](tracing.md)) and a client that disconnects cancels it, with its declared `inputType` enforced at the call (`ERR_INPUT_INVALID` when the mapped inputs do not satisfy it). Mark a credential property of the guard's `inputType` `x-telo-sensitive: true` so it is redacted in trace payloads.

## Static checks

`telo check` treats the guard like any other dispatch site:

- `inputs:` is checked against the guard's declared `inputType` — a misspelled key is `CONTRACT_INPUTS_MISMATCH`.
- CEL in `inputs:` and `catches:` is typed against the guard's `request` context — reaching for `request.body` is `CEL_UNKNOWN_FIELD`.
- Every code the guard can throw must be rendered by `guard.catches` or the server's `catches:` — otherwise `UNCOVERED_THROW_CODE`.
