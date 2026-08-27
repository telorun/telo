---
slug: /build/logging
description: "Structured logging in Telo: levels, choosing sinks and their durability, per-dependency verbosity, redaction, sampling, emitting from a controller, and shipping records to OTLP."
---

# Logging

Telo emits **structured log records**, not text lines. Every record carries a
severity, a message, structured attributes, the resource that produced it, and —
when it was emitted inside a dispatch — the trace and span it belongs to. All of
that is attached automatically; a controller just calls `ctx.log`.

Logging is configured entirely from the manifest.

## Zero configuration

An app with no `logging:` block still logs. The runtime behaves exactly as if a
single console sink were declared: pretty output on a terminal, JSON when piped
or redirected.

```
12:34:56.789 INFO  Http.Server.api  listening  net.host.port=8080
```

## Setting a level

```yaml
kind: Telo.Application
metadata:
  name: my-app
logging:
  level: debug
```

Six levels are nameable: `trace`, `debug`, `info` (the default), `warn`, `error`,
`fatal`.

`fatal` does **not** exit the process. Severity is a data field, never control
flow — it does trigger an immediate flush, so a fatal record is durable on the
console and file sinks by the time the call returns.

### Reading the level from the environment

Declare a variable and reference it. This is the only supported path, and it
keeps the value visible to `telo check` and to the editor:

```yaml
variables:
  logLevel:
    env: LOG_LEVEL
    type: string
    default: info
logging:
  level: !cel "variables.logLevel"
```

## Choosing where records go

`logging.sinks` is a list. Each entry is either an inline definition or a `!ref`
to a sink declared elsewhere — the same ref-or-inline shape used everywhere else
a resource is accepted.

```yaml
logging:
  level: info
  sinks:
    - kind: Telo.ConsoleSink
      encoding: auto          # auto | pretty | json
      color: auto             # auto | always | never
    - kind: Telo.FileSink
      destination: /var/log/my-app.jsonl
      level: warn             # this sink only
      on_full: drop_new       # drop_new | drop_old
```

`Telo.ConsoleSink` and `Telo.FileSink` are kernel built-ins — no import needed.

A sink's `level` filters at fan-out, after the record exists. The level that
decides whether a record is *created* is the most verbose level across all
enabled sinks, so "everything to the audit file, warnings only to the console"
works: the record is built once and offered to each sink.

`encoding: auto` is decided per sink destination, not per process — a console
sink on `stdout` and another on `stderr` can resolve differently.

### Colour from the environment

`color: auto` (the default) consults the environment, in this order:
`NO_COLOR` → `FORCE_COLOR` → `CLICOLOR_FORCE` → `CLICOLOR` → `TERM` →
`isatty()`. `always` and `never` override all of it.

The Telo CLI honours **`CLICOLOR_FORCE`** directly — it is the convention with
the widest native reach across ecosystems, so one variable serves a Rust, Go or
Node workload alike. Node's own colour libraries (`supports-color`, and therefore
chalk) read `FORCE_COLOR` and ignore it, so the CLI bridges the two for its own
ecosystem: on start, before any library has computed a colour level, it sets
`FORCE_COLOR` when `CLICOLOR_FORCE` is present and `FORCE_COLOR` is not.

An existing `FORCE_COLOR` is never overwritten, which is what lets
`FORCE_COLOR=0` alongside `CLICOLOR_FORCE=1` mean "off for Node, forced for
everything else".

### Buffered sinks and durability

Asynchronous sinks are bounded. `on_full` states what happens when the buffer
saturates:

| Value | Behaviour |
|---|---|
| `drop_new` (default) | Drop the incoming record. |
| `drop_old` | Ring buffer — evict the oldest. |
| `block` | Suspend the producer until the buffer drains. |

**`block` is rejected at load on Node.js.** Blocking the producer on a
single-threaded event loop also suspends the writer, so it would deadlock rather
than provide durability. Telo fails with a diagnostic naming the sink instead of
silently giving you `drop_new` — the opposite of the guarantee you asked for.

