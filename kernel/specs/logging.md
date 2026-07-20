---
description: "v1.0 spec: the language-neutral structured logging contract every Telo runtime implements — OTel-aligned record model, severity scale, sinks, redaction, and encodings"
---

# Telo Logging Specification (v1.0)

## 0. Status, scope, and how to read this

This is a **runtime conformance specification**. It defines the logging contract
that every Telo runtime — Node.js today, Rust and Go later — must implement
identically, so that a controller written in any language produces records a
single consumer can read.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**,
**MAY**, and **RECOMMENDED** are to be interpreted as described in RFC 2119.

**In scope:** the log record model, the severity scale and its cross-language
mapping, the logger API surface, sink behaviour (buffering, drop policy, flush),
redaction, sampling, the JSON and console encodings, and configuration.

**Out of scope:** metrics, and the OTLP *exporter* implementation. This spec is
designed so an OTLP exporter is a pure sink addition with no model change — that
is a deliberate constraint on the design, not a deferred decision about it.

**Relationship to tracing.** Dispatch tracing already ships (see
`kernel/nodejs/plans/generic-dispatch-tracing.md`): every `invoke` / `run` /
`provide` / `request` dispatch opens a span carrying a `traceId` and span ids.
This spec does **not** redefine tracing. It defines how a log record *correlates*
with an active span (§7) and requires that correlation be automatic.

**Supersedes.** `kernel/specs/telemetry-and-observability.md` describes an
unimplemented "ambient telemetry injection" design whose manifest syntax predates
the current surface (it uses `config:` wrappers, `dependsOn`, and the inline
`${{ }}` string form that the formatter now mangles). Where the two disagree,
**this document governs for logging**. That file should be rewritten to cover
tracing and metrics only, or removed; this spec does not itself delete it.

---

## 1. Decisions taken

These were resolved by the spec author, not by ecosystem precedent. They are the
cheapest things to override — each is localized to the section named.

| # | Decision | Rationale | Override cost |
|---|---|---|---|
| D1 | **Logger core → pluggable sinks.** The debug wire is *one sink*, not the pipeline. | Logging MUST work when tracing is off and no debug consumer is attached; the event bus short-circuits to zero cost with no subscribers, so it cannot carry logs. | §10 only |
| D2 | **One logger, console sink is the default.** The three inconsistent kernel stderr targets are normalized onto it. | Today `process.stderr`, `Kernel.stderr`, and a stray `console.warn` all bypass each other; a nested kernel cannot capture its own children's output. | §10, §11 |
| D3 | **The logger is ambient (`ctx.log`), but sinks are resources.** | The logger must work before any resource initializes, so it cannot itself depend on resource wiring — mirroring the already-ambient `openSpan`. Sinks have no such constraint: an internal bootstrap writer covers the pre-manifest window, so declared sinks can attach later and have records replayed. | §8, §10.2, §12 |
| D4 | **Message is a string**, not OTel's structured `Body`. | Matches slog/pino/zap and keeps the console encoding total. Structured data goes in attributes. Deviation from OTel is noted in §4. | §4 |
| D5 | **Severity never implies control flow.** `fatal` does not exit. | zap's `Fatal` calls `os.Exit(1)`; Rust's `tracing` has no FATAL at all. Making severity a pure data field is the only portable choice. | §5 |
| D6 | **The manifest is the only configuration source.** No `TELO_LOG_*` variables, no logging CLI flags. | Telo already binds env values declaratively via `variables:` + `env:` + `!cel`. A parallel env path would be invisible to the analyzer and the editor, and would route around the host-env guardrail. | §12.3 |
| D7 | **Span ids are 16 lowercase hex on the wire, a salted `u64` internally.** | Satisfies W3C/OTLP without cost: minting stays an increment, hex is rendered only at the encoding boundary, and an 8-byte process salt prevents cross-process collisions in a distributed trace. | §7.1 |
| D8 | **Third-party loggers are replaced, not bridged**, wherever the library accepts an injected logger. | Replacement produces Telo records at the source; bridging re-parses text the library already structured. Fastify accepts injection, so `http-server` is a replacement case. | §13.3 |
| D9 | **Scoped thresholds attach to the `imports:` entry**, not to a map keyed by module name. | Module names collide (two namespaces, repeat imports, transitive imports); import aliases are already uniqueness-enforced. Also resolves to a per-context scalar at load, feeding D-§9's guest cache directly. | §12.2 |
| D10 | **Sinks are resource kinds extending `Telo.LogSink`, listed as ref-or-inline entries at the root only.** | Keeps the backend set open to the ecosystem and lets a sink depend on secrets / HTTP clients / retry policies the resource graph already models. A list, not a keyed map, because root-only sinks are never merged. Root-only because sinks are process-level I/O an imported library must not open on its importer's behalf. | §10.2, §12.1, §12.2 |
| D11 | **Mandatory sinks live in the kernel; optional backends are modules.** | §16 already requires `console` + `file` + `pretty` + `json` of every conforming runtime, so shipping them as an installable module would make conformance depend on installation. `Otlp.Sink` is optional and needs wiring, so it is a module. | §10.2 |

**Flagged for review** (consequences beyond this spec):

- **Trace wire format (§7.1).** Log records now carry hex span ids, but
  `TracePayload.spanId` remains a `number`. Until the trace wire format follows,
  the two spell the same id differently. Aligning it is a breaking change to
  `wire-schema.json` and is not attempted here.
- **`NO_COLOR` (§11.2).** The existing CLI honours `FORCE_COLOR` /
  `CLICOLOR_FORCE` but not `NO_COLOR`. This spec requires it. Behaviour change.
- **`Http.Server.logger` (§13.3).** The field is removed, not reshaped: request
  logging is derived from the resolved scope threshold rather than a per-server
  boolean — a schema change to that module.
- **Redaction token (§14).** This spec mandates `"[redacted]"`. Trace-context
  masking already uses `"[secret]"`. Aligning them is recommended but not
  required here.

---

## 2. Design principles

1. **OpenTelemetry is the logical model, not the wire format.** The record model
   in §4 maps 1:1 onto an OTel `LogRecord`. The *spelling* of that model on the
   wire is a swappable encoding profile (§11), because the ecosystems agree on
   semantics far more than on key names.
2. **Severity is a number.** All comparison, filtering, and threshold logic uses
   `severity_number`. Severity *text* is presentation only.
3. **Nothing is silently lost.** Every drop, truncation, and sink failure MUST be
   counted and surfaced (§10.4). A logger that quietly discards records is
   non-conformant.
4. **Zero cost when disabled.** A suppressed record MUST NOT allocate, format, or
   serialize (§9).
5. **Logging never breaks the application.** A logging call MUST NOT throw, and a
   sink failure MUST NOT propagate to the caller (§8.4).

---

## 3. Terminology

| Term | Meaning |
|---|---|
| **Record** | One structured log entry — the unit this spec defines (§4). |
| **Logger** | The object a controller calls to emit records (§8). |
| **Sink** | A destination a record is written to — console, debug wire, file, OTLP (§10). |
| **Encoding** | How a record is serialized for a sink — `pretty`, `json`, `otlp` (§11). |
| **Host runtime** | The process running the kernel (Node.js today). |
| **Guest runtime** | A controller in another language reached over an FFI/IPC boundary (Rust via N-API today). |
| **Threshold** | The minimum `severity_number` a record must meet to be emitted. |

---

## 4. The log record model

A record is the following logical structure. Encodings (§11) determine spelling;
they MUST NOT add or remove semantics.

| Field | Type | Req. | Description |
|---|---|---|---|
| `timestamp` | uint64 ns since Unix epoch | REQUIRED | When the event occurred, by the origin clock. |
| `observed_timestamp` | uint64 ns since Unix epoch | OPTIONAL | When the runtime observed it. SHOULD be set when it differs from `timestamp` (e.g. a bridged third-party logger, §13.3). |
| `severity_number` | integer 1–24 | REQUIRED | See §5. `0` (UNSPECIFIED) MUST NOT be emitted by a Telo runtime. |
| `severity_text` | string | REQUIRED | Canonical short name (`TRACE`…`FATAL`), or the original source spelling when bridging (§13.3). |
| `message` | string | REQUIRED | Human-readable. MAY be empty; MUST NOT be absent. |
| `attributes` | map<string, AnyValue> | OPTIONAL | Structured per-occurrence data (§6). |
| `trace_id` | 32 lowercase hex chars | OPTIONAL | §7. |
| `span_id` | 16 lowercase hex chars | OPTIONAL | §7. If present, `trace_id` MUST also be present. |
| `trace_flags` | uint8 | OPTIONAL | Bit 0 = sampled. Bit 1 is reserved (§7.5). Bits 2–7 MUST be zero. |
| `resource` | ResourceRef | OPTIONAL | The emitting Telo resource: `{ kind, name, id }` (§7.3). |
| `module` | string | OPTIONAL | Module name of the emitter (`sql`). Not unique — see `scope`. |
| `scope` | string | OPTIONAL | Dotted import-alias path identifying *which instance* emitted the record (`Api.Domain.Db`). Absent for the root Application's own resources. |
| `event_name` | string | OPTIONAL | Identifies a class of event; max 256 chars. Bridges to the kernel event bus. |
| `error` | ErrorValue | OPTIONAL | Structured error (§4.2). |
| `dropped_attributes_count` | uint32 | OPTIONAL | Non-zero when limits (§6.3) truncated attributes. MUST be emitted when non-zero. |

