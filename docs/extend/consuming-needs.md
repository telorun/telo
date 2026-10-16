---
sidebar_label: Consuming Needs
slug: /extend/consuming-needs
description: "Write a kind that takes a need's whole fulfilment at a reference slot, opens it with ctx.resolveNeed, and reports the version and features it found with ctx.verifyNeed so the kernel can enforce the need's constraints."
---

# A kind that consumes and verifies a need

A module reads a need's fields one at a time in CEL
(`resources.databaseAccess.url`). A kind that **opens** the thing — a
connection to the database the fields address — takes the whole fulfilment
instead, at a reference slot, and is the one place that can check the need's
constraints against the real thing: the server's version, the extensions it has.

## The slot

```yaml
kind: Telo.Definition
metadata:
  name: Connection
capability: Telo.Provider
controllers:
  - pkg:telo/local/js?path=./nodejs/postgres.mjs&local_path=./nodejs/src/index.ts#Connection
schema:
  type: object
  required: [access]
  properties:
    access:
      x-telo-ref:
        kind: Self.DatabaseAccess
        use: dependency
        observes: [version, features]
```

The slot accepts a need or a self-supplied fulfilment of its need type, and
nothing else: a need of another type is `REFERENCE_KIND_MISMATCH`, a value that is
not a `!ref` is `INVALID_REFERENCE_FORM`, a computed one `REF_SLOT_COMPUTED`. An
`optional: true` need may be absent, so a `!ref` to one at any kind's reference
slot is `NEED_OPTIONAL_REFERENCED` — an optional need is read by guarded field
reads, or forwarded to a need that is itself optional.

`observes` lists the constraints the kind reports for the fulfilment it opens:
`version`, `features`, or both. It is the declaration that says this kind checks
them, so it sits on the slot of the kind that opens the fulfilment and nowhere
else. It is refused (`X_TELO_REF_INVALID_OBSERVES`, and
`ERR_X_TELO_REF_INVALID_OBSERVES` when the kernel registers the kind) when:

- it names anything but `version` / `features`;
- the slot's kind is not a need type, or its need type does not declare the
  constraint (`version: semver`, a `features:` list);
- the kind's capability has no moment the report is due — only `Telo.Provider`,
  `Telo.Service`, `Telo.Runnable` and `Telo.Invocable` observe, because the
  kernel holds each to the return of one entry point (below);
- the kind's instances are served by the kernel's template controller, which has
  no code to make the report.

A `Telo.Abstract` may declare an observing slot as a contract; each kind
extending it inherits the slot and is judged by the same rules, by `telo check`
as by the kernel. A Sink or a Mount that needs the
database holds a resource of a kind that opens it — a Provider observing at its
own slot — rather than observing itself.

## Opening the fulfilment

A fulfilment is never handed to a controller as an instance: the slot keeps its
reference, and `ctx.resolveRef` on it is `ERR_REF_UNRESOLVED`. The controller
opens it by naming the slot with a JSON Pointer into its own manifest:

```ts
init(ctx) {
  const access = ctx.resolveNeed("/access");
  // access.fields.url, access.sensitive (["url"]),
  // access.constraints ({ version: ">=15.0.0", features: ["pgvector"] }),
  // access.parameters, access.target (the fulfilment's handle)
}
```

Only a reference slot of the resource's own kind that holds a need's fulfilment
answers; any other pointer is `ERR_REF_UNRESOLVED`, naming it. `constraints` and
`parameters` are those of the **outermost need** of the whole-forward chain the
fulfilment came through: when an application forwards its own `>=16.0.0` need to
a library asking `>=15.0.0`, the consumer inside the library is handed
`>=16.0.0`, because that is what is enforced. A slot referencing a self-supplied
fulfilment directly, with no need in between, has no constraints.
`sensitive` names the fields that are sensitive as delivered — those marked
`x-telo-sensitive`, and a field whose value type declares a sensitive member when
its value holds one (a `Telo.Url` carrying a password) — and their values are
already in the redaction set of every module context the fulfilment reaches. A
`Telo.Url` field arrives as a URL value: read its members as properties
(`access.fields.url.host`) and hand a client its text with `toPlainJson(url)`
from `@telorun/sdk`.

## Reporting what you found

On the connection it makes anyway, the controller reads the server's version and
what it carries, and reports both:

```ts
ctx.verifyNeed("/access", {
  version: "15.4.0",          // semver text
  features: ["pgvector"],     // what is present; names the type does not list are ignored
});
```

**The kernel compares; the controller does not.** No controller reads a range.
A mismatch is `ERR_NEED_UNMET`, worded by the kernel and carrying, in `data`,
`need` (the need path), `type`, `source` (`env`, `declaration` or `host`),
`required` and `actual` — the message names the environment variable or the
declaration the value came from, so an operator knows what to change.

The report has one member per constraint the slot observes, and is refused
(`ERR_NEED_OBSERVATION_INVALID`, naming the kind and the slot) when it reports a
member the slot does not observe, leaves an observed one out, or gives a version
that is not semver (`X.Y.Z`, optionally `-prerelease`).

**It is due by the end of startup**, whether or not the need states a constraint:

| Capability | Due when |
| --- | --- |
| `Telo.Provider` | `init()` returns |
| `Telo.Service` | `run()` returns |
| `Telo.Runnable` | the first `run()` returns |
| `Telo.Invocable` | the first `invoke()` returns |

An observing slot not reported by then fails that entry point with
`ERR_NEED_OBSERVATION_INVALID`. A fulfilment the consumer cannot reach — a
refused connection — fails as the consumer fails, never as `ERR_NEED_UNMET`.

## Every stated constraint is enforced or refused

A need's `version:` / `features:` must reach at least one slot observing it,
walking from the need through the reference slots of its own module — its
resources, the declarations written inline in them, and the `resources:` entries
of its templated kinds' bodies, where a `!ref` naming the need (not a sibling
entry) counts — and every need it is forwarded to whole by `!ref` at an import,
through `isolated` and `shared` libraries alike. A templated kind need not
observe anything itself: the body entry's own kind observes, and that entry is
held to the report like any other instance. Field reads, field-by-field supply and anything upward
of the declaring module do not count. One that reaches none is
`NEED_CONSTRAINT_UNVERIFIED` at the need's `version:` / `features:` key, and the
kernel refuses it at load (`ERR_NEED_CONSTRAINT_UNVERIFIED`) before any resource
initializes. Because the walk goes only down the import closure, a library gets
one verdict for its own needs under every importer — and an application
importing a library whose constraint nothing verifies is told so at its
`imports:` entry.

## Across the protocol

`ctx.resolveNeed` and `ctx.verifyNeed` are the Node spelling of the protocol's
`Need.Resolve` and `Need.Verify` messages. See
[the controller protocol](./controller-protocol.md).

## See also

- [Writing a need type](./need-types.md)
- [Declaring a need](/learn/declaring-a-need)
- [Providing needs](/learn/providing-needs)
- [Diagnostics reference — needs](/reference/diagnostics#needs)
