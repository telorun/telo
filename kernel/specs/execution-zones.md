---
description: "v1.0 spec: execution zones — the ambient zone stack on the invocation context, the provides/requires annotations, correlation, instance identity, clearing guarantees, and the provider-private payload rule"
---

# Telo Execution Zones Specification (v1.0)

## 0. Status, scope, and how to read this

This is a **runtime conformance specification**. It defines how a Telo runtime
carries the ambient **zone stack**, how a controller opens a zone declared by its
schema and how another asserts it is inside one, what identities a zone entry
carries, when the stack is guaranteed cleared, and where a provider's private
state may live.

It is normative for the same reason the invocation contract is: the annotations
bind every controller of a kind, including a second language's — `console` and
`starlark` already ship dual Node/Rust controllers — and a manifest-facing
promise enforced only by one implementation's tests is not a contract.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **MAY** are per
RFC 2119.

**In scope:** the zone entry model, the ambient carriage on the invocation
context, the derived-context rule, the two schema annotations and their runtime
resolution, correlation-key resolution, instance identity, the clearing
guarantees, the inbound-registrant obligation, and the payload rule.

**Out of scope:** the static zone projection (`ZONE_REQUIREMENT_*` diagnostics
are checker behaviour, not runtime behaviour), and the `use` vocabulary it
projects (see `x-telo-ref` in `CLAUDE.md`).

## 1. What a zone is

A **zone** is a region of execution established by a providing resource around
the dispatch of its body, which other resources can require having been reached
through. A zone is **identified by the kind that provides it** — no new kind, no
capability, nothing instantiated. The providing side never names a zone: the
zone a slot provides is the declaring kind, period. That makes
provision-on-behalf-of unrepresentable — a schema cannot claim its slot
establishes another module's zone.

## 2. The zone entry

A zone entry is **three identities and nothing else**:

```ts
interface ZoneEntry {
  readonly kind: string;          // canonical <module>.<Kind> of the provider
  readonly provider: ResourceHandle;
  readonly key?: ResourceHandle;  // absent = uncorrelated zone
}
```

- A runtime MUST NOT put provider-private payload on the entry (see §8).
- A runtime MUST represent instance identity as a **handle**, never the
  instance: a `ResourceHandle` is `{ id, ref }` where `id` is a kernel-minted
  string unique per **live instance** and stable for its lifetime, and `ref` is
  the declaration-site `{ kind, name }` — diagnostics only. Two entries denote
  the same resource iff their ids are equal; nothing in the contract uses
  `instanceof` or object identity, so an entry serializes across the ABI and is
  realm-safe by construction.
- The id MUST be minted at `create()` — the runtime's single instance-production
  site — so an instance is never observable without one. A `with:`-scoped
  resource has one declaration but one instance **per scope run**; each run's
  instance MUST get its own id. There MUST be no reverse mapping from handle to
  instance on any public surface.

## 3. Carriage: the stack rides the ambient invocation context

The zone stack is the `zones` member of the `InvokeContext` — the same ambient
object that carries cancellation and trace identity — ordered **outermost
first**, absent meaning none. A runtime MUST NOT carry zones in a second ambient
store beside the invocation context: a parallel store means enumerating every
site that must clear it, and one missed site is a false guarantee under a hard
error.

**The derived-context rule.** Wherever a runtime rebuilds an invocation context
from another (tracing branches, span derivation, boot-target contexts), it MUST
derive from the base rather than construct a fresh literal, so every field it
does not deliberately override — `zones` included — propagates unchanged.
Propagation MUST be identical with tracing on and off; a conformance test MUST
assert this. (Node kernel: `deriveContext(base, overrides)` in the SDK.)

## 4. The annotations

Both sit beside a slot's `x-telo-ref` in the declaring kind's `schema:`. Neither
classifies dispatch — the slot's `use` already did.

### 4.1 `x-telo-provides-zone: true | <pointer> | { key?, …attributes }`

On a body slot: dispatching through it establishes the declaring kind's zone.
The value is the **correlation key**, never the zone: `true` establishes it
uncorrelated; a self-relative JSON pointer names the kind's own field whose
resolved reference the zone carries as its correlation payload
(`Sql.Transaction.steps` declares `/connection`).

The **object form** carries that same pointer as `key` (absent = uncorrelated)
beside the zone's **attributes** — what the region GUARANTEES about everything
executed inside it:

```yaml
x-telo-provides-zone:
  key: /connection
  atomic: a rollback erases writes a journal recorded as done
  noSuspend: the transaction holds a connection a parked run would lose
```

An attribute is what lets a region forbid something a *requirement* cannot
express. A requirement says "I must be inside a zone of kind X"; an attribute
says "whatever runs inside me must respect this", which is a statement about
contents rather than about ancestry, and the two are not interchangeable —
parking inside a `Lease.Critical` body is wrong even though every enclosing-zone
requirement it carries is satisfied.