### 4.1 Deviation from OTel: `message` is a string (D4)

OTel's `Body` is an `AnyValue` and MAY be structured. Telo requires a string
message and routes structured data to `attributes`. This keeps the console
encoding total (every record has a renderable headline) and matches slog, pino,
and zap. An OTLP exporter MUST map `message` → `Body` as a string value.

### 4.2 ErrorValue

A record carrying an error MUST represent it as:

| Field | Type | Req. |
|---|---|---|
| `type` | string | REQUIRED — error class/code (e.g. `ERR_INVOKE_CANCELLED`). |
| `message` | string | REQUIRED |
| `stack` | string | OPTIONAL — multi-line, unmodified. |
| `cause` | ErrorValue | OPTIONAL — nested; runtimes MUST bound the chain (§6.3). |

Runtimes SHOULD additionally mirror these onto attributes using OTel exception
semantic conventions (`exception.type`, `exception.message`,
`exception.stacktrace`) when exporting to OTLP.

---

## 5. Severity

### 5.1 The canonical scale

Telo adopts the **OpenTelemetry `SeverityNumber`** scale (1–24, stable). Higher
is more severe. `severity_number >= 17` means the record describes an error —
this is the portable error predicate and runtimes SHOULD expose it.

Telo names six levels. The full 24-value range remains valid on the wire so that
bridged and imported records survive round-trips.

| Name | `severity_number` | `severity_text` |
|---|---|---|
| trace | 1 | `TRACE` |
| debug | 5 | `DEBUG` |
| info | 9 | `INFO` |
| warn | 13 | `WARN` |
| error | 17 | `ERROR` |
| fatal | 21 | `FATAL` |

Ranges: TRACE 1–4, DEBUG 5–8, INFO 9–12, WARN 13–16, ERROR 17–20, FATAL 21–24.

**Rules.**

- Comparison, filtering, and thresholds MUST use `severity_number`. A runtime
  MUST NOT compare `severity_text`.
- A record is emitted iff `severity_number >= threshold`.
- A level that cannot be mapped MUST be emitted as the nearest range floor with
  the **original spelling preserved in `severity_text`**, keeping the mapping
  reversible. Runtimes MUST NOT emit `severity_number: 0`.
- `fatal` MUST NOT terminate the process, flush-and-exit, panic, or alter control
  flow in any way (D5). It MUST trigger an immediate flush, synchronous where the
  sink supports it and best-effort otherwise (§10.5).

### 5.2 Cross-language mapping

Go's `log/slog` documents that subtracting 9 from an OTel severity converts it to
the slog range. That relation is **exact and officially sanctioned**, so a Go
runtime MUST use arithmetic rather than a table:

```
slog_level = severity_number - 9        // Debug -4, Info 0, Warn 4, Error 8
severity_number = slog_level + 9
```

Other runtimes use a lookup table:

| Telo | OTel | Go slog | Rust `tracing` | Node pino | zap |
|---|---|---|---|---|---|
| trace | 1 | −8 | `TRACE` | 10 | — |
| debug | 5 | −4 | `DEBUG` | 20 | `Debug` (−1) |
| info | 9 | 0 | `INFO` | 30 | `Info` (0) |
| warn | 13 | 4 | `WARN` | 40 | `Warn` (1) |
| error | 17 | 8 | `ERROR` | 50 | `Error` (2) |
| fatal | 21 | 12 | *(none)* | 60 | `Fatal` (5) |

**Per-language obligations.**

- **Rust.** `tracing` has no FATAL and orders levels *inversely* (`ERROR` is the
  lowest). A Rust runtime MUST NOT propagate that ordering into the record model;
  it MUST map FATAL to `tracing::Level::ERROR` while emitting
  `severity_number: 21`, so no severity is lost on the Telo side.
- **Go.** slog defines no TRACE or FATAL constant, but its scale is open, so the
  `−9` offset yields −8 and 12 naturally. Use them.
- **Node.** pino's scale is 10× and offset; no arithmetic relation exists. Use
  the table.

---

## 6. Attributes and `AnyValue`

### 6.1 The value type

An attribute value is an `AnyValue`, with exactly these variants:

`string` · `bool` · `int64` · `double` · `bytes` · `array<AnyValue>` ·
`map<string, AnyValue>` · *empty*

- `null` is a valid value and MUST be preserved.
- Empty values (empty string, empty array) are meaningful and MUST NOT be
  stripped.
- Arrays SHOULD be homogeneous. Heterogeneous arrays MUST NOT be used for
  attribute values destined for OTLP export.
- `bytes` MUST be offloaded to the blob store as a `WireBlob` pointer when the
  sink has one (the debug wire does). Otherwise it MUST be base64-encoded.
  Raw bytes MUST NOT be inlined into a text encoding.

> **Implementer warning.** OTLP/JSON's hex-instead-of-base64 rule applies to
> `traceId` and `spanId` **only**. Every other `bytes` field — including
> `AnyValue`'s `bytesValue` — falls back to the proto3 default and **is
> base64**. Over-applying hex encoding here is a silent interop break.

### 6.2 Naming

Attribute keys MUST be non-empty strings and are case-sensitive. They SHOULD
follow OTel semantic conventions: lowercase, dot-separated namespaces, snake_case
within each component (`http.request.method`, `db.system`).

Telo reserves the **`telo.*`** namespace:

| Key | Meaning |
|---|---|
| `telo.resource.kind` | Emitting resource's kind. |
| `telo.resource.name` | Emitting resource's name. |
| `telo.resource.id` | Full hierarchical id. |
| `telo.module` | Module scope. |
| `telo.capability` | `invoke` \| `run` \| `provide` \| `request`, when emitted inside a dispatch. |

Modules MUST NOT invent keys under an existing OTel namespace. Third-party keys
SHOULD use a reverse-domain prefix.

Where a standard OTel semantic convention exists, module controllers MUST use it
(`http.*`, `db.*`, `messaging.*`) rather than a Telo-specific spelling.

### 6.3 Limits

| Limit | Default | Behaviour on breach |
|---|---|---|
| Attribute count | 128 | Drop excess; increment `dropped_attributes_count`. |
| Attribute value length | unlimited | If configured, truncate and mark. |
| Nesting depth | 10 | Replace the over-deep subtree with `"[depth exceeded]"`. |
| Collection element count | 1000 | Truncate; record the original length. |
| Deferred-value resolution | 100 steps | Stop and substitute a diagnostic string. MUST NOT recurse unboundedly. |
| Error `cause` chain depth | 10 | Truncate; append a `cause` whose `message` records the truncation. |

Keys MUST be unique within a record; on collision the last write wins.

These caps are not optional hardening — they bound the blast radius of a
redaction miss and of a cyclic or pathological value graph. A runtime MUST apply
them by iteration with a bounded counter, never by unguarded recursion, and a
panic or exception raised inside a user-supplied deferred value MUST be caught
and rendered as a diagnostic string rather than propagated (§8.4).

---

## 7. Trace correlation

### 7.1 Identifier format

- `trace_id` — **32 lowercase hex characters** (16 bytes), **zero-padded**.
- `span_id` — **16 lowercase hex characters** (8 bytes), **zero-padded**.
- An all-zero id is **invalid** and MUST be treated as absent, not emitted.
- Runtimes MUST emit lowercase; they MUST accept either case on ingest.
- If `span_id` is present, `trace_id` MUST be present.

**The internal representation is unconstrained — only the emitted form is
normative.** A runtime SHOULD keep span ids as a native 64-bit integer
internally: minting is an increment, comparison and map-keying stay cheap, and
nothing allocates. Hex rendering is a fixed-width format of a `u64` performed
**only at the encoding boundary**, on records that are actually emitted to a sink
that needs it. Runtimes MUST NOT format span ids eagerly at span creation.

Consequently the cost is zero on the paths that matter: spans are minted only
while tracing is enabled, and a record emitted with no active span carries no
span id to format at all. When a record does carry one, the runtime is already
serializing that record, and a 16-character fixed-width render is noise against
that.

