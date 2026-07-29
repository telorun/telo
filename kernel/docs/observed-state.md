---
description: "Declared observed state: the status: block on a kind, the resources.<name>.status CEL segment, and where reported values may be read"
---

# Observed state (`status:`)

A resource has two kinds of value worth publishing, and they are not the same
thing:

- **What its author configured** — the port you asked for, the base URL you
  wrote. Known before anything runs.
- **What it observed** — the port the socket actually got, the endpoint a
  negotiation produced. Known only once the resource is running.

The first is published flat, at `resources.<name>.<field>`. The second is
declared with a `status:` block on the kind and published under its own segment,
`resources.<name>.status.<field>`. Keeping them apart means neither has to be
renamed to avoid the other.

## Declaring what a kind reports

`status:` is a JSON Schema on a `Telo.Definition` (or a `Telo.Abstract`, so a
contract can mandate what its implementations report). Declaring it — even
empty — opts the kind into typed `.status` reads. A kind that declares nothing
behaves exactly as before.

```yaml
kind: Telo.Definition
metadata:
  name: RedirectListener
capability: Telo.Service
schema:
  type: object
  properties:
    port:
      type: integer
      description: Pin a port; omit to let the OS choose one.
status:
  type: object
  properties:
    port: { type: integer }
    redirectUri: { type: string }
```

`port` is what the author asked for; `status.port` is what the socket got.

`required:` is rejected inside `status:`. Every declared field is mandatory once
the resource has run, so the list would be either redundant or a lie. A field
that is genuinely sometimes-absent is declared with a nullable type instead,
which `CEL_NULLABLE_ACCESS` already guards.

Through `extends`, a child without `base:` merges its parent's `status:`; a
child with `base:` publishes the parent's unchanged, because it *is* a parent
instance. The chain is folded in the scope that **declared** each definition,
never the consumer's: an `extends` alias belongs to the file it was written in,
so an abstract's `status:` reaches a consumer that imports only the
implementation (the sanctioned "one import instead of two"). The kernel stamps
the folded block onto the definition at registration; the analyzer re-scopes per
declaring module and reaches the same answer.

## Reporting it from a controller

The two halves travel on different channels, because only one of them is
derivable on demand. **Configured state is pulled** — `snapshot()` returns it
and the kernel calls that whenever it needs the value. **Observed state is
pushed** — `ctx.setStatus(...)` reports it at the moment it is learned, because
nothing but the controller knows when that is.

```ts
async run() {
  this.server.listen(this.config.port ?? 0);
  await ctx.setStatus({
    port: this.address.port,
    redirectUri: `http://127.0.0.1:${this.address.port}/callback`,
  });
}

snapshot() {
  return { port: this.config.port ?? 0 };
}
```

That split is what keeps each shape described in exactly one place: the
controller never rebuilds observed state inside `snapshot()` from a field it
stashed only for that purpose, and the two payloads can never collide.

Rules the kernel enforces:

- **Reporting replaces, never merges.** This is the resource's observed state
  now. A declared field the call omits reads as missing, which is the truth —
  declare a sometimes-absent field with a nullable type and report it as `null`.
- **Reporting before the resource has started is an error**
  (`ERR_OBSERVED_STATE_BEFORE_START`). `init()` performs no I/O, so there is
  nothing observed to report there.
- **Every report is validated** against the kind's `status:` at the call that
  made it (`ERR_OBSERVED_STATE_INVALID`, or `ERR_OBSERVED_STATE_UNDECLARED` when
  the kind declares no block), so an invalid claim is refused where it was made
  rather than surfacing at some later publication.
- **A reading is sticky.** The last value reported stays published until the
  resource is torn down: a dispatch that reports nothing leaves it in place,
  because a listener's bound address does not stop being true between calls.
- **A publication is a reading, not a live window.** The published value is
  detached from what the controller handed over — plain objects and arrays are
  rebuilt, while class instances and functions pass through — so mutating a
  reported structure cannot rewrite what was already published.
- **`status` is only reserved for kinds that declare it.** A kind with a
  `status:` block may not also return a flat `status` field
  (`ERR_OBSERVED_STATE_KEY_COLLISION`); a kind with no block may use the name
  freely.

## Reading it

Observed state flows into **calls**, never into **configuration**. A resource is
created before anything runs, so a field that resolves at startup can never take
a reported value. Read it where the call happens: a step's `inputs:`, an
invoke-time field like `Http.Request`'s `url`, a route handler, or a `returns:`
expression.

```yaml
steps:
  - name: auth
    invoke: !ref authorization
    inputs:
      redirectUri: !cel "resources.loopback.status.redirectUri"
```

The analyzer rejects the rest before the application starts:

| Diagnostic | When |
| --- | --- |
| `OBSERVED_STATE_IN_STARTUP_FIELD` | the read sits in a field annotated `x-telo-eval: compile` (or a `Telo.Provider` field, which is implicitly one) |
| `OBSERVED_STATE_NEVER_RUN` | nothing can start the producing resource — it is in no `targets:` list and named by no step's `invoke:` |
| `CEL_UNKNOWN_FIELD` | the field is not one the kind declares it reports |
| `OBSERVED_STATE_REQUIRED_FORBIDDEN` | the `status:` block declares `required:` |

Cross-module reads are checked identically: an import's exported instances are
typed under `resources.<Alias>.<name>.status`, so a typo there fails where it is
written rather than at runtime.

The first rule is purely syntactic — it inspects the access chain, not the
topology — so it applies to every kind, declared or not.

Genuine ordering is not decidable statically: a handler can be invoked from
anywhere, so a runtime-evaluated read may legitimately run before the producing
resource has started. What remains is caught at runtime, as three separate
errors rather than one hedge, because each needs a different action from the
reader and only the kernel — which records both whether the resource started and
whether its `run()` returned — can tell them apart:

- **The resource has not started.** Edit the `targets:` that runs before this
  value is read.
- **The resource started but is still running.** The read raced a service that
  is still coming up. Move the read later, or have the producer report before it
  becomes reachable.
- **The resource's `run()` returned and it never reported.** That is a defect in
  the producing module — it declares observed state and never calls
  `setStatus`; no change to the reading manifest fixes it, and the error names
  the module. Only reachable for a one-shot Runnable — a long-lived Service's
  `run()` never returns, so it is never blamed for what is actually ordering.

All three raise `ERR_OBSERVED_STATE_UNAVAILABLE`. None yields an empty value or
a bare key error.

## Scoped resources

A `with:`-scoped resource publishes like any other. Each `ScopeHandle.run()`
gets its own map of the scope's resources, layered at read time over the
enclosing module's — the outer half stays live, so a resource that republishes
mid-sequence is visible to later steps — with scope-local names winning — the same order `!ref` resolution uses, so CEL and
references never disagree. Two concurrent runs of the same sequence never
observe each other's scoped resources. A scoped name resolves only inside the
regions `x-telo-scope` annotates (`/steps`, `/targets`); outside them it does not
resolve at all.