**They are attributes on this annotation rather than a second annotation family
because a slot that constrains its contents is a slot that already establishes a
zone.** A separate family would restate the zone's location, its `extends`
resolution and its runtime open call, and a kind-level flag could not say WHICH
field holds the body without per-kind knowledge (a sibling `afterCommit:`
legitimately sits outside the transaction).

#### 4.1.1 The attribute vocabulary

The vocabulary is **CLOSED**, and it is **DATA**: one JSON file per attribute
under `sdk/zone-attributes/`, which every runtime reads identically (Rust with
`include_str!`, Node through a copy the build makes). An entry declares its
`name`, a `value` schema, its `requires:` dependencies and a `description`, and
**no code** — the meaning lives entirely with the consumer that reads it.

| Attribute     | Means                                                                                                                 |
| ------------- | --------------------------------------------------------------------------------------------------------------------- |
| `atomic`      | Effects inside are discarded together on failure. **Requires `noSuspend`.**                                             |
| `idempotent`  | Re-executing the zone is observably a no-op. Nothing is discarded, so there is no rollback for a consumer to join.       |
| `noSuspend`   | The zone holds something bounded that cannot outlive the current process — a connection, a lease, a claim.               |
| `replayed`    | Execution inside may be re-run from a record of a previous one, so it must reach the same decisions and serialize.       |

**Each value is the author's REASON**, required by being the value itself rather
than a sibling of a boolean. A consumer refusing on an attribute quotes that
sentence verbatim, and there is no `true` to accept — so `atomic: true` fails the
declared schema rather than reading as a valid declaration with nothing to say.
It is also what keeps the set small: one name serves many providers because the
prose carries the variation, so the vocabulary grows with kinds of *hazard*
rather than kinds of provider.

