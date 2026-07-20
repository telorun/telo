# Structured logging — Node.js kernel implementation

Implements `kernel/specs/logging.md` (v1.0) in full. The spec is the requirements
document; this plan covers architecture, placement, and the decisions the spec
leaves to the runtime.

## Problem

Telo has three inconsistent diagnostic paths — `this.stderr`, raw
`process.stderr`, and one stray `console.warn` — that bypass each other. A nested
kernel cannot capture its children's output, controllers have no structured
logger, and nothing correlates a diagnostic with the dispatch span that produced
it. The spec defines a conformance contract every Telo runtime must implement
identically; nothing implements it yet.

## Solution

**Pipeline core** lives in `kernel/nodejs/src/logging/` — record model, severity
scale, the `json` / `pretty` / `otlp` encoders, sampling, drop accounting, and
the sink fan-out. The logger is ambient, reached as `ctx.log`, with the interface
declared in `sdk/nodejs/src` beside the other capability contracts.

**The redaction path grammar and parser are browser-safe** and live in
`analyzer/nodejs/src`, re-imported by the kernel — the same split already used
for eval-path handling, so `telo check` and the runtime share one source of
truth. §14.1 requires a hand-written parser over a closed grammar; nothing is
compiled from source.

**Kind registration** is a single edit site: `analyzer/nodejs/src/builtins.ts`
holds the `Telo.Application` / `Telo.Library` / `Telo.Import` schemas as ordinary
definitions, which the kernel seeds from the registry. The root `logging:` block,
the per-import `logging:` block, the new `Telo.Sink` capability, and the
`Telo.LogSink` / `Telo.ConsoleSink` / `Telo.FileSink` built-ins all land there.
Library roots reject `logging:` for free — their schema is
`additionalProperties: false`. Sink controllers live in
`kernel/nodejs/src/controllers/logging/`, mirroring the existing controller
directories.

**Inline sinks** require inline-resource extraction to reach the root document.
Rather than unblocking `Telo.Application` wholesale, `reference-field-map.ts`
carries a per-slot annotation on each ref entry and
`normalize-inline-resources.ts` extracts only from opted-in slots. `targets`
keeps its deliberate rejection of unnamed inline definitions.

**Scope resolution** mirrors `setControllerPolicy` in `import-controller.ts`: an
import's effective logging config is merged over its parent's once, at import
time, and stamped on the child `ModuleContext` as a plain scalar threshold. No
per-record lookup, no chain walk. Automatic secret redaction reuses
`EvaluationContext._secretValues`, which already collects and cascades down the
same graph.

**Lifecycle.** An internal console writer covers process start through manifest
validation. Declared dependency-free sinks attach as soon as the `logging:` block
validates, before `loadModule`; every other sink attaches when it initializes,
with bootstrap records replayed in order. Nothing instantiates on the
`analyzeOnly` path. Sinks flush inside their own `teardown()`, pinned to run
after all other root resources — which requires an explicit teardown-ordering
field, since today's order is reverse *insertion* order and the multi-pass init
retry loop makes that diverge from topological rank.

**Beyond the kernel:** the CLI gains the §11.2 color precedence including
`NO_COLOR` and drops its private TTY logic; `packages/debug-wire` gains the
`record` frame, the companion JSON Schema, and hex span ids; `modules/http-server`
replaces Fastify's Pino instance with a Telo-backed adapter and reshapes its
`logger:` field to "enable request logging"; an `Otlp.Sink` module exercises the
`otlp` encoding. `sdk/rust` implements the logger under both existing feature
flags — `native` as a full host implementation, `napi` as the §9 boundary path.
The four `process.stderr` leak sites, the stray `console.warn`, and the ad-hoc
`TELO_BUNDLE_DEBUG` flag are all migrated onto the logger.

Conformance test vectors 1–18 ship with the implementation; vector 18's golden
records live beside the spec as shared cross-language fixture data, following the
precedent of `wire-schema.json`. Module docs, the Docusaurus wiring, the
authoring-agent system prompt, changesets, and changie fragments are part of this
change, not a follow-up.

## Decisions

- **Inline extraction is slot-scoped, driven by a schema annotation** — rejected
  removing `Telo.Application` from the system-kind exclusion, which would have
  silently converted two deliberate `targets` rejections into working features,
  since normalization runs upstream of AJV on both paths and the runtime path has
  no schema gate at all.
- **`Telo.Sink` is a new capability; `Telo.LogSink` is an abstract carrying the
  log-specific fields** — keeps the lifecycle contract payload-opaque so a future
  `Telo.TraceSink` reuses it. Rejected collapsing the two (couples the contract to
  logging) and rejected reusing `Telo.Mount` (its "mounted into a Service"
  semantics do not describe a sink). Scoped to record-stream sinks; metrics
  aggregate rather than stream and are explicitly not covered.
- **The bootstrap writer covers pre-validation, not eager sinks** — declared sinks
  cannot instantiate before the block that declares them is validated, so §12.3's
  internal writer is what makes D3 hold.
- **Sinks flush in their own teardown, pinned last** — keeps them ordinary
  resources rather than carving them out of the lifecycle. Requires a real
  ordering mechanism; a dependency-graph trick would not survive the retry loop.
- **Teardown gains error aggregation and a per-resource bound** — today the first
  throw aborts the cascade, so any failing resource would leave sinks unflushed.
  Forced by §8.4 and §10.5, not optional polish.
- **`on_full: block` is rejected at load with the §10.3 diagnostic** — a
  single-threaded event loop cannot drain while the producer is suspended.
  Silently degrading to `drop_new` would hand back the opposite durability
  guarantee from the one requested.
- **Nanosecond timestamps are formatted, not resolved** — Node's best wall clock
  is `performance.timeOrigin` plus `performance.now()`, so values carry
  microsecond resolution zero-padded to nine digits. Format-conformant; the
  golden-file vector is unaffected.
- **All four spec-flagged changes are in** — `NO_COLOR`, the `Http.Server.logger`
  schema reshape, `TracePayload.spanId` as 16-hex, and `[secret]` → `[redacted]`.
  Leaving logs and traces spelling the same id differently was not worth carrying.

## Example after the change

```yaml
kind: Telo.Application
metadata:
  name: my-app
variables:
  logLevel:
    env: LOG_LEVEL
    type: string
    default: info
logging:
  level: !cel "variables.logLevel"
  attributes:
    service.name: my-app
  redact:
    paths:
      - request.headers.authorization
      - items[*].tokens[*].value
  sinks:
    - kind: Telo.ConsoleSink
      encoding: auto
      color: auto
    - kind: Telo.FileSink
      destination: /var/log/my-app.jsonl
      level: warn
      on_full: drop_new
imports:
  Db:
    source: std/sql@1.2.0
    logging:
      level: debug
  Api:
    source: ./api
```

Omitting `sinks:` yields exactly one `Telo.ConsoleSink` — pretty on a terminal,
JSON when piped. A controller emits through `ctx.log`, and the record carries its
resource identity, module, import-alias scope, and the active span's trace and
span ids automatically.
