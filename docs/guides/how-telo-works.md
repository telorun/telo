---
description: "The mental model behind Telo: manifests, resources and kinds, capabilities, the multi-pass init loop, where side effects live, and why a manifest stays statically analyzable."
---

# How Telo works

Telo is a runtime, not a framework you import. You hand it a YAML manifest
describing what should exist; it works out the order things must be built in,
builds them, and runs what you told it to run.

This page is the mental model. Nothing here is required to write your first
manifest — but everything else in the docs assumes it.

## Manifests, resources, kinds

A **manifest** is a YAML file of one or more documents separated by `---`. The
first document is always `Telo.Application` (a runnable entry point) or
`Telo.Library` (an importable unit). Every document after it declares one
**resource**:

```yaml
kind: Http.Server        # what sort of thing this is
metadata:
  name: Server           # what to call it
port: 8080               # its configuration, at the top level
```

There is no `spec:` wrapper — a resource's fields sit directly on the document.

`kind:` names a **resource kind**, and the prefix before the dot is an **import
alias you chose**. Write `Http: oci://ghcr.io/telorun/http-server@…` in your
`imports:` map and the kind is `Http.Server`; alias it `Web` and the same kind
is `Web.Server`. A module never dictates its own prefix.

## Kinds are declared, not built in

The kernel knows nothing about HTTP, SQL, or AI. Each kind is declared by a
`Telo.Definition` inside some module's manifest, which carries:

- a **JSON Schema** for the resource's fields — this is what `telo check`
  validates your YAML against, and what the editor completes from;
- a **capability**, naming its lifecycle role;
- a **controller**, the code that implements it.

That is the whole extension mechanism. A kind you write yourself is
indistinguishable from `Http.Server` — see [Authoring a module](/extend/authoring-a-module).

## Capabilities

A kind's capability determines how it participates in the lifecycle, and which
slots will accept it:

| Capability | The controller implements | Typical kinds |
| --- | --- | --- |
| `Telo.Service` | `init()`, `run()` | Servers, connection pools — long-lived |
| `Telo.Runnable` | `run()` | One-shot tasks, sequences, pipelines |
| `Telo.Invocable` | `invoke(inputs)` | Handlers, scripts — things you call |
| `Telo.Provider` | `provide()` | Configuration and value sources |
| `Telo.Mount` | mounted into a service | HTTP routers, middleware |
| `Telo.Sink` | `write(record)`, `flush()` | Log sinks — record-stream destinations |
| `Telo.Type` | nothing — schema only | Shared type declarations |

A kind may instead be declared as a **`Telo.Abstract`**: a contract with no
implementation, which exists to be extended. `Sql.Connection` is one — you never
instantiate it, you instantiate `SQLite.Connection`, which `extends` it. Any slot
that accepts the abstract accepts every kind that extends it, which is how one
manifest swaps SQLite for Postgres by changing an import.

Capability governs **wiring**, not dispatch. A step's `invoke:` slot accepts an
Invocable or a Runnable; an application's `targets:` accepts a Runnable or a
Service. A resource that must be both started *and* called has to be two kinds,
because no single capability satisfies both slots.

## What happens when you run a manifest

```bash
telo ./manifest.yaml
```

1. **Load.** The manifest and every import are parsed, `!cel` expressions are
   compiled, and `variables:` / `secrets:` / `ports:` are bound from the host
   environment. A missing required variable fails here — before any code runs.
2. **Analyze.** The same static checks `telo check` performs run against the
   loaded graph: unknown kinds, broken references, CEL type errors.
3. **Init.** A multi-pass loop constructs each resource. A resource whose
   dependency is not ready yet is deferred and retried on the next pass, so you
   never declare an ordering — it is derived from the references. `init()`
   builds the instance and performs **no observable side effects**.
4. **Run targets.** Everything in `targets:` is dispatched.
5. **Wait.** The process stays alive while any **hold** is outstanding.

A long-lived resource takes a hold — `Http.Server` acquires one when it starts
listening and releases it on teardown. That is why an app whose target is a
server stays up, and an app whose targets all complete exits on its own. You
configure neither; both follow from what you declared.

## Where side effects live

`init()` builds; `run()` acts. `Http.Server` is the reference implementation:
`init()` registers routes and plugins, `run()` calls `listen()` and takes the
hold. This split is what makes the init loop safe to retry, and what makes an
init failure diagnosable.

There is no `teardown()`. Both methods **return** the effects they performed —
each allocation paired with the inverse that undoes it — and the runtime unwinds
them last-in-first-out when the resource is torn down, or as soon as a later step
fails. So the server that could not bind its port releases the hold it took a
line earlier without any recovery code of its own.

## Two ways a value flows

**Configured state is pulled.** After a resource initializes, the kernel reads
what its author configured and publishes it at `resources.<name>.<field>`, so
another resource's CEL can read it.

**Observed state is pushed.** What a resource *learns* while running — the port
a socket actually got, an endpoint a negotiation produced — is reported by the
controller when it knows it, and published under `resources.<name>.status.<field>`.
Because it only exists once something has run, reading it in a field that
resolves at startup is a static error. See [Observed state](/reference/kernel/observed-state).

## Composition instead of glue

Wiring resources together is itself declarative:

- **`!ref`** points one resource at another. The slot declares which kinds it
  accepts, so a wrong reference is caught before anything runs.
- **`!cel`** computes a value from what is in scope at that point.
- **`Run.Sequence`** orders steps, with conditionals, loops, and error
  handling — see [Composing behaviour](/learn/composing-behaviour).

Both tags are covered in [`!ref` and `!cel`](/learn/refs-and-cel).

## Why it is static

Because a manifest is data rather than code, the whole graph can be examined
without running it. That is what `telo check` and the VS Code extension do:
resolve every import, type-check every expression against the schemas the kinds
declare, and verify that each reference points at a kind the slot accepts. Most
mistakes are caught before the process starts, which is a property Telo protects
deliberately — anything that would make a manifest un-analyzable is out of
bounds.

## Next

- [Your first HTTP API](/learn/first-http-api) — build one.
- [`!ref` and `!cel`](/learn/refs-and-cel) — the syntax this all rests on.
- [Glossary](/learn/glossary) — every term on this page, defined.