**`requires:` compiles to JSON Schema's `dependentRequired`**, so `atomic ⇒
noSuspend` is a declaration in the data beside the thing it constrains rather
than a hardcoded pair of names in a validator.

Names are **bare, not `Telo.`-qualified**: the position already implies the
namespace, and a closed set has no second namespace to disambiguate against. The
cost is stated rather than hidden — reopening the vocabulary later means a
prefixed spelling and a migration, not a new key beside the old ones.

A runtime MUST reject an unknown attribute name and a value failing its entry's
schema. It MUST NOT branch on any attribute name: interpreting one is entirely
the consumer's, and a runtime that acted on `noSuspend` would be a runtime with
an opinion about a feature it does not implement.

### 4.2 `x-telo-requires-zone: <kind> | { zone, key?, reason? }`

On a resource's field: the resource must be reached through such a zone. The
string form names the zone kind, uncorrelated. The object form adds:

- `key` — one self-relative JSON pointer or an ordered list tried in order,
  first hit winning. A pointer MAY traverse a `!ref` into the referenced
  resource's own field (read field → resolve reference → read field). When no
  pointer resolves, the requirement is **uncorrelated** — any zone of the right
  kind satisfies it; a runtime MUST NOT invent a correlation the manifest does
  not state.
- `reason` — optional; the runtime consequence, quoted in failures.

The zone kind uses the alias-qualified grammar `extends` and `x-telo-ref` use
(`Self.<Kind>`, `<Alias>.<Kind>`, `Telo.<Kind>`), resolved in the **declaring**
module's scope and rewritten to canonical `<module>.<Kind>` at registration.

## 5. The controller surface

A controller names **its own annotation site, never a kind**. This is forced: a
controller has no alias scope of its own — `ctx.moduleContext` is the scope that
owns the *resource* (the consumer's application), not the module that declared
the kind — and a hand-copied canonical string is exactly the
annotation/controller disagreement this design exists to prevent. Every field of
the entry is therefore **derived**: `kind` and `key` from the annotation,
`provider` from the owning resource.

A runtime MUST expose on the resource context:

- **`self`** — this resource's own handle.
- **`withZone(slot, fn)`** — opens the zone declared by this resource's `slot`
  around `fn`. MUST throw when `slot` carries no `x-telo-provides-zone` (a
  controller and its schema disagreeing is a defect, not a fallback). MUST be a
  **scope function** (push/pop cannot be honest across async boundaries) that
  hands `fn` the derived context — the controller threads it into the body
  dispatch, the discipline cancellation already has — and the minted entry,
  which a provider with private state keys its own map on. The derived context
  MUST also be installed as the ambient for the duration of `fn`.
- **`requireZone(field, ctx?)`** — the zone required by this resource's `field`,
  matched per §6 against `ctx` (default: the ambient context); throws
  `ERR_ZONE_REQUIRED` when none matches. **`findZone`** is the non-throwing
  form.
- **`zonesFor(instance, ctx?)`** — ambient zones whose correlation payload IS
  `instance`, innermost first. The undeclared case: a statement with no
  `transaction:` still joins an open transaction. No kind parameter — the
  provider's own per-instance map discriminates.
- **`zoneAttributes(ctx?)`** — every open zone paired with what it DECLARES
  about its contents (§4.1.1), innermost first. Resolved off the **declaring
  kind's schema**, never off the entry: an entry is three identities *because*
  that keeps it ABI-serializable and stops any module reading another's private
  state off the stack, and attributes on it would trade that away for every
  zone. The runtime resolves and returns them **without branching on a name**,
  exactly as `readRefSlot` returns `use` without acting on it. A zone whose slot
  declares no attributes reports an empty record, never absence.
- **`rootContext(opts?)`** — a context inheriting **nothing** from the ambient:
  no zones, no trace parent, no caller token (optionally a cancellation
  source's). See §7.

## 6. Matching and correlation

A zone entry satisfies a requirement when its `kind` **is, or transitively
`extends`,** the required kind — the Liskov acceptance `x-telo-ref` slots
already have — **and** the correlation holds:

- requirement uncorrelated (no key pointer resolved) → kind match suffices;
- requirement correlated → the entry MUST carry a `key` with the same id.

Matching walks the stack **innermost first**. Correlation identity is the live
instance (§2), which mirrors the runtime exactly: a transaction open on a
different connection does not answer, and two live instances of one
`with:`-scoped connection are different connections.

## 7. Clearing guarantees

"Cleared" is the default state of the world, not a list of sites:

- A detached dispatch (`runDetached`) replaces the ambient context with the
  uncancellable root, shedding every zone with no zone-specific code.
- A `Telo.Service`'s `run()` is dispatched with **no** ambient scope (the
  existing rule, so a long-lived service does not leak its boot scope onto every
  socket callback); work its listeners trigger starts zone-free by construction.
- Nothing MAY hang a clearing guarantee on tracing: a tracing facility is off by
  default, and a safety property must not change with a debug flag.

**The inbound obligation.** The one shape the defaults do not cover is a
`trigger.inbound` registered from *inside* an invocation by something that is
not a Service. An inbound registrant (HTTP route, MCP tool, timer, queue
consumer) MUST dispatch its handler with an explicitly-minted root context —
`rootContext()`, or a cancellation source's context, which is one — never
`undefined`, so the handler's stack is empty regardless of what was ambient at
registration. This obligation is what the static checker's hard error on
`trigger.inbound` edges rests on.

**Residue, stated:** work fired outside the runtime's primitives (a bare
floating promise) inherits whatever the platform propagates — but such work is
already outside detached-task tracking and teardown draining, a pre-existing
contract violation rather than a new hole.

## 8. The payload rule

**Provider-private state hangs off an INJECTED INSTANCE, never a module
import.** A module's controllers may be delivered as separate bundles, each
inlining its own copy of every shared source file, so module-scoped state (a
`const map = new WeakMap()` beside the controllers) is one map **per bundle** —
the write and the read never meet. A runtime and its modules MUST NOT rescue
this with realm collapse: an inlined source file leaves no import to redirect.

Instead, the state lives as an **instance field on the resource that already
crosses the boundary by reference** (e.g. the connection, injected into both the
transaction controller and the statement controllers), keyed on the minted
`ZoneEntry`. The consumer-facing lookup that takes an explicit entry MUST
**throw** on an entry its own map does not know rather than fall back to an
unzoned path — the caller declared a requirement, and a silent fallback converts
a delivery split into silently-unzoned execution, strictly worse than a loud
failure.

This holds in every language: `kernel/rust` passes its invocation context
explicitly and has no ambient store, so "cleared" is the absence of a field
there and the property holds by construction; a zone stack is two strings and a
declaration label per entry, so it crosses the ABI with no realm-crossing
references.

## 9. Error codes

- **`ERR_ZONE_REQUIRED`** — `requireZone` found no matching zone. An
  `InvokeError`, so it survives into a `catch` and is nameable in `catches:`.
  The message MUST name the required kind, the correlation target when one
  resolved (`no sql.Transaction zone open on sqlite.Connection 'appDb'`), and
  quote the annotation's `reason` when present.
- **`ERR_ZONE_ANNOTATION_MISSING`** — `withZone`/`requireZone` named a slot that
  carries no such annotation: a controller/schema disagreement, a defect.
- **`ERR_ZONE_UNRESOLVED`** — a requirement's zone kind resolves to no
  registered kind at runtime (statically `ZONE_PROVIDER_UNRESOLVED`).

`ERR_ZONE_REQUIRED` is raised by a controller on its own behalf and MAY be
declared in a kind's `throws:`; the other two are runtime defects and MUST NOT
be.
