---
"@telorun/http-server": minor
---

`Http.Server` emits its own access record instead of passing Fastify's through, so the log is the kind's contract rather than one framework's prose — which is what lets a Rust or Go implementation of the kind produce records a single consumer can read.

Each record carries an `event_name` (`http.server.started`, `http.server.request`, `http.server.request.started`, `http.server.stopped`); consumers key on that, never on the message text. Attributes follow OpenTelemetry conventions: `http.route` (the low-cardinality matched template) rather than `url.path`, and `http.server.request.duration` in seconds.

Behaviour changes worth knowing about:

- **One `info` record per request** on completion, instead of Fastify's two. The received-side record moves to `debug`, where it still catches a request that hangs and never completes.
- **Severity follows the response** — `info`, except a 5xx which is `error`.
- **A mount entry may carry `logging.level`**, so a health endpoint polled every second, or a static mount serving a built SPA, can go quiet (`level: warn`) while the rest of the server keeps logging. The import-scoped threshold cannot express this: one server is a single resource in a single scope. A quietened mount still reports its own 500, because that is logged at `error`.
- **`http.route` is omitted when no route matched.** Falling back to the concrete URL let an unauthenticated 404 scan write unbounded cardinality into the `info`-level attribute dashboards group on; OpenTelemetry requires omission when there is no match.
- **`http.server.stopped` is emitted only for a server that actually listened**, so a consumer pairing start with stop never sees an unmatched close.
- **`url.scheme` reports the socket**, not `baseUrl` — the advertised URL is routinely `https://` behind a TLS terminator while the socket is plaintext.

The Telo-backed logger adapter is now injected unconditionally. Gating it on `info` handed Fastify its null logger at `level: warn` and silently dropped every diagnostic Fastify owns — its error-handler failures, reply-send failures and aborted-request hooks — which are exactly the records `warn` is meant to keep.
