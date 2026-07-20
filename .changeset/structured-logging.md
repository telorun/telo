---
"@telorun/sdk": minor
"@telorun/kernel": minor
"@telorun/analyzer": minor
"@telorun/cli": minor
"@telorun/debug-wire": minor
"@telorun/http-server": minor
---

Implement the structured logging specification (`kernel/specs/logging.md`).

Records carry an OTel severity number, a message, structured attributes, the
emitting resource's identity, its import-alias scope, and the active dispatch
span's trace and span ids — all attached automatically. Controllers emit through
the new ambient `ctx.log`.

Logging is configured by a `logging:` block on the root `Telo.Application`:
`level`, `attributes`, `redact`, `sampling`, and a `sinks:` list of ref-or-inline
entries. `Telo.ConsoleSink` and `Telo.FileSink` are kernel built-ins resolvable
without an import; omitting `sinks:` yields exactly one console sink, so the
zero-config case stays "pretty on a terminal, JSON when piped". An `imports:`
entry may carry its own `logging:` block to raise verbosity for that dependency's
subtree; config cascades and may be narrowed at each hop. There is no
`TELO_LOG_*` variable and no logging CLI flag — a level derived from the host
environment goes through a `variables:` entry read with `!cel`.

New `Telo.Sink` capability and `Telo.LogSink` abstract, so the sink set is open
to the ecosystem: a third party ships a sink by publishing a module whose kind
extends `Telo.LogSink`. The new `std/otlp` module does exactly that.

Behaviour changes:

- The CLI now honours `NO_COLOR` and implements the spec's full color-precedence
  order. `FORCE_COLOR=0` disables color rather than enabling it.
- `TracePayload.spanId` / `parentSpanId` on the debug wire are now 16-character
  lowercase hex strings rather than numeric counters, matching the ids log
  records carry. The internal counter is unchanged; hex is rendered only at the
  encoding boundary and is salted per process so two services in one distributed
  trace cannot mint the same id.
- `Http.Server`'s `logger:` field now means "enable request logging" rather than
  being a raw Fastify passthrough. Fastify's Pino instance is replaced with a
  Telo-backed adapter, so request records inherit the root `logging:` block's
  level, encoding, redaction, and sinks.
- The kernel no longer writes diagnostics to `process.stderr` or `console.*`;
  everything routes through the logger. The ad-hoc `TELO_BUNDLE_DEBUG` env var is
  replaced by ordinary trace-level records.
- `on_full: block` and invalid redaction paths are now caught by `telo check`
  (static analysis), not only at boot — `on_full: block` is unimplementable on a
  single-threaded runtime and a bad redaction path would otherwise silently fail
  to redact. Both remain enforced at runtime as a backstop.

Two pre-existing bugs fixed along the way:

- A CEL expression feeding **any** enum-constrained field produced a spurious
  `SCHEMA_VIOLATION`, because the placeholder substituted for the expression
  satisfied `type` but violated `enum`. Fixed in both the analyzer and the
  kernel.
- `teardownResources` aborted the whole cascade on the first throwing resource,
  with no aggregation and no reporting. Failures are now collected into
  `ERR_TEARDOWN_FAILED` so one bad teardown cannot skip the rest — including the
  log sinks, which are pinned to tear down last.
- The inline `imports:` desugaring silently dropped unknown entry fields, so a
  per-import `logging:` block never reached the import controller.
