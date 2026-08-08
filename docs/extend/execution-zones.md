---
sidebar_label: Execution Zones
slug: /extend/execution-zones
description: "Declare that a resource must be reached through another resource's body — a transaction, a durable run, a batch — and have telo check say so before the path ever executes."
---

# Execution zones

Some resources only make sense **inside** another resource's body. A SQL
statement bound to a transaction has to be reached through that transaction; a
durable step that can park has to be reached through the run that owns its
journal. Until now that requirement was discoverable only by running the path —
possibly on a rare branch, possibly in production — even though the whole answer
is in the manifest.

An **execution zone** makes it declarable. Two schema annotations, and `telo
check` reports a statement wired onto a path that reaches it outside any
transaction before the route is ever exercised.

The runtime contract is normative in
[`kernel/specs/execution-zones.md`](https://github.com/telorun/telo/blob/main/kernel/specs/execution-zones.md);
this page is the authoring guide.

## The shape

A zone is **identified by the kind that provides it**. There is no new kind, no
capability, nothing instantiated — and the providing side never names a zone,
because the zone a slot provides *is* the declaring kind. Only the requiring
side writes a name, through the same alias-qualified grammar `extends` and
`x-telo-ref` use, so a misspelling is a resolution failure rather than a
silently unenforced constraint.

```yaml
# The provider: dispatching through `steps` establishes this kind's zone.
kind: Telo.Definition
metadata:
  name: Transaction
capability: Telo.Invocable
schema:
  properties:
    connection:
      x-telo-ref: { kind: Self.Connection, use: dependency }
    steps:
      x-telo-ref: { kind: Telo.Executable, use: call }
      x-telo-provides-zone: /connection   # ← correlation key, not the zone
---
# The requirer: must be reached through such a zone.
kind: Telo.Definition
metadata:
  name: Command
capability: Telo.Invocable
schema:
  properties:
    transaction:
      x-telo-ref: { kind: Self.Transaction, use: dependency }
      x-telo-requires-zone:
        zone: Self.Transaction
        key: [/connection, /transaction/connection]
        reason: the statement would execute outside any transaction
```

Note what the `transaction:` slot is: a `dependency`, not a call. Control never
transfers through it. What it carries is the *requirement*.

### `x-telo-provides-zone: true | <pointer>`

On a body slot. The value is the **correlation key**, never the zone: `true`
establishes the zone uncorrelated, and a self-relative JSON pointer names the
kind's own field whose resolved reference the zone carries as its correlation
payload.

### `x-telo-requires-zone`

On a resource's field. The string form (`x-telo-requires-zone: Self.Batch`)
names the zone kind and asserts nothing else. The object form adds:

- **`key`** — one self-relative JSON pointer or an ordered list tried in order,
  first hit winning. A pointer may traverse a `!ref` into the referenced
  resource's own field. When nothing resolves the requirement discharges
  *uncorrelated* — any zone of the right kind satisfies it.
- **`reason`** — optional; the runtime consequence, quoted after the path in
  diagnostics.

## Why a key is a list

`connection:` is optional on `Sql.Query` / `Command` / `Selection`, and the
idiomatic statement omits it, letting the controller derive one from the
transaction it names:

```ts
resolveSqlConnection(connection) ?? transaction?.getConnection()
```

A single `key: /connection` would resolve to nothing in exactly that common
shape, leaving correlation undefined where it matters most. The list
`[/connection, /transaction/connection]` is the manifest-level transcription of
that `??`. Traversal is mechanical — read field, resolve reference, read field —
so the analyzer names no kind; what derivation exists is declared by the author
who owns the controller.

A traversing pointer may only reach into a kind **the declaring module owns**
(`Sql.Command` may read `Sql.Transaction.connection` because one author owns
both). Naming a field of another module's kind is `ZONE_PROVIDER_UNRESOLVED`:
that is the one shape where the annotation would depend on a field name its
author cannot keep true.

## What the checker does with it

Zone semantics are a **projection of `use`** — the typed reference graph already
says, for every edge, when control reaches the target relative to the declaring
resource's own invocation, and zones read that one fact:

| `use` | what happens to a requirement crossing it |
| --- | --- |
| `call` | propagates callee → caller; a providing slot discharges it |
| `detached`, `trigger.inbound` | **error** — the runtime *guarantees* a fresh context, so it can never be satisfied |
| `trigger.consumer` | **warning** — the drain site decides where the dispatch runs |
| `dependency`, `schema` | no edge; requirements neither enter nor leave |

Two more rules matter in practice. A **case map** resolves per instance, so a
`Cache.View` under the default `revalidate: sync` is a plain `call` and a
requirement travels straight through it. A **set** like `[call, detached]` says
several relations hold at once — the controller really does detach on some
dispatch — so the requirement is violated on that path and it **errors**;
propagation, separately, needs *every* member to be `call`. And nothing encloses
an Application's `targets:`, so an open requirement arriving at boot errors
there.

The check **under-approximates on purpose**: an edge whose `use` cannot be
decided neither propagates nor terminates, it warns. The runtime is the
enforcement; static analysis moves the failure earlier for the paths it can see.

## Diagnostics

- **`ZONE_REQUIREMENT_UNSATISFIED`** (error) — the requirement reached an edge
  that provably clears the zone, or reached boot. Names the requiring resource,
  the wanted zone and its correlation target, the propagation path, and the
  author's `reason`.
- **`ZONE_REQUIREMENT_DEFERRED`** (warning) — genuinely undecidable: a
  `trigger.consumer` edge (a consumer may drain the value *inside* the zone), an
  unresolvable case-map selector, or an edge with no declared `use`. The message
  says which. Note the discriminator against the error above: an edge is
  undecidable only when the target *might* be in a zone, never when a guaranteed
  fresh context is among the ways it is dispatched.
- **`ZONE_EXPORT_UNSATISFIABLE`** (error) — a library exports a resource whose
  open requirement correlates on something it does *not* export, so no importer
  can satisfy it. Raised at the library's own check, the one desk where it is
  fixable.
- **`ZONE_PROVIDER_UNRESOLVED`** (error) — the zone name resolves to no kind.
- **`ZONE_ANNOTATION_INVALID`** (error) — an annotation neither half can read: a
  `provides` value that is not `true` or a pointer, a `requires` object with no
  `zone`, or a correlation key that is not a self-relative JSON Pointer. These
  are reported rather than tolerated because the two annotations fail in
  opposite directions — an unreadable requirement is silently unenforced, an
  unreadable provision invents failures — and a bare-name key would be read by
  the runtime but skipped by the checker, so the two would disagree about what
  the manifest means.

## Writing the controller

A zone-bearing kind is always two halves that must agree, so the runtime half is
written against the same annotations. A controller names **its own annotation
site, never a kind** — it has no alias scope of its own, and a hand-copied
canonical string is exactly the disagreement this design exists to prevent.

```ts
// Providing — "steps" is this kind's own slot. The kernel reads
// `x-telo-provides-zone` there for the zone kind (itself) and the correlation
// key, so nothing here names either.
return this.ctx.withZone("steps", (zoneCtx, entry) => {
  bind(entry); // hand the entry to whatever holds this zone's private state
  return this.ctx.invokeResolved(kind, name, this.steps, inputs, zoneCtx);
});

// Requiring — "transaction" is this kind's own field. Throws ERR_ZONE_REQUIRED
// when no matching zone is open, including one open on a different connection.
const zone = this.ctx.requireZone("transaction", invokeCtx);
```

`withZone` is a scope function rather than a push/pop pair, because push/pop
cannot be honest across async boundaries. It hands back the derived context (to
thread into the body dispatch, the discipline cancellation already has) and the
minted entry (what a provider with private state keys its own map on).

For the undeclared ambient case — a statement with **no** `transaction:` still
joins an open one — there is no annotation to read, so the provider asks for
zones correlated on an instance it holds and lets its own map discriminate:

```ts
const entry = zone ?? this.ctx.zonesFor(this).find((e) => this.#executors.has(e));
```

### Where private state lives

**Provider-private state hangs off an injected instance, never a module
import.** A module's controllers may ship as separate bundles, each inlining its
own copy of every shared source file, so a `const map = new WeakMap()` beside
the controllers is one map *per bundle* — the write and the read never meet.
Put it on the resource that already crosses the boundary by reference (the
connection, injected into both), keyed on the `ZoneEntry`:

```ts
// modules/sql/nodejs/src/sql-connection-base.ts
readonly #executors = new WeakMap<ZoneEntry, Kysely<any>>();
```

And when a caller passes an explicit zone your map does not know, **throw**
rather than fall back to the unzoned path: the caller declared a requirement,
and a silent fallback turns a delivery split into silently non-transactional
execution — strictly worse than a loud failure.

### Registering an inbound trigger

An inbound registrant (HTTP route, MCP tool, timer, queue consumer) dispatches
with a context it minted, never `undefined`:

```ts
const cancellation = this.ctx.createCancellationSource();
const span = await this.ctx.openSpan(this.ctx.rootContext({ cancellation }), { … });
await this.ctx.invokeResolved(kind, name, handler, input, span.context);
```

That is what makes the handler's zone stack empty regardless of what was ambient
when the trigger was registered — and it is what the checker's hard error on
`trigger.inbound` edges rests on. Every other clearing is automatic:
`ctx.runDetached` replaces the ambient context, and a `Telo.Service`'s `run()`
is dispatched with no ambient scope at all.

## A complete third-party example

An outbox that must be written inside a batch. Uncorrelated, the simpler shape:

```yaml
kind: Telo.Definition
metadata:
  name: Batch
capability: Telo.Invocable
schema:
  properties:
    steps:
      x-telo-ref: { kind: Telo.Executable, use: call }
      x-telo-provides-zone: true
---
kind: Telo.Definition
metadata:
  name: Enqueue
capability: Telo.Invocable
schema:
  properties:
    batch:
      x-telo-ref: { kind: Self.Batch, use: dependency }
      x-telo-requires-zone:
        zone: Self.Batch
        reason: the message would be written outside any batch, losing atomicity
```

```ts
// batch-controller.ts
return this.ctx.withZone("steps", (zoneCtx, entry) => {
  pending.set(entry, []);
  return this.ctx.invokeResolved(kind, name, this.steps, inputs, zoneCtx);
});

// enqueue-controller.ts
const zone = this.ctx.requireZone("batch");
pending.get(zone)!.push(message);
```

Neither controller writes the module's own name, the other kind's name, or an
alias. `"steps"` and `"batch"` are fields of the schema sitting right beside the
code; everything else — which kind the zone is, what it correlates on, which
resource provides it — comes from the annotation.
