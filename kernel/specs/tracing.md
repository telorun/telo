---
description: "v1.0 spec: trace export — how a root Application turns tracing on with trace sinks, what a finished span carries, how spans parent, how a contract puts values on a span, and the built-in and OTLP trace sinks"
---

# Telo Tracing Specification (v1.0)

## 0. Status, scope, and how to read this

This is a **runtime conformance specification**. It defines when a Telo runtime
traces, what a finished span carries, how spans nest, and how finished spans
reach the destinations an application declares. The key words **MUST**,
**MUST NOT**, **SHOULD** and **MAY** are to be interpreted as described in
RFC 2119.

**In scope:** the `tracing:` block, the span record, span parenting, the
`x-telo-span-attribute` annotation, the `Telo.TraceSink` contract and the
`Telo.LogTraceSink` built-in. `OTLP.TraceSink` is a module (§6.3) and its
section is normative for OTLP export only.

**Out of scope:** metrics. There is no metrics signal: a counter or a histogram
is an aggregation over spans — a count of `execute_tool` spans, a distribution
of their durations — computed by the backend that receives them. Sampling is
not specified; every finished span is exported.

**Relationship to logging.** Identifier formats are the logging specification's
(`logging.md` §7.1): a trace id is 32 lowercase hex characters, a span id 16,
and a runtime keeps ids as counters internally and renders them only at the
encoding boundary. A log record emitted inside a span carries that span's ids
(`logging.md` §7.2); a span exported through `Telo.LogTraceSink` carries the same
ids, so the two join by string equality.

The Rust kernel does not implement trace export. It MUST refuse a module doc
declaring `tracing:` with `ERR_UNSUPPORTED_MANIFEST_FEATURE` naming the field
("exporting trace spans"), never run it with the spans silently absent.

---

## 1. Turning tracing on

```yaml
kind: Telo.Application
metadata:
  name: my-app
tracing:
  sinks:
    - kind: Telo.LogTraceSink
    - sink: !ref collector
      when: !cel "variables.exportSpans"
```

`tracing.sinks` is a list of entries, each either a trace sink — an inline
declaration or a `!ref` to one declared elsewhere — or `{ sink, when }`, where
`sink` is such a sink and `when` a boolean (default `true`). `when` MUST evaluate to a boolean. A runtime MUST refuse any other result at load, naming the entry's `when` (`ERR_MANIFEST_VALIDATION_FAILED`), and MUST NOT coerce it. The entry shape is
`logging.sinks`' (`logging.md` §12.1), one schema for both lists. The block is
evaluated once at load with `variables`, `secrets` and `ports` in scope, as
`logging:` is; a module call there is `FUNCTION_CALL_UNBOUND`, since no module's
functions are bound at load.

- The runtime attaches **exactly the sinks the list names** whose entry holds,
  each right after it is created, so spans finished while the rest of the graph
  initializes reach it (an instance an import exports, `!ref <Alias>.<name>`,
  once the graph is up). An entry whose `when` is `false` leaves its sink created
  and unattached.
- Tracing is **on** while at least one trace sink is attached, or while a debug
  consumer (`--debug` / `--inspect`) holds it on. Otherwise it is **off**, and a
  runtime MUST NOT mint span ids, establish per-dispatch trace scope, or build a
  span record: tracing off costs nothing. An application whose listed sinks are
  all unattached traces exactly as one with no `tracing:` block.
- A sink never attaches itself. A trace sink declared and not listed — at the
  top level, or inside an imported library — receives nothing; `telo check`
  warns `SINK_UNATTACHED` at a sink resource nothing references and its module
  does not export (§6.1).
- `tracing:` is a **root-Application** key. Exporting spans is process-level
  I/O and the application's decision, never an imported library's: a
  `Telo.Library` declaring it is refused by `telo check` and by the runtime,
  both as a schema violation of the library document.

A debug consumer and a trace sink are independent: detaching the debugger leaves
tracing on while a sink is attached, and the debug wire keeps its own trace
events (which do carry inputs and outputs, redacted per `x-telo-sensitive`) —
those events are not the span record defined here.

## 2. What is a span

A runtime MUST produce a span for:

| Span | Name | Opened |
|---|---|---|
| Every `invoke` dispatch through the kernel's chokepoint | `invoke <resource name>` | when the dispatch starts |
| Every `run` dispatch (a boot target, a `Run.Sequence` target) | `run <resource name>` | when the dispatch starts |
| The root Application's boot run | `run <application name>` | before its first target |
| A span a controller opens (`ctx.openSpan`) | the `label` it passes, else its `ref.name` | when opened |

A controller-opened span is how a unit of work that is not a dispatch — an HTTP
request, an agent's model call — becomes a span. A dispatch the controller then
makes on that span's context nests under it (§4).

A span **finishes** when its dispatch returns or throws, or when the controller
settles it. Every finished span is handed to every attached sink, once.

## 3. The span record

| Field | Meaning |
|---|---|
| `traceId` | 32 lowercase hex characters. |
| `spanId` | 16 lowercase hex characters. |
| `parentSpanId` | The parent span's id; absent at a trace root. For a span continuing an upstream trace (§4) it is the upstream span's id, exported verbatim. |
| `name` | §2. |
| `startTime`, `endTime` | Nanoseconds since the Unix epoch. |
| `outcome` | `ok` \| `rejected` \| `failed` \| `cancelled` \| `parked`. |
| `attributes` | A map of `AnyValue` (`logging.md` §6.1). |

**Outcome.** `ok` — returned. `rejected` — threw a structured, coded error
(`InvokeError`). `failed` — threw anything else. `cancelled` — the invocation's
cancellation fired, before or during it. `parked` — a durable run suspended
through it (`ERR_DURABLE_SUSPENDED`), which is neither success nor failure.

**Attributes the runtime sets.** On every dispatch span, `telo.resource.kind`
and `telo.resource.name`. On a `rejected` or `failed` span, `error.type`: the
error's code when it has one, else its class name — low-cardinality by
construction, never its message. On a `cancelled` span,
`telo.cancellation.reason`. These names are reserved (§5).

**Declared attributes** come from the dispatch's contract (§5) and from the
controller that opened a span (its `attributes`, merged with what `settle` adds).

**A span MUST NOT carry the dispatch's inputs, its outputs, or the CEL scope it
ran against.** Those are payload; a trace backend is not where payload is kept.
The only route from a dispatch's data to its span is an explicit mark (§5).

## 4. Parenting

A dispatch span's parent is the span of the context it was dispatched with — the
explicit context when the caller passes one, else the ambient one — and its
trace is that span's trace. With neither, the dispatch roots a new trace.

A controller-opened span's parent is, in order:

1. `inbound` when it carries a valid W3C `traceparent` (with its `tracestate`,
   as they arrived) — the span continues that upstream trace, as a child of the
   upstream span. An invalid or all-zero `traceparent` is ignored in full
   (`logging.md` §7.4) and the span roots a new trace;
2. the span the base context carries — so a span opened inside a dispatch is its
   child, and a run opening spans for its sub-steps builds a tree;
3. none — the span roots a new trace.

An inbound transport opens ONE span per unit of work (a request, a message)
before anything it runs for that unit — admission checks and body parsing
included — on `ctx.rootContext()`, which carries no span (`execution-zones.md`
§7), continuing a valid inbound `traceparent`. It dispatches all of that unit's
work on the span's context, so each unit is one local root with everything it
drove beneath it.

## 5. `x-telo-span-attribute`

```yaml
outputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    properties:
      checkExitCode:
        type: integer
        x-telo-span-attribute: telo.check.exit_code
```

Written on a **scalar property of a resource's `inputType` / `outputType`**, the
annotation puts that property's value on the resource's dispatch span under the
given name: an input property on every outcome, an output property on `ok`. An
absent or `null` value sets nothing.

A mark is well-formed when its name is dot-separated lowercase segments of
letters, digits and underscores, each starting with a letter, at most 255
characters, and is not one the runtime sets itself (§3).

A mark is **read** wherever the contract reaches it through `properties` alone,
following `$ref`: a union branch (`allOf` / `anyOf` / `oneOf`) at the same
position counts, a `$defs` entry a property references counts (resolved against
the document the reference sits in), a named shape (`!ref <Shape>`, a
`Telo.JsonSchema`) a property references counts, and a mark beside a `$ref`
counts, overriding the target's. A reached mark is well-placed when:

- the contract reaches it through a property — not at the contract's root, and
  not through an array item or a map value (`additionalProperties` /
  `patternProperties`), since each holds any number of values per dispatch;
- its node is scalar — `type` string, integer, number or boolean, optionally
  with `null`, or an `enum` / `const` of scalars;
- it is not beside `x-telo-sensitive: true`: a value marked as auth material is
  never exported.

A runtime binding a contract whose reached marks break a rule MUST refuse the
contract when it is first dispatched, with `ERR_SPAN_ATTRIBUTE_INVALID` naming
each problem — a mark the runtime cannot read is an attribute an author expects
and a trace would never carry.

`telo check` runs the same walk over the same resolved contract, so it reports
the same problems: a malformed or reserved name as `SPAN_ATTRIBUTE_INVALID` at
the mark; a non-scalar node or a mark beside `x-telo-sensitive: true` as
`SPAN_ATTRIBUTE_MISPLACED` at the mark; a mark reached at the root or through an
array item or a map value as `SPAN_ATTRIBUTE_MISPLACED` at the property through
which the contract reaches it (the contract itself for the root), once per
contract. A mark no contract reaches — in a kind's `schema:` / `status:`, a
`$defs` entry nothing references, a named shape no contract uses and its library
does not export — is inert at runtime and `SPAN_ATTRIBUTE_MISPLACED` at the mark.

## 6. Sinks

### 6.1 `Telo.TraceSink`

The abstract every trace sink kind extends: a kernel built-in, capability
`Telo.Sink`, resolvable without an import. It declares no fields; whether a sink
is attached is its list entry's decision (§1), never the sink's.

A trace sink is written to **directly**, never through dispatch — dispatching a
span would open a span. Its instance **is** the sink: it exposes the `Telo.Sink`
contract — `sinkId`, `write`, `flush`, `flushSync`, `close` — with the span
record as its record. `write(span)` MUST NOT throw (a runtime reports a sink
that does, and never propagates it into the dispatch whose span it was),
`flush()` drains, `flushSync()` drains where the destination allows it,
`close()` releases the destination after the final flush.

The runtime attaches a listed instance as an effect of the instance's creation;
the inverse flushes, detaches and closes it. A listed instance that does not
expose the contract is refused at creation with `ERR_SINK_CONTRACT_MISSING`,
naming the list entry (`tracing.sinks[0]`). Sinks tear down after every other
resource, so spans finished during shutdown still reach them. A sink nothing
lists is created and never written to; its inverse only closes it.

### 6.2 `Telo.LogTraceSink`

Writes each finished span as **one structured log record** through the logging
pipeline, so a span reaches every log sink the application declared.

| Field | Type | Meaning |
|---|---|---|
| `level` | one of the six named levels, default `info` | The record's severity. |

The record's message is the span's name, its event name `telo.span`, and its
trace and span ids are **the span's own** (not the span active when the record is
written, which is its parent). Its attributes are the span's attributes plus
`telo.span.outcome`, `telo.span.start_time` (RFC 3339), `telo.span.duration_ms`
and, below a root, `telo.span.parent_span_id`. The record passes the logging
pipeline's threshold like any other: a root level above the sink's `level`
suppresses it.

### 6.3 `OTLP.TraceSink` (module)

Exports finished spans to an OpenTelemetry collector's traces endpoint as an
OTLP/JSON `ExportTraceServiceRequest`, with `OTLP.Sink`'s configuration
(`endpoint`, `headers`, `resourceAttributes`, `timeout`, `buffer`, `on_full`,
`flush_interval`). The encoding follows `logging.md` §11.3's interop
rules (hex ids, decimal-string 64-bit times, integer enums, attribute lists).
Each span is `SPAN_KIND_INTERNAL`; `ok` maps to status `OK`, `rejected` and
`failed` to `ERROR` with `error.type` as the status message, `cancelled` and
`parked` to `UNSET`; the five-valued outcome also travels as the
`telo.span.outcome` attribute. Delivery is a network round-trip: a failed export
counts the whole batch as dropped and is reported, and nothing is synchronously
flushable.