**Collision resistance.** A bare per-process counter starting at 1 collides
across processes participating in one distributed trace — two services would both
mint span id `1`. Runtimes MUST therefore XOR the counter with an 8-byte
per-process random salt minted once at startup, and emit that. This costs a
single XOR, preserves the cheap counter internally, and keeps ids unique within a
trace. Span ids carry no randomness *requirement* of their own (unlike trace ids
under W3C Level 2), so a salted counter is sufficient.

Zero-padding is called out explicitly because it is a live bug class, not a
formality. In Rust, `opentelemetry`'s `LowerHex` impl for `TraceId` delegates to
`u128` **without a width**, so `format!("{:x}", trace_id)` silently produces a
short, spec-invalid id whenever the value has leading zero bytes. Implementations
MUST use the `Display` impl (`to_string()`), never `{:x}`. Equivalent traps exist
anywhere a fixed-width byte array is rendered through a general integer
formatter.

> **Flagged.** `TracePayload.spanId` is currently a numeric counter. A runtime
> conforming to this spec MUST render span ids as 16 hex characters on log
> records — a counter is zero-padded (`1` → `0000000000000001`). Whether the
> trace wire format follows is a separate decision; until it does, the two
> spell the same id differently.

### 7.2 Automatic attachment

When a record is emitted inside an active dispatch span, the runtime MUST attach
that span's `trace_id`, `span_id`, and `trace_flags` **automatically**. A
controller MUST NOT have to pass them. The ambient-context mechanism is
language-local (Node `AsyncLocalStorage`, Go `context.Context`, Rust span stack)
and is explicitly not specified; only the on-record encoding is normative.

When no span is active, all three fields are omitted.

### 7.3 Resource identity

The runtime MUST attach the emitting resource as `{ kind, name, id }`, where `id`
is the full hierarchical id (`<owner.id>/<kind>.<name>`). This is what
distinguishes two instances of the same templated kind.

The runtime MUST also attach `scope` — the dotted import-alias path of the module
context that emitted the record (§12.2) — whenever the emitter sits inside an
import. `module` alone is ambiguous: two imports of `std/sql` produce records
that are otherwise identical. `scope` closes the loop between reading and
configuring: the path on a log line is exactly the path you write in the manifest
to change that instance's level.

### 7.4 Distributed propagation

On the wire, trace context propagates as W3C `traceparent` / `tracestate`:

```
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
             ^version ^trace-id (32 hex)          ^parent-id (16)  ^flags
```

Runtimes MUST ignore a `traceparent` whose `trace-id` or `parent-id` is all
zeros — treat it as absent and start a new trace. Partial adoption of an invalid
`traceparent` is forbidden.

`tracestate`, when present, MUST be propagated unmodified. Runtimes SHOULD
support at least 32 list members and 512 characters combined; a `tracestate` that
cannot be parsed MAY be discarded in full, but MUST NOT be partially rewritten.

### 7.5 Trace-flags bit 1 (forward compatibility)

W3C Trace Context **Level 2** (Candidate Recommendation Draft as of this writing,
not yet a Recommendation) defines bit 1 (`0x02`) as the **random trace-id flag**,
indicating the right-most 7 bytes of the trace id were chosen randomly, which
enables downstream consistent sampling.

This spec therefore **reserves** bit 1 rather than requiring it to be zero.
Runtimes MUST preserve it when propagating an inbound `traceparent`, MUST NOT set
it themselves until Level 2 reaches Recommendation, and MUST zero bits 2–7 on
outgoing requests. Requiring bit 1 to be zero — the Level 1 reading — would make
a conforming runtime corrupt Level 2 traces it merely forwards.

---

## 8. The Logger API

### 8.1 Required surface

Every runtime MUST expose, in its idiomatic form:

```
enabled(severity)                -> bool
log(severity, message, attrs?)   -> void
with(attrs)                      -> Logger      // child with bound attributes
flush()                          -> future/void
```

Plus convenience methods for the six named levels (§5.1).

### 8.2 `enabled` is mandatory

