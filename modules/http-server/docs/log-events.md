# Log events

`Http.Server` emits a fixed set of log events. This is a **contract of the kind,
not of the Node implementation**: the same `Telo.Definition` can carry a
`pkg:cargo` controller beside the `pkg:telo/local/js` one, and both must produce
records a single consumer can read.

What is normative here is the **`event_name` and the attributes**. The message
text is not: it is human prose, it differs per framework, and nothing should
match on it.

## Events

| `event_name` | Severity | When | Attributes |
| --- | --- | --- | --- |
| `http.server.started` | `info` | the socket is accepting connections | `server.address`, `server.port`, `url.scheme` |
| `http.server.request.started` | `debug` | a request has been received | `http.request.method`, `http.route`, `url.path`, `httpserver.request_id` |
| `http.server.request` | `info`, or `error` for a 5xx | the response has been sent | `http.request.method`, `http.route`, `http.response.status_code`, `http.server.request.duration`, `httpserver.request_id` |
| `http.server.stopped` | `info` | the server has closed | `server.address`, `server.port` |

All attribute names are OpenTelemetry semantic conventions except
`httpserver.request_id`, for which OTel defines no equivalent — request
correlation is normally `trace_id` / `span_id`, and those are attached
automatically when a span is active, but tracing is off by default, so a
per-request id is the only correlator a default configuration has.

`http.server.request.duration` is **seconds, as a double** — OTel's unit for that
name. A framework that measures in milliseconds converts.

## Why one record per request

The access record is emitted on **completion**, once, which is what every access
log does (nginx, Caddy, `tower-http`). A received-side record carries no outcome
and would double the default-visible volume, so it is `debug` — where it still
earns its place for the one case the completion record cannot cover: a request
that **hangs** and never completes otherwise leaves no trace at all.

## Why `http.route` and not `url.path`

`http.route` is the matched template (`/todos/:id`). It is low-cardinality, which
is what an access log is aggregated on, and it is what OTel requires on server
spans. `url.path` is the concrete path, so it carries ids — higher cardinality
and a mild PII vector in a record that is on by default. It rides at `debug`.

## Severity follows the status

A response is `info`, except a **5xx**, which is `error`. A 500 is not the same
class of event as a 200, and it is also what makes quietening a mount safe (see
below) rather than a way to go blind on the path that just started failing.

**4xx stays `info` on purpose.** A 404 or a 401 is ordinary traffic; promoting it
would make a scanner walking random URLs read as an incident.

## Turning it off

There is no `logger:` field. For the **whole server**, request logging follows
the resolved scope threshold — the access record is `info`, so raising the import
to `level: warn` silences it while keeping the server's error records (including
the ones the underlying framework reports about itself):

```yaml
imports:
  Http:
    source: oci://ghcr.io/telorun/http-server@0.10.0
    logging:
      level: warn
```

### Per mount

That threshold governs a whole module instance, and one `Http.Server` is a single
resource in a single scope — so it cannot quieten `/health` while leaving `/api`
alone. A mount entry takes its own `logging.level` for exactly that:

```yaml
mounts:
  - path: /health
    mount: !ref Health
    logging:
      level: warn        # a healthy poll leaves no record
  - path: /api
    mount: !ref Api      # unchanged: follows the scope threshold
```

Access records are `info`, so **`warn` is how a mount goes quiet.** It is a
level rather than a boolean, so it also works in the other direction — put
`debug` on one mount you are investigating and leave the rest at `info`.

A **5xx from a quietened mount still surfaces**, because it is logged at `error`.
That is what makes this safe to reach for on a health check: you stop hearing
about the polling, not about the endpoint failing.

The same applies to an `Http.Static` mount serving a built SPA, which otherwise
emits a record per asset.

**What it gates:** only the records the *server* emits for that mount — the
request and request-received records. A handler's own records follow its own
module's level, so a `Sql.Command` debug line inside a quietened health check is
unaffected. Gating a request's whole dynamic extent would need a per-invocation
threshold override; it is a compatible extension if it is ever wanted.

## Implementing this kind in another language

Register the equivalent middleware and emit the same four events:

- **Rust** — a `tower` layer, or `axum`'s `TraceLayer` with its own `on_response`.
- **Go** — an `http.Handler` wrapper around the mux.

Both cases follow the same rule as the Node controller: **disable the
framework's own request logging** and emit from the middleware, so the record's
shape is this kind's contract rather than the framework's.