Every drop is counted. When drops stop, one `warn` record reports the count and
the cause; nothing is ever discarded silently.

## Raising verbosity for one dependency

Attach the override to the **import**, not to a name:

```yaml
logging:
  level: info          # app-wide default
imports:
  Db:
    source: oci://ghcr.io/telorun/sql@<version>
    logging:
      level: debug     # this import's subtree only
  Api:
    source: ./api
```

Config cascades and can be narrowed at each hop, so raising `Api` lifts
everything beneath it without editing `Api`'s manifest.

Overrides attach to imports because module names are not unique —
`ghcr.io/telorun/sql` and `ghcr.io/acme/sql` are both named `sql`, and the same module imported twice is two
subsystems sharing one name. Import aliases are already unique.

Every record carries the `scope` that selected its threshold, so the path on a
log line is exactly the path you write to change that instance's level:

```json
{ "level": "DEBUG", "msg": "query", "module": "sql", "scope": "Api.Db" }
```

Imports may set `level`, `redact`, and `sampling`. They may **not** declare
`sinks` — sinks are process-level I/O owned by the root Application, and a
library opening a log file on its importer's behalf would be a side effect
nobody authorized.

This is also how you control a server's per-request access logs. `Http.Server`
emits its "incoming request" lines at `info`, so they appear by default and are
silenced by raising the module's import to `warn` — which keeps the server's own
`error`/`warn` diagnostics while dropping the access noise, and skips the
per-request work entirely rather than building a record and discarding it:

```yaml
imports:
  Http:
    source: oci://ghcr.io/telorun/http-server
    logging:
      level: warn   # server errors only, no per-request access logs
```

## Redaction

Values bound to `secrets:` are redacted automatically, with no configuration.
Beyond that, name paths explicitly:

```yaml
logging:
  redact:
    paths:
      - request.headers.authorization
      - items[*].tokens[*].value
    censor: "[redacted]"
```

Paths support dot notation, bracket notation (`a["b-c"]`), and wildcards —
including more than one per path. The key is always preserved and only the value
replaced, so a reader can still tell the field was present.

Redaction runs before serialization and before any sink sees the record. Bad
paths are caught by `telo check`, not at runtime.

Request and response headers are **not** captured by default; capturing them
requires configuration naming the headers.

## Sampling

Off by default. When enabled, a repeated message throttles within each window:

```yaml
logging:
  sampling:
    first: 100        # emit the first 100 per window
    thereafter: 100   # then every 100th
    tick: 1s
```

Records at `error` and above are never sampled by default. Sampled records are
counted like any other drop.

## Emitting from a controller

```ts
ctx.log.info("listening", { "net.host.port": 8080 });
ctx.log.error("upstream failed", { "http.response.status_code": 502 }, { error: err });
```

Guard an expensive call so its arguments are never evaluated:

```ts
if (ctx.log.enabled(SEVERITY.debug)) {
  ctx.log.debug("state", { snapshot: expensiveToRender() });
}
```

**When to guard.** The standard library follows one rule: *guard a `debug` call
when it sits on a per-operation path **and** builds arguments.* A call that
passes no attributes allocates nothing, so a guard there only adds a second
threshold check; a per-request or per-statement call that builds an attribute
object allocates on every operation whether or not anything is listening. A
lifecycle event that happens once per connection or per token refresh is not a
per-operation path and needs no guard.

### Choosing a level

The standard library's convention, worth following in a third-party module:

| Level | For |
|---|---|
| `info` | Something a default-configured operator needs: a schema migration, a token refresh, an at-most-once replay that suppressed a body, metered usage. |
| `debug` | The routine per-operation outcome — a cache hit, an allowed request, a statement, a lease acquire/release. |
| `warn` | Degraded but continuing: a swallowed failure, a fail-closed default, an infrastructure write that failed. |
| `error` | A failure the caller cannot see, or an invariant break that must outlive the caller's error handling. |