`enabled(severity)` is the load-bearing performance primitive — it is the only
mechanism that avoids evaluating a call's *arguments*, not merely serializing
them. Every surveyed ecosystem exposes it (slog's `Enabled`, zap's `Check`,
pino's `isLevelEnabled`), and OTel's Logs API requires it.

- `enabled` MUST NOT block and MUST NOT throw.
- Its result is **not static** — it changes when configuration changes (§12.4).
  Callers MUST re-check per emission rather than caching a boolean.
- Runtimes SHOULD additionally support deferred value resolution (a value carrying
  a method the sink invokes only on the emit path — slog's `LogValuer`, zap's
  `ObjectMarshaler`, tracing's `Value`). This is RECOMMENDED, not required, and
  does **not** substitute for `enabled`.

### 8.3 Child loggers

`with(attrs)` returns a logger whose bound attributes are merged into every
record. Merge order: **record attributes override bound attributes.** Binding
MUST be O(1) amortized; a runtime MUST NOT deep-copy the parent chain per record.

### 8.4 Failure behaviour

- `log()` MUST NOT throw, under any condition, including sink failure.
- A sink failure MUST NOT propagate to the caller and MUST NOT be silently
  discarded. It MUST be written to the **fallback diagnostic stream** (the
  process's real stderr) at most once per sink per interval, and counted
  (§10.4). This is the one place a logger may not surface an error inline —
  it is reported out-of-band, never swallowed.
- A record that fails to encode MUST be replaced by a synthetic record at the
  same severity describing the encoding failure, preserving `trace_id`/`span_id`.

---

## 9. Guest runtimes and FFI boundaries

A guest controller (Rust via N-API today) reaches the logger across a boundary
where every call costs a property lookup plus full value serialization. Naively
routing each log call across it is unacceptable.

**Requirements.**

1. The effective threshold MUST be cached on the **guest** side as a plain scalar
   (an atomic integer). `enabled()` MUST resolve entirely guest-side and MUST NOT
   cross the boundary.
2. The host MUST push threshold changes to the guest on reconfiguration (§12.4).
   A guest MUST NOT poll.
3. A suppressed record MUST NOT cross the boundary, and MUST NOT be serialized.
4. A logger handle obtained during a call MUST NOT be retained beyond that call.
   This mirrors the existing cancellation-token rule, where the JS handle is valid
   only for the synchronous duration of `invoke()`. Runtimes SHOULD encode this in
   the type system where the language allows (the Rust SDK's `CancellationToken`
   is deliberately not `Clone` for exactly this reason).
5. A guest MAY batch records across the boundary provided ordering within a single
   logger is preserved and the batch is flushed before the call returns.
6. The cached value is the **already-resolved** threshold for that controller's
   module context (§12.2), not the root default. Scope resolution happens once
   when the import graph is built; a guest never evaluates cascade rules, and
   never walks an import chain at emit time. Pushing a resolved scalar is the
   whole mechanism — there is nothing further to interpret on the guest side.

### 9.1 Per-language ambient-context hazards

The ambient mechanism is deliberately not specified (§7.2) — it cannot be
unified. What follows are the documented traps in each target language. Each one
silently produces *wrong* correlation rather than an error, so each is a required
review point, not a tip.

**Rust.** Holding the guard returned by `Span::enter()` across an `.await` point
produces incorrect traces: the scope is exited on yield but the guard is not
dropped, so the span stays current while the executor runs a *different* task on
that thread, mis-parenting its spans and events into yours. Async code MUST use
`Instrument` / `#[instrument]` (which enters on each `poll` and exits on yield)
or `Span::in_scope` for synchronous sections. `Span::enter` across `.await` is
forbidden. Note also that `tracing`'s thread-local dispatch does **not** propagate
to spawned threads.

**Node.** `AsyncLocalStorage.run()` MUST be preferred over `enterWith()`.
`enterWith()` transitions for the remainder of the *entire* synchronous
execution, so context leaks into subsequent event handlers on the same tick.
Node 24+ reimplements `AsyncLocalStorage` on V8's continuation-preserved embedder
data rather than `async_hooks`, removing the per-async-operation JS callback —
runtimes SHOULD NOT reintroduce an `async_hooks.createHook`-based mechanism,
which carries both the performance cost and a known DoS exposure.

**Go.** Context is passed explicitly as the first argument; there is no ambient
storage. A runtime MUST NOT store the logger in the context — the Go team
considered and explicitly rejected that API before release, on the grounds that
it makes the dependency invisible at the call site. Pass context *into* the
logging call instead. Cancelling that context MUST NOT suppress the record: log
output is often exactly what is needed to debug a cancellation.

---

## 10. Sinks and the emission pipeline

### 10.1 Shape

```
controller → Logger → [threshold] → [redaction] → [sampling] → fan-out → Sink₁..Sinkₙ
                                                                          ↓ encoding
```

Redaction runs **before** serialization and before any sink sees the record.

### 10.2 Defined sinks

A sink is a **resource**, declared in `logging.sinks` as an inline definition or
a `!ref` (§12.1). The set is therefore open: a third party ships a sink by
publishing a module whose kind `extends Telo.LogSink`.

**`Telo.LogSink`** is the `Telo.Abstract` every sink kind extends. It is a
**kernel built-in**, resolvable without an import — so a sink author depends on
the kernel contract rather than on a standard-library module version, and
kernel↔module skew never becomes a compatibility surface for "where do logs go".

| Kind | Lives in | Required? | Notes |
|---|---|---|---|
| `Telo.LogSink` | kernel | REQUIRED | The abstract. Not instantiable. |
| `Telo.ConsoleSink` | kernel | REQUIRED | Writes to `stderr`, or `stdout` on request. Dependency-free, so eagerly instantiated. |
| `Telo.FileSink` | kernel | REQUIRED | Path destination. Dependency-free, so eagerly instantiated. |
| `Otlp.Sink` | module | OPTIONAL | MUST follow OTLP/JSON (§11.3) and MUST NOT accept another encoding. |
| third-party | module | OPTIONAL | `Loki.Sink`, `Datadog.Sink`, … — any kind extending `Telo.LogSink`. |
| `debug-wire` | kernel | REQUIRED | **Not declarable.** Host-attached on `--debug` / `--inspect`, detached on disconnect. Record framing per §11.4. |

**Why console and file are kernel built-ins rather than standard-library
modules.** §16 already requires every conforming runtime to implement both, along
with the `pretty` and `json` encodings, byte-identically — a Rust or Go kernel
cannot conform without them. Mandatory runtime behaviour belongs in the runtime;
shipping it as an installable module would make conformance depend on whether
that module was installed. `Otlp.Sink` is a module for the mirror-image reason:
§10.2 makes it optional, and it needs an HTTP client, credentials, and a retry
policy — all things the resource graph already models.

They live under `Telo.*` rather than a new `Log.*` root because `Telo.*` is
currently the only globally-resolvable namespace, and introducing a second one is
a larger precedent than three kinds warrant. The cost, accepted deliberately, is
that `Telo.*` now holds a few concrete resource kinds alongside its structural
and capability kinds.

Logging MUST function with **no** debug consumer attached and with tracing off.
A sink MUST NOT depend on the event bus, which short-circuits to zero cost when
unsubscribed.

### 10.3 Buffering and drop policy

The ecosystems disagree by default — Rust's `tracing-appender` drops (lossy,
128,000-line limit), zap buffers 256 kB / 30 s, pino has *no* bound at all by
default. Telo therefore makes the policy explicit and required.

Every asynchronous sink MUST expose the following. They are declared on
`Telo.LogSink` and inherited by every sink kind (§12.1), so they are settable on
any entry in `logging.sinks` — a policy that cannot be configured from the only
permitted configuration source is not a policy:

| Setting | Default | Meaning |
|---|---|---|
| `buffer` | 8192 records | Bounded. MUST NOT be unbounded. |
| `on_full` | `drop_new` | `block` \| `drop_new` \| `drop_old` |
| `flush_interval` | 1s | Max time a record may sit buffered. |

- The `console` sink is **synchronous by default** — a developer-facing stream
  that silently reorders or drops is worse than a slow one. `on_full` does not
  apply to a synchronous sink, which has no buffer to saturate.
- `drop_old` (ring-buffer semantics) has no precedent among surveyed libraries;
  runtimes MUST implement it as specified rather than by analogy.

#### `on_full: block` where blocking is impossible

`block` means the producer is suspended until the buffer drains. That requires
the drain to make progress *while* the producer is suspended — true on a runtime
with real threads, false on a single-threaded event loop, where suspending the
producer also suspends the consumer. There, `block` is a deadlock.

A runtime that cannot honour `block` for a given sink **MUST reject the manifest
at load** with an actionable diagnostic naming the sink and the supported values.
It MUST NOT silently substitute a dropping policy.

> `Http.Server` sink "audit": on_full: block is not supported by this runtime
> (single-threaded event loop — blocking the producer would stall the writer).
> Use `drop_new` or `drop_old`, or move this sink to a worker thread.

This is deliberately *not* best-effort, and it is the one place in this spec
where I'd argue against degrading. `on_full` exists precisely so an operator can
state durability intent. Someone who writes `block` on an audit sink is saying "I
would rather go slow than lose a record"; silently giving them `drop_new` hands
back the opposite guarantee, and they discover it from a gap in an audit trail
rather than from a diagnostic. A load-time error is loud, actionable, statically
detectable by `telo check`, and cheap to fix. Swallowing the distinction is the
failure mode CLAUDE.md's "never swallow errors" exists to prevent.

Contrast this with `fatal`'s flush (§10.5), where best-effort *is* right: the
record has already been created and the alternative to a partial flush is no
flush at all. Here the alternative to rejecting is a wrong durability guarantee,
which is worse than no logging config.

### 10.4 Drop accounting (REQUIRED)

A runtime MUST maintain a monotonic counter of records dropped per sink, per
cause (`buffer_full`, `sampled`, `encode_failure`, `sink_error`). When drops
occur and then cease, the runtime MUST emit one `warn` record reporting the count
and cause. Dropping without accounting is non-conformant.

### 10.5 Flush and shutdown

- The runtime MUST flush all sinks during shutdown, before the process exits.
- Shutdown flush MUST be bounded by a timeout (default 5s); on timeout the runtime
  MUST report the unflushed count on the fallback stream.
- Every surveyed library can silently lose its tail on abrupt exit; a conforming
  runtime MUST install exit handling that flushes, and MUST document the residual
  cases it cannot cover (e.g. `SIGKILL`).

#### Synchronous flush is a sink capability, not a runtime guarantee

Every sink declares whether it can be flushed **synchronously** — i.e. drained to
its destination from inside a synchronous call, with no scheduler turn.

| Sink | Sync-flushable | Why |
|---|---|---|
| `console` | yes | A file descriptor write blocks until the bytes are handed to the OS. |
| `file` | yes | Same — a positional/synchronous write is available on every target platform. |
| `otlp` | **no** | Delivery is a network round-trip; it cannot complete without yielding. |
| `debug-wire` | **no** | Delivery crosses an SSE/stream boundary owned by the host. |

A sink is also **not** sync-flushable when its transport lives on another thread
(a worker-thread pipe, a channel to a writer thread), regardless of type: the
producer cannot drain a queue it does not own.

**`fatal` therefore obliges the runtime to:**

1. flush every sync-flushable sink to completion **before `log()` returns**; and
2. *initiate* the flush of every other sink before returning, without waiting.

Records held only by a non-sync-flushable sink MAY be lost if the process dies
immediately after. Runtimes MUST document this, and SHOULD note it per sink type
so an operator choosing `otlp` for audit records understands the exposure. A
runtime MUST NOT block waiting on a sink it cannot synchronously drain — on a
single-threaded event loop that is a deadlock, not durability.

This is a capability tier, not a language carve-out: the same rule makes an
`otlp` sink best-effort in Rust and Go, where blocking a producer thread *is*
possible but still would not make a network round-trip synchronous.

---

## 11. Encodings

### 11.1 `json` — the default machine encoding

One JSON object per line, UTF-8, newline-terminated. No de-facto cross-ecosystem
standard exists for key names, so Telo defines its own profile and keeps OTLP as
a separate one.

```json
{
  "time": "2026-07-19T12:34:56.789012345Z",
  "level": "INFO",
  "severity": 9,
  "msg": "listening",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "span_id": "00f067aa0ba902b7",
  "resource": { "kind": "Http.Server", "name": "api", "id": "Http.Server.api" },
  "module": "http-server",
  "scope": "Api",
  "attributes": { "net.host.port": 8080 }
}
```

| Key | Source field | Notes |
|---|---|---|
| `time` | `timestamp` | RFC 3339, UTC, **nanosecond** precision, `Z` suffix. |
| `level` | `severity_text` | Uppercase. |
| `severity` | `severity_number` | Integer. Present so consumers can compare without a table. |
| `msg` | `message` | The one near-universal key name across pino/slog/zap. |
| `trace_id`, `span_id` | §7 | Omitted when absent. Never all-zero. |
| `resource`, `module`, `scope` | §7.3 | Omitted when absent. `scope` is the import-alias path. |
| `attributes` | `attributes` | **Nested**, not flattened — flattening risks collision with reserved keys. |
| `err` | `error` | ErrorValue (§4.2). |
| `event_name` | `event_name` | Omitted when absent. |
| `dropped_attributes_count` | — | Emitted only when non-zero. |

Top-level keys are emitted in the order above (RECOMMENDED for diffability);
encoders MUST NOT reorder them arbitrarily. Unknown/extra top-level keys MUST NOT
be emitted — extension data belongs in `attributes`.

**Within `attributes`, keys MUST be emitted in sorted (Unicode code-point)
order, recursively for nested maps.** Attribute keys are arbitrary and have no
natural order, so without this the `json` encoding is not byte-identical across
runtimes and vector 18 (§16.1) cannot hold: a Node runtime emitting insertion
order and a Rust runtime backing attributes with a `BTreeMap` would disagree.
Sorted is the one order every runtime produces deterministically without extra
configuration. This applies only to the `attributes` subtree; fixed-shape
objects (`resource`, `err`) keep their declared field order.

### 11.2 `pretty` — the console encoding

Selected either explicitly (`encoding: pretty`) or by `encoding: auto`, which
MUST resolve as:

- **`pretty`** when the sink's destination is a TTY;
- **`json`** otherwise — piped, redirected, or captured.

`auto` MUST be evaluated against the sink's *actual* destination descriptor, not
the process's. A `console` sink on `stdout` and another on `stderr` can resolve
differently, and that is correct. `auto` is the default only for the `console`
type; `file` defaults to `json` and `otlp` is fixed at `otlp` (§12.1).

For humans on a terminal. Layout:

```
12:34:56.789 INFO  Http.Server.api  listening  net.host.port=8080
```

- **Time**: `HH:MM:ss.SSS`, local timezone.
- **Level**: canonical short name, right-padded to 5 characters.
- **Resource**: `<kind>.<name>` when present.
- **Message**, then attributes as `key=value`, space-separated. Values containing
  whitespace, `"`, or `=` MUST be quoted.
- Errors render after the message; a stack trace goes on following lines,
  indented, unmodified.

**Colors.** The modal convention across pino-pretty, zap, tint,
tracing-subscriber, consola, and winston:

| Level | Color |
|---|---|
| TRACE | gray / dim |
| DEBUG | blue |
| INFO | green |
| WARN | yellow |
| ERROR | red |
| FATAL | bold, red background |

Attribute keys SHOULD be dimmed. The message itself MUST NOT be colored by level.

**Color decision precedence** (highest first). A runtime MUST implement this
exact order:

1. The manifest's `color:` setting when it is `always` or `never`.
2. `NO_COLOR` present **and non-empty** → off. (The value is irrelevant; only
   presence and non-emptiness matter.)
3. `FORCE_COLOR` present and non-empty: `"0"` → off, otherwise → on.
4. `CLICOLOR_FORCE` present and ≠ `"0"` → on.
5. `CLICOLOR` = `"0"` → off.
6. `TERM` = `"dumb"` → off.
7. `isatty()` on the **actual output descriptor** → on if true, else off.

Steps 2–7 apply only when `color: auto` (the default). They are **not** a second
configuration channel and do not contradict §12.3: `NO_COLOR`, `FORCE_COLOR`,
`TERM`, and `isatty()` describe the *terminal's capability and the operator's
preference*, not the application's desired state. `auto` means "detect the
environment"; the manifest remains the sole authority over what is logged, and
these inputs affect only how it is painted. `always` / `never` override them.

Runtimes MUST NOT force color on merely because a CI environment variable is
present — a widespread bug in existing libraries. Runtimes MUST test
non-emptiness, not mere presence, for `NO_COLOR` and `FORCE_COLOR`.

> **Flagged.** The existing CLI honours `FORCE_COLOR` / `CLICOLOR_FORCE` but not
> `NO_COLOR`. Conforming changes its behaviour.

### 11.3 `otlp` — OTLP/JSON

When implemented, records MUST follow the OTLP/JSON mapping exactly:

- Keys are **lowerCamelCase** (`timeUnixNano`, `severityNumber`, `severityText`,
  `body`, `attributes`, `traceId`, `spanId`, `flags`, `droppedAttributesCount`),
  nested in `resourceLogs` → `scopeLogs` → `logRecords`.
- 64-bit integers are **decimal strings** — `timeUnixNano`, `observedTimeUnixNano`,
  and `intValue` are quoted. This is not pedantry: nanosecond epoch values exceed
  JavaScript's `Number.MAX_SAFE_INTEGER`, so emitting them bare loses precision in
  JS receivers. 32-bit fields (`droppedAttributesCount`, `flags`) stay bare numbers.
- `traceId` / `spanId` are **hex strings, not base64** — OTLP/JSON's documented
  deviation from standard Protobuf JSON mapping. **Scoped to these two fields
  only** (see §6.1).
- Enum values are emitted as **integers** (`severityNumber: 9`), never names.
  Standard proto3 JSON permits enum name strings; OTLP explicitly forbids them.
- `attributes` is an **array of `{ key, value }` objects**, never a JSON map.
  Encoding it as a map is the single most common OTLP/JSON mistake.
- Each `AnyValue` carries **exactly one** variant key (`stringValue`, `boolValue`,
  `intValue`, `doubleValue`, `arrayValue`, `kvlistValue`, `bytesValue`).
- Receivers MUST ignore unknown field names.

`service.name` is REQUIRED on the resource. When unset, runtimes MUST fall back
to `unknown_service:<process executable name>`, or `unknown_service` if
unavailable.

### 11.4 Debug wire framing

The debug wire currently carries two frame kinds — `kind: "event"` and
`kind: "log"`, the latter being one *unstructured line* of stdout/stderr. A
structured record is a **third kind**, `kind: "record"`:

```json
{ "kind": "record", "timestamp": "…", "record": { /* §11.1 json profile */ } }
```

Consumers route on `kind`; existing `"event"` and `"log"` frames are unchanged.
The companion JSON Schema (§16) extends `wire-schema.json`'s `oneOf`. Producers
in any language conform to the schema, not to the TypeScript types.

---

## 12. Configuration

### 12.1 Manifest

Logging is configured by a `logging:` block on the root `Telo.Application`. The
*logger* is ambient rather than a resource (D3) — it must work before any
resource initializes — but each **sink is a resource** (D10), so the set of log
destinations is open to the ecosystem.

A `Telo.Library`'s own root doc MUST NOT declare `logging:`; a library does not
own process-level output. This does **not** forbid a library from carrying
threshold overrides on its own `imports:` entries (§12.2) — those describe
dependencies it pulls in, not sinks it owns.

```yaml
kind: Telo.Application
metadata:
  name: my-app
imports:
  Loki: acme/loki-sink@1.4.0
logging:
  level: info
  attributes:
    service.name: my-app
  redact:
    paths:
      - secrets.*
      - request.headers.authorization
    censor: "[redacted]"
  sampling:
    first: 100
    thereafter: 100
    tick: 1s
  sinks:
    - kind: Telo.ConsoleSink        # inline definition — no import needed
      encoding: auto                # auto | pretty | json
      color: auto                   # auto | always | never
    - kind: Telo.FileSink
      destination: /var/log/my-app.jsonl
      level: warn                   # this sink only; never below the scope level
      on_full: drop_new             # block | drop_new | drop_old
    - !ref shippedLogs              # a declared resource that needs wiring
---
kind: Loki.Sink
metadata:
  name: shippedLogs
endpoint: !cel "variables.lokiUrl"
credentials: !ref lokiAuth          # sinks may depend on other resources
retry: !ref backoffPolicy
```

The block MUST be schema-validated like any other manifest field, so `telo check`
catches a bad level or an unknown `on_full` statically. Any CEL in it MUST use
the `!cel` tag.

#### `sinks` is a list of references or inline definitions

Each entry is an ordinary Telo **ref slot**, so it takes either form the
reference grammar already defines:

- an **inline definition** — `{ kind: <SinkKind>, …config }` with no `name`, for
  the common case that needs no wiring; or
- a **`!ref`** to a sink resource declared elsewhere in the manifest, for a sink
  that depends on secrets, an HTTP client, a retry policy, or anything else the
  resource graph already models.

No new schema machinery is involved — this is the same slot shape used
everywhere else a resource is accepted. A field that was both an enum and a
reference would not work: `validateReferenceForms` rejects a bare string at a ref
slot (`INVALID_REFERENCE_FORM`), and making sibling fields' meaning depend on a
`type` discriminator would leave the editor unable to render the entry until it
resolved that field.

It is a **list** rather than a keyed map because sinks are root-only (§12.2) and
therefore never merged. With no merge to disambiguate, a list matches how Telo
spells every other ref-or-inline collection. Sink identity for drop accounting
(§10.4) comes from the resource name for a `!ref`, or kind plus position for an
inline definition.

**When `sinks:` is omitted**, a runtime MUST behave exactly as if a single
`{ kind: Telo.ConsoleSink }` entry were declared. The zero-config case stays
"pretty logs on stderr in a terminal, JSON when piped", with no imports.

#### Fields common to every sink kind

`Telo.LogSink` declares these; a concrete sink kind inherits them and adds its
own. A sink kind MAY narrow a default but MUST NOT remove a field.

| Field | Default | Meaning |
|---|---|---|
| `level` | the effective scope threshold (§12.2) | Filters at fan-out only. |
| `encoding` | per kind (below) | `auto` \| `pretty` \| `json` \| `otlp` (§11). |
| `buffer` | 8192 records | Async sinks. Bounded; MUST NOT be unbounded. |
| `on_full` | `drop_new` | Async sinks. `block` \| `drop_new` \| `drop_old` (§10.3). |
| `flush_interval` | 1s | Async sinks. |

Per-kind defaults for the built-ins:

| Kind | `destination` | `encoding` | Sync? |
|---|---|---|---|
| `Telo.ConsoleSink` | `stderr` (or `stdout`) | `auto` → `pretty` on a TTY, else `json` | synchronous unless `buffer` is set |
| `Telo.FileSink` | REQUIRED | `json` | asynchronous |
| `Otlp.Sink` (module) | REQUIRED | `otlp`, fixed — MUST NOT be overridden | asynchronous |

#### Sinks are written directly, not dispatched

The logger MUST write to a sink through a direct contract on the controller
instance. It MUST NOT route records through `ctx.invoke`.

Two reasons, both disqualifying: per-record dispatch is far too slow for a
logging hot path, and the dispatch chokepoint emits trace events (§7), so
logging through it would generate telemetry from inside the telemetry path. The
integration shape is closer to `Telo.Mount` — a resource mounted into a host —
than to normal invocation.

#### Eager and late sinks

A sink is instantiated **eagerly**, before the init loop, if its kind has no
resource dependencies. `Telo.ConsoleSink` and `Telo.FileSink` qualify by
construction: their controllers are kernel built-ins that need nothing but a
descriptor.

Every other sink attaches when it initializes. Between process start and that
moment, records are held in a bounded bootstrap buffer and **replayed** into each
sink as it attaches, in original order. The buffer is subject to §10.3's drop
policy and §10.4's accounting like any other; overflow before attach MUST be
counted, not silently discarded.

This generalizes machinery the spec already required: `debug-wire` (§10.2)
attaches and detaches dynamically at any point in the process lifetime. Late
attachment is the normal case, not an exception, and the eager tier exists only
so that a runtime never has *zero* destinations.

Attaching or detaching a sink changes the minimum-level gate (§12.1, per-sink
level), so the runtime MUST recompute it and propagate the new threshold to
guests per §12.4.

**The `debug-wire` sink is not declared here.** It is attached by the host when a
debug consumer connects (`--debug` / `--inspect`), is removed when it
disconnects, and always uses the record framing of §11.4. It is tooling
attachment rather than application configuration — the same category as TTY
detection, not a violation of D6.

#### Per-sink `level` and the guest threshold

A sink's `level` filters **at fan-out**, after the record has been created. It
MUST NOT be used to reason about whether a record is created at all.

The threshold that gates creation — the scalar cached guest-side per §9 — is the
**minimum (most verbose) `level` across all enabled sinks** for that scope. A
record failing that gate reaches no sink and MUST NOT be created, formatted, or
sent across an FFI boundary. A record passing it is created once and then offered
to each sink, which applies its own `level`.

This keeps `enabled()` a single scalar comparison while still allowing
"everything to the audit file, warnings only to the console".

### 12.2 Scoped thresholds

Raising verbosity for one subsystem without raising it everywhere is addressed
**per import**, not by a name-keyed map.

```yaml
kind: Telo.Application
metadata:
  name: my-app
logging:
  level: info          # app-wide default; governs the root's own resources
imports:
  Db:
    source: std/sql@1.2.0
    logging:
      level: debug     # this import's subtree only
  Api:
    source: ./api
```

**Why not a map keyed by module name.** Module names are not unique, so such a
map cannot address an instance:

- `std/sql` and `acme/sql` share `metadata.name: sql` — one key, two modules.
- The same module imported twice (two `http-server` instances with different
  variables) is two subsystems sharing one name.
- A library's transitive `sql` import is indistinguishable from the application's
  own.

Import aliases have none of these problems: an alias is **already guaranteed
unique** within a module scope, enforced as a hard `DUPLICATE_IMPORT_ALIAS`
diagnostic. Attaching the threshold to the import reuses that guarantee instead
of inventing a second, weaker namespace beside it. It also matches how
`variables` and `secrets` already flow — down the import graph.

**Resolution rules.**

1. The root `logging:` block supplies app-wide defaults and governs resources
   declared directly in the root Application.
2. An `imports:` entry MAY carry a `logging:` block overriding any field for that
   import's subtree.
3. **Config cascades and may be narrowed at each hop.** An import inherits its
   parent's effective configuration; a nested import may override it again. This
   is what makes a dependency you do not own diagnosable — `Api: { logging:
   { level: debug } }` raises everything beneath `Api` without editing `Api`'s
   manifest.

Dotted path addressing (`Api.Domain.Db`) is **not** used: it would collide
conceptually with the `!ref <Alias>.<name>` grammar, which splits on the first
dot. Cascade expresses the same intent without the ambiguity.

**Sinks are root-only.** An `imports:` entry's `logging:` block MAY set `level`,
`redact`, and `sampling`; it MUST NOT declare `sinks:`. Sinks are process-level
I/O — file handles, network exporters, the console — and belong to the root
Application that owns the process. An imported library opening its own log file
would be a side effect its importer never authorized.

A library MAY still *define* a sink kind and export it; what it may not do is
attach one. Declaring the instance and pointing `logging.sinks` at it remains the
root Application's decision.

This also keeps the cascade total: the fields an import may override are all
scalars or replaceable sub-objects, so every merge is well defined. Nothing
requires merging two collections of sinks — which is why §12.1 spells `sinks:`
as a list rather than a keyed map.

**Resolution happens once, at load.** Because the threshold attaches to an
import, each module context resolves its effective configuration when the import
graph is built and holds the result as a plain scalar. There is no per-record
lookup and no walk up the import chain at emit time. This is the same scalar
§9 requires guests to cache, so scoping and the FFI threshold cache are one
mechanism rather than two.

A runtime MUST support import-scoped overrides. The trade is deliberate: "debug
every `sql` everywhere it appears" is no longer expressible in one line — that
query is precisely the ambiguous one this replaces.

### 12.3 The manifest is the only configuration source

There are **no `TELO_LOG_*` environment variables and no logging CLI flags.**
Precedence is simply: **manifest → default.**

This is deliberate. Telo already has a declarative, type-safe way to derive a
configuration value from the host environment — a `variables:` entry with an
`env:` key, referenced with `!cel`:

```yaml
variables:
  logLevel:
    env: LOG_LEVEL
    type: string
    default: info
logging:
  level: !cel "variables.logLevel"
```

A dedicated `TELO_LOG_LEVEL` variable would be a second, parallel configuration
path with strictly worse properties: invisible to the analyzer, unrenderable in
the editor, unvalidated by `telo check`, and routed around the host-env guardrail
rather than through it. Runtimes MUST NOT introduce one.

The same reasoning forbids logging CLI flags. A runtime MAY expose an unrelated
host-level verbosity control for its *own* output (the CLI's existing
`--verbose`), but it MUST NOT let that silently override the application's
declared `logging:` block.

**Bootstrap exception.** Records emitted before the manifest is parsed — loader
and parse diagnostics — cannot consult a `logging:` block that does not yet
exist. During this phase a runtime MUST use a fixed default of `info` written by
an **internal console writer**, and MUST switch to the declared configuration as
soon as the manifest resolves. This phase is the only one not manifest-governed,
and it MUST NOT be configurable by other means.

That writer is kernel-internal and is **not** a `Telo.ConsoleSink` resource — it
exists precisely because no resource can. It is also what makes D3 hold: because
the pre-manifest window is covered unconditionally, declared sinks are free to be
resources that attach later, with buffered records replayed into them (§12.1).

### 12.4 Runtime reconfiguration

The threshold MUST be changeable at runtime without restarting or rebuilding
loggers, and the change MUST propagate to guest runtimes (§9.2). Existing child
loggers MUST observe the new threshold.

Per D6 this is not a second configuration channel: the new value still originates
from the manifest — a reload, or a `!cel` expression over a variable whose source
changed. The requirement is that the pipeline *observes* a changed value without
a restart, not that some other actor may set one. It is also why §8.2 forbids
callers from caching the result of `enabled()`.

---

## 13. What the runtime logs

### 13.1 Kernel

The kernel MUST route all its own diagnostic output through this logger. It MUST
NOT write to `process.stderr` directly, or to `console.*`, outside the fallback
diagnostic path of §8.4. Nested kernels MUST inherit the parent's sink
configuration unless explicitly overridden, so a test harness can capture child
output.

### 13.2 Controllers

Controllers emit through the ambient `ctx.log` (D3). A controller MUST NOT write
to stdout/stderr for diagnostic purposes. Writing to stdout as *data* (as the
`Console` module does) is a distinct, legitimate concern and is unaffected by
this spec.

### 13.3 Third-party loggers: replace, don't bridge

A module embedding a library that carries its own logger (Fastify/Pino, a
database driver) MUST NOT let that logger write independently. There are two
mechanisms, and the order of preference is normative.

**Replacement (REQUIRED where the library permits it).** Most libraries accept an
injected logger satisfying a small interface. A runtime MUST supply a Telo-backed
adapter implementing that interface over `ctx.log`, so the library's records are
Telo records from the moment they are created — no format to translate, no second
pipeline, no possibility of divergence. The adapter maps the library's level
methods onto §5.1 and its child-logger factory onto §8.3.

**Bridging (fallback only).** When a library writes to a stream it owns and
offers no injection point, the module MUST intercept that output and convert it.
Bridging MUST:

- map the source level to `severity_number`, preserving the original spelling in
  `severity_text` (§5.1);
- set `observed_timestamp`, since the source timestamp is the origin time;
- attach the current span context (§7.2);
- route through the same threshold, redaction, and sinks.

Bridging is strictly worse — it parses text a library already structured, and it
loses fidelity whenever the source format changes. Use it only where replacement
is impossible.

**`http-server` is a replacement case.** Fastify accepts an injected logger
instance, so its Pino logger MUST be replaced with a Telo-backed adapter rather
than bridged (Fastify 5 takes the instance via `loggerInstance`, not `logger`).
This also removes the duplication where a stream failure was both logged to Pino
and separately re-emitted as an event for debug tooling — with the adapter in
place, one record reaches every sink, including the debug wire.

**Whether to instrument requests at all is derived from the resolved scope
threshold, not a per-server flag.** There is no `Http.Server.logger` field.
Fastify's per-request access lines are `info`-severity, so the server instruments
requests iff `info` is enabled for its scope: on by default, and suppressed by
raising the module's import to `level: warn`, which skips the per-request work
entirely (Fastify's null logger) rather than building a record and discarding it.
A boolean toggle would only duplicate what the threshold already expresses —
`warn` keeps server error logs while dropping access noise, because the two
differ in severity. The instrument-or-not decision is fixed at construction; a
runtime threshold change (§12.4) still gates output through the adapter but does
not re-instrument a server booted with request logging off.

---

## 14. Redaction

Only **path-based** redaction is portable across Node, Rust, and Go, so it is the
only form specified normatively.

**Syntax** (adopted from pino's `redact`, the best-documented prior art):

| Form | Example |
|---|---|
| Dot notation | `a.b.c` |
| Bracket notation | `a["b-c"].d`, `["a-b"].c` |
| Wildcard segment | `a.b.*` |
| Array wildcard | `items[*].secret` |

- Paths are **case-sensitive**.
- **More than one wildcard per path MUST be supported** — `items[*].tokens[*].value`
  is valid. The one-wildcard-per-path limit in the best-known implementation is an
  artifact of how it compiles accessors, not an inherent property of the grammar,
  and a spec that inherits it silently will surprise implementers.
- Redaction applies to `attributes` and `error`, **before** serialization and
  before any sink observes the record.
- **The key MUST be preserved and only the value replaced.** Deletion destroys
  schema stability and hides the fact that a field was present at all. This
  follows OTel's own rule for query-string scrubbing (`sig=REDACTED`, not
  removal). A `remove: true` option MAY be offered for the cases that genuinely
  need it, but MUST NOT be the default.
- Default censor token: `"[redacted]"`.
- Values bound to the manifest's `secrets:` MUST be redacted automatically,
  without configuration.
- **Redaction paths MUST NOT originate from user input.**

### 14.1 The grammar is closed

Runtimes MUST implement a hand-written parser over the grammar above. They MUST
NOT implement path matching by compiling the path as source code in the host
language.

This is a security requirement, not a style preference. The reference
implementation everyone borrows this syntax from compiles paths via the
`Function` constructor and validates them by "evaluate it and see whether it
parses" — which is precisely why that implementation must forbid user input. A
closed grammar with a real parser removes the injection surface entirely and, as
a bonus, makes paths statically checkable by `telo check`.

### 14.2 Cost

Explicit paths cost roughly 1–2% over plain serialization. Wildcards in
*intermediate* position cost materially more — measured at 25–55% depending on
match count. Runtimes SHOULD document this and MAY warn when an intermediate
wildcard is configured.

### 14.3 Type-based hooks (OPTIONAL)

Every ecosystem except the one this grammar comes from redacts by *type* rather
than by path — Go's `LogValuer`, zap's `ObjectMarshaler`, Serilog's destructuring
policies, .NET's data-classification attributes. Path matching is the outlier,
and it is the outlier because JavaScript has no nominal type to hang an
annotation on.

The two mechanisms fail differently and are **not** substitutes: a path breaks
when a field is renamed or moves a level deeper; a type hook is bypassed whenever
the value is reached through reflection or an untyped map, or when the type isn't
yours to annotate. Runtimes therefore MAY support a language-idiomatic type hook
in addition, but MUST NOT offer it instead.

Where both exist, **the type hook MUST resolve first** and path redaction MUST
then run over the already-resolved values. This is Go's documented ordering, and
it is the safe one: the path layer only ever sees values that have already had
their type-level protection applied.

### 14.4 Sensitive data by default

- Request and response **headers MUST NOT be captured by default.** Capturing
  them requires explicit configuration naming the headers, matching OTel's
  `Opt-In` requirement level: instrumentation that cannot be configured MUST NOT
  populate them at all.
- **URLs MUST be scrubbed** where credentials are identifiable. At minimum,
  runtimes MUST redact the values of `X-Amz-Signature`, `X-Amz-Credential`,
  `X-Amz-Security-Token`, `X-Goog-Signature`, and `sig`, preserving the keys.
- Sink-side redaction (a collector, a log pipeline) is defence-in-depth, not a
  substitute — by then the data has already crossed a process boundary. Equally,
  in-process redaction cannot catch a secret interpolated into a free-text
  message, which is why §14 applies to attributes and errors and why controllers
  SHOULD keep secrets out of message strings entirely.

---

## 15. Sampling

Sampling is **off by default**. When enabled it MUST follow these semantics:

- The dedup key is **(`severity_number`, `message`)** — not the attributes. This
  is what keeps it cheap.
- Within each `tick` window, the first `first` matching records are emitted;
  thereafter every `thereafter`-th record is emitted and the rest dropped.
- `thereafter: 0` means drop everything after the first `first` in the window.
- Dropped records MUST be counted under cause `sampled` (§10.4).
- Records with `severity_number >= 17` (errors) MUST NOT be sampled by default.

Runtimes MAY use a fixed-size counter table and MAY accept collisions, trading
precision for speed, but MUST document that choice.

---

## 16. Conformance

A runtime is conformant when all of the following hold.

**Model** — emits every REQUIRED field of §4; never emits `severity_number: 0`;
represents errors per §4.2.

**Severity** — compares numerically; maps per §5.2; `fatal` has no control-flow
effect.

**Correlation** — ids are lowercase hex of exactly 32/16 chars; all-zero ids are
omitted; span context attaches automatically; `span_id` never appears without
`trace_id`.

**API** — exposes `enabled`; `enabled` neither blocks nor throws; `log` never
throws; child loggers merge with record-wins precedence.

**Guests** — threshold cached guest-side; suppressed records never cross the
boundary; handles not retained past their call.

**Sinks** — declared as a `sinks:` list of `!ref` or inline `{ kind, …config }`
entries; `Telo.LogSink`, `Telo.ConsoleSink`, and `Telo.FileSink` are kernel
built-ins resolvable without an import; buffers bounded; `buffer` / `on_full` /
`flush_interval` settable per entry; `on_full` honoured or rejected at load, never
silently degraded; drops counted and reported; written through a direct contract
rather than `ctx.invoke`; flush on shutdown with timeout; omitting `sinks:` yields
exactly one `Telo.ConsoleSink`.

**Sink lifecycle** — dependency-free sinks instantiate eagerly before the init
loop; every other sink attaches on initialization with bootstrap records replayed
in order; attach and detach recompute the minimum-level gate and propagate it to
guests.

**Encodings** — `json` and `pretty` implemented exactly as §11.1/§11.2;
color precedence implemented in the exact order of §11.2.

**Redaction** — path syntax of §14 supported including multiple wildcards; keys
preserved and only values replaced; manifest secrets redacted automatically;
redaction precedes serialization; the path parser is hand-written, not compiled
from source.

**Configuration** — the manifest is the sole source; no `TELO_LOG_*` variable and
no logging CLI flag is honoured; the pre-manifest bootstrap phase defaults to
`info` on `console`; import-scoped overrides cascade and narrow per §12.2, and
resolve to a per-context scalar at load rather than per record.

**Third-party loggers** — replaced by an injected Telo-backed adapter wherever
the library permits injection; bridged only where it does not.

### 16.1 Required test vectors

Every runtime MUST pass these:

1. **Severity round-trip** — each of the six levels maps to its number and back;
   an unmappable source level preserves its text and lands on the range floor.
2. **Go offset** — `severity_number - 9` equals the slog level for all six.
3. **Id formatting** — the `u64` value `1` renders as exactly
   `0000000000000001` (zero-padded, never `1`); an all-zero id is omitted rather
   than emitted. Assert against the formatter directly, not against a minted span,
   since minted ids are salted.
4. **Span id salting** — two runtimes started independently do not produce the
   same span id for their first span; within one runtime, ids remain unique.
5. **Threshold gating** — at an effective level of `info`, three separate
   assertions (they test different actors, and conflating them produces a vector
   no strict-evaluation language can pass):
   - **(a) Guarded call.** `if (log.enabled(DEBUG)) log.debug(msg, expensive())`
     — `expensive()` MUST NOT run. This is the only form that avoids *argument
     evaluation*, because in a strict-evaluation language arguments are evaluated
     at the call site before `log()` is entered (§8.2).
   - **(b) Unguarded call.** `log.debug(msg, value)` MUST NOT format, serialize,
     redact, or sample `value`, and MUST NOT reach any sink. Evaluation of
     `value` itself is the language's business, not the logger's.
   - **(c) Deferred value.** A thunk / `LogValuer` / `ObjectMarshaler` passed to
     an unguarded suppressed call MUST NOT be resolved.
6. **Redaction** — `a.b`, `a["b-c"]`, `a.*`, `items[*].secret`, and the
   multi-wildcard `items[*].tokens[*].value` each redact; the key survives and
   only the value is replaced; a manifest secret redacts with no configuration.
7. **Drop accounting** — a saturated bounded buffer increments the counter and
   emits exactly one warn record on recovery.
8. **Color precedence** — `NO_COLOR=""` does **not** disable color;
   `NO_COLOR=1` does; an explicit `color: always` overrides it.
9. **Configuration isolation** — setting `TELO_LOG_LEVEL` in the environment has
   no effect on the emitted level.
10. **Scope resolution** — importing the same module twice, with `logging.level`
    set on only one import, raises that instance alone; the other stays at the
    root default. Each emitted record carries the `scope` that selected its
    threshold.
11. **Cascade** — an override on a parent import applies to a nested import that
    declares none, and a nested import's own override wins over its parent's.
    An `imports:` entry declaring `sinks:` is a manifest validation error.
12. **Sink configuration** — a `Telo.FileSink` with `on_full: drop_new` drops and
    counts when its buffer saturates. The same sink with `on_full: block` either
    blocks (on a runtime that supports it) **or** is rejected at load with a
    diagnostic naming the sink — never silently degraded to dropping. Omitting
    `sinks:` yields exactly one `Telo.ConsoleSink` writing to `stderr`.
13. **Sink entry forms** — an inline `{ kind: Telo.ConsoleSink, … }` and a
    `!ref` to a declared sink resource are both accepted in `logging.sinks`; a
    bare string is rejected with `INVALID_REFERENCE_FORM`; an `imports:` entry
    declaring `sinks:` is a manifest validation error.
14. **Late attach and replay** — a sink that initializes during the init loop
    receives the records emitted before it attached, in original order; records
    dropped from the bootstrap buffer are counted, not silently discarded.
15. **Encoding `auto`** — a `Telo.ConsoleSink` resolves to `pretty` against a TTY
    destination and `json` against a pipe, decided per sink destination rather
    than per process.
16. **Per-sink level** — with the console sink at `warn` and a file sink at
    `debug`, a `debug` record reaches the file and not the console, and is
    created exactly once.
17. **Fatal flush tiering** — a `fatal` record is durable on a `Telo.ConsoleSink`
    or `Telo.FileSink` at the moment `log()` returns; on a non-sync-flushable
    sink the flush is initiated but not awaited, and `log()` does not block.
18. **Encoding golden files** — a fixed record encodes byte-identically under
    `json` across all runtimes.

Test vector 18 is the strongest cross-language guarantee and SHOULD be maintained
as shared fixture data rather than reimplemented per language.

---

## 17. Appendix A — JSON Schema

Companion schema for the `json` encoding and the debug-wire `record` frame. This
is the artifact a non-TypeScript producer conforms to, following the precedent of
`packages/debug-wire/wire-schema.json`.

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://telo.run/schemas/log-record.json",
  "title": "Telo log record",
  "type": "object",
  "required": ["time", "level", "severity", "msg"],
  "additionalProperties": false,
  "properties": {
    "time": {
      "type": "string",
      "format": "date-time",
      "description": "RFC 3339, UTC, nanosecond precision, Z suffix."
    },
    "level": {
      "type": "string",
      "description": "Canonical short name, or the original spelling when bridged."
    },
    "severity": {
      "type": "integer",
      "minimum": 1,
      "maximum": 24,
      "description": "OTel SeverityNumber. 0 (UNSPECIFIED) must not be emitted."
    },
    "msg": { "type": "string" },
    "trace_id": { "type": "string", "pattern": "^[0-9a-f]{32}$" },
    "span_id": { "type": "string", "pattern": "^[0-9a-f]{16}$" },
    "trace_flags": { "type": "integer", "minimum": 0, "maximum": 255 },
    "resource": {
      "type": "object",
      "required": ["kind", "name"],
      "properties": {
        "kind": { "type": "string" },
        "name": { "type": "string" },
        "id": { "type": "string" }
      }
    },
    "module": { "type": "string" },
    "scope": {
      "type": "string",
      "description": "Dotted import-alias path of the emitting module context, e.g. `Api.Domain.Db`. Absent at the root."
    },
    "event_name": { "type": "string", "maxLength": 256 },
    "attributes": { "type": "object" },
    "err": { "$ref": "#/$defs/ErrorValue" },
    "dropped_attributes_count": { "type": "integer", "minimum": 1 }
  },
  "$defs": {
    "ErrorValue": {
      "type": "object",
      "required": ["type", "message"],
      "properties": {
        "type": { "type": "string" },
        "message": { "type": "string" },
        "stack": { "type": "string" },
        "cause": { "$ref": "#/$defs/ErrorValue" }
      }
    }
  },
  "dependentRequired": { "span_id": ["trace_id"] }
}
```

Debug-wire frame extension — added to `wire-schema.json`'s `oneOf`:

```json
{
  "title": "Record frame",
  "type": "object",
  "required": ["kind", "timestamp", "record"],
  "properties": {
    "kind": { "const": "record" },
    "timestamp": { "type": "string", "format": "date-time" },
    "record": { "$ref": "https://telo.run/schemas/log-record.json" }
  }
}
```

---

## 18. Appendix B — Sourcing notes

Load-bearing claims are drawn from primary sources: the OTel Logs Data Model
(stable) for the record fields and the 24-value severity table; OTel's Logs API
for the `Enabled` requirement; Go's `log/slog` documentation for the `−9` offset;
W3C Trace Context for id formats; the OTLP specification for the JSON mapping and
its hex-not-base64 deviation; and the pino, zap, and `tracing-appender` sources
for buffering defaults and redaction syntax.

Four corrections to widely-repeated folklore, verified against source and worth
recording so they are not reintroduced:

- **SonicBoom's `minLength` defaults to `0`, not `4096`.** The 4096 figure appears
  only in a pino documentation *example*. Combined with `maxLength` defaulting to
  `0` (unbounded), pino has **no drop policy active by default** — which is why
  §10.3 forbids unbounded buffers rather than inheriting a default.
- **pino-pretty's README defaults contradict its source.** `index.js` is
  authoritative.
- **The one-wildcard-per-redaction-path limit is an implementation artifact**, not
  a property of the syntax — it stems from compiling accessors via the `Function`
  constructor. §14 deliberately does not inherit it.
- **OTel does not name the `Authorization` header** in any normative text. The
  citable rule is the generic `Opt-In` requirement level plus "including all
  request headers can be a security risk." §14.4 is written against the citable
  rule, not the folklore.

One structural gap worth recording: **OTel never states the log/trace
auto-correlation guarantee in one place.** It is assembled from the Logs API
("if unspecified then MUST use current Context") plus the Logs Data Model's field
definitions, with the actual attachment happening in each SDK. §7.2 states it as
a single normative sentence precisely because implementers cannot be relied on to
assemble it from two documents.

Claims deliberately *excluded* pending verification: zap's production
encoder-config literal output, pino's error-object internal message key under
varying `messageKey` configuration, ECS's field list and its contested
dotted-versus-nested rule, and OTLP/JSON hex case-sensitivity on read. None are
load-bearing for this spec.

The console color table (§11.2) is a modal synthesis across six libraries that do
not fully agree — zap alone uses magenta for DEBUG and blue for INFO, and TRACE
has no consensus (gray vs. purple). It is a deliberate choice, not a standard.