The load test for `info` is the one worth applying deliberately: **if the record
scales with request volume, it belongs at `debug`.** Sampling is off by default,
so nothing bounds an `info` on a hot path — a rate limiter logging every
rejection at `info` turns the log into the amplifier the limiter exists to
prevent.

The deliberate exception is an **access log**, where the record *is* the primary
artifact rather than a decision taken inside one. `Http.Server` logs a line per
request at `info` for that reason (an error response at `error`), and it is
switched off the same way as anything else — by raising that import's level to
`warn`. The distinction is whether the record describes the operation itself or
something the operation decided along the way.

Bind attributes once with `ctx.log.with({ component: "db" })` — record
attributes win over bound ones.

### Attribute keys

Follow OpenTelemetry semantic conventions where one exists
(`http.request.method`, `db.query.text`, `file.path`, `process.exit.code`).

Two rules keep that honest:

- **Use OpenTelemetry's name whenever OpenTelemetry names the concept — and its
  unit with it.** This holds regardless of which signal the convention was
  written for: metric names and attribute keys are separate namespaces, so
  `db.client.operation.duration` on a record is fine. What is *not* fine is that
  name carrying a different magnitude. OTel durations are **seconds, as a
  double**, so a millisecond value under one of those names is wrong by 1000×
  to every consumer that knows the convention.
- **Never put a unit in a key.** The unit belongs to the convention, which is
  why it is `…request.duration`, not `…request.duration_ms`. A `_ms` suffix is a
  sign the name is invented.
- **Never invent a key inside a namespace OpenTelemetry owns.** Where OTel names
  nothing — `ai.agent.steps`, `sql.migration.name`, `httpserver.request_id`,
  `cache.key` — use the module's own prefix rather than borrowing `gen_ai.*`,
  `db.*` or `http.*` for something they do not define.
- **Don't reuse a convention whose meaning you cannot honour.** `url.full` means
  the absolute URL; publishing a query-stripped value under it hands a consumer
  something that silently differs from the request made. Use the attributes that
  are accurate (`server.address`, `url.path`), or a module-scoped key.

The `telo.*` namespace is reserved for the runtime.

### Naming an event

A record's **message is prose and nothing should ever match on it** — it is the
one field that differs between a Node, Rust or Go implementation of the same
kind, because it usually comes from whatever library is underneath.

When a record represents a *class* of event rather than a one-off line, name it
with `eventName`. That is the stable key a consumer, a test, or a dashboard
keys on, and it is what lets two implementations of one kind be read by the
same consumer:

```ts
ctx.log.info("Request completed", attributes, { eventName: "http.server.request" });
```

`Http.Server` is the worked example — `http.server.started`,
`http.server.request`, `http.server.request.started`, `http.server.stopped`.
A second implementation of that kind emits the same four names with the same
attributes from its own framework's middleware, and every message string may
differ without any consumer noticing.

A controller emits diagnostics only through `ctx.log`. Writing to stdout as
*data* — what the `Console` module does — is a separate concern and is
unaffected.

## Shipping records elsewhere

Any module can publish a sink. The `otlp` module exports records to an OpenTelemetry
collector:

```yaml
imports:
  Otlp: oci://ghcr.io/telorun/otlp@<version>
secrets:
  collectorToken:
    env: OTLP_TOKEN
    type: string
logging:
  sinks:
    - kind: Telo.ConsoleSink
    - !ref shipped
---
kind: Otlp.Sink
metadata:
  name: shipped
endpoint: https://collector.example.com/v1/logs
headers:
  authorization: !cel "'Bearer ' + secrets.collectorToken"
```

An OTLP sink cannot be flushed synchronously — delivery is a network round-trip.
A `fatal` record's flush is initiated but not awaited, so records held only there
may be lost if the process dies immediately after. Use a file sink when you need
audit durability.

## Reference

The normative contract is [`kernel/specs/logging.md`](https://github.com/telorun/telo/blob/main/kernel/specs/logging.md).
It defines the record model, the severity scale, sink behaviour, the encodings,
and the conformance vectors every Telo runtime must pass.
