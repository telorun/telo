# scheduler — recurring time source

## Problem

Telo has no recurring time source. The `timer` module ships only the one-shot
`Timer.Delay` (wait a duration, complete). Any app that must run logic
periodically — pollers, cron jobs, periodic reconciliation, cache refresh — has
nothing to declare a schedule with. Telo covers inbound *request* sources (`http-server`)
but not inbound *time* sources.

## Solution

A new stdlib module `scheduler` (namespace `std`) with two `Telo.Service`
kinds. A Service is Telo's inbound-event-source shape (`Http.Server`,
`Mcp.StdioServer`); a scheduler is the same, with time as the source.

- `Schedule.Interval` — fires its body every duration (`every`, a duration
  string like `Timer.Delay`'s: `30s`, `1m`).
- `Schedule.Cron` — fires its body on a cron expression (`cron`), with an
  optional `timezone` (UTC default).

**Lifecycle mirrors the existing inbound sources exactly.** `init()` only
prepares (parse the schedule, resolve the dispatcher) and arms nothing; `run()`
starts the ticking; the app lists the scheduler in `targets`. This is what makes
a schedule orderable: a scheduler that started itself during the init loop could
fire against a half-built app, and an author would have no way to sequence it
after a migration/seed target it holds no `!ref` edge to (the way
`targets: [SetupDb, Server]` sequences an HTTP server today). `teardown()`
disarms the timer and awaits the tick currently in flight, so shutdown drains
rather than abandoning a running dispatch.

Both kinds carry an `invoke` field typed `anyOf: [telo#Invocable, telo#Runnable]`
— the same field name `Lease.Critical` / `Cache.View` use for a wrapped body and
`Run.Sequence` steps use for a dispatch target — plus an optional `inputs`
forwarded on each fire and an optional `when:` CEL gate. On each tick the
controller first evaluates `when:` (when present) against the resource's module
scope; a false gate skips the tick entirely — no dispatch, no lease/idempotency
claim, no trace event — and the timer re-arms as normal. Otherwise it resolves
the body with the SDK's `resolveInvocableDispatcher`
(`sdk/nodejs/src/dispatch-invoke-ref.ts`) and dispatches through the traced
chokepoint (`invokeResolved`), so scheduled runs emit telemetry like any other
dispatch. A body failure — or a `when:` evaluation error — is logged via
`ctx.log` and the schedule continues; one bad tick never stops the timer, and the
error is surfaced, never swallowed.

Controllers ship **bundled with the module** as `pkg:telo/local/js` — a built
`.mjs` next to the manifest, referenced as
`pkg:telo/local/js?path=./nodejs/<file>.mjs#<export>` and imported directly by the
kernel, with no npm package to publish. The SDK stays an external import resolved
to the kernel's own copy by the bundle loader; the cron parser (a small Node-only
dependency) is bundled into the artifact at build time (kept out of the interval
path). The manifest declares a `files:` glob covering the built `.mjs` so the
bundle ships in the published artifact — `scheduler` is the first stdlib module
to use bundled delivery, so the build step that produces the `.mjs` and the
`files:` entry are part of this work, not assumed infrastructure.

## Decisions

- **Two kinds, not one unified kind** — cron needs a parser and timezone
  semantics that don't belong on the interval path; separate schemas stay
  honest. Rejected: a single kind with an `every` XOR `cron` oneOf.
- **`Telo.Service` armed from `targets`, not auto-started on init** — inbound
  sources are already Services in Telo, and both existing ones (`Http.Server`,
  `Mcp.StdioServer`) prepare in `init()` and begin accepting events in `run()`
  from the app's `targets` list. Reusing that shape keeps lifecycle and boot
  ordering free, and keeps the schedule *declaratively orderable* against other
  boot targets. Rejected: auto-arming in `init()` (fires inside the init loop,
  before non-referenced dependencies exist, with no way to order it) and a new
  capability.
- **Teardown drains the in-flight tick** — disarm first, then await the running
  dispatch, so shutdown never abandons a body mid-flight. Bounded by the
  kernel's shutdown path; a body that outlives it is logged, not silently
  dropped.
- **No built-in overlap policy** — if a tick fires while the previous run is
  still in flight, mutual exclusion is `Lease.Critical`'s job (its own docs cite
  cron-overlap prevention). Building an overlap flag here would duplicate
  single-flight and, worse, cross-instance locking. Rejected: an
  `overlap: skip|allow` field.
- **Per-tick `when:` CEL gate** — an optional boolean evaluated at each fire
  against the module scope (`variables` / `secrets` / `ports` / `resources`
  snapshots, plus CEL's time functions `nowMillis()` / `nowSeconds()` /
  `dateInZone`). A false gate skips the tick *before* any dispatch (no
  lease/idempotency/trace overhead); it is a skip, not an error, and the timer
  re-arms. Same `when:` the Application's `targets` and `Run.Sequence` steps use —
  a shared field a future `Trigger` abstract would hoist. Complementary to cron:
  cron expresses the calendar, `when:` gates on state and dynamic conditions cron
  can't. Runtime-evaluated (`x-telo-eval: runtime`) with an `x-telo-context` so it
  is statically type-checked.
- **No `Trigger` abstract yet** — nothing references a trigger *as a slot* (it is
  the top-level driver, never a referenced dependency), and both sources are
  payload-less, so an abstract can't be validated against real variation.
  Documented extraction point: when a payload-carrying source lands (an inbound
  webhook via `http-server`, a queue message), extract a `Trigger` abstract that
  unifies the scheduler with that source and carries the event payload into the
  body's `inputs`. Rejected: introducing the abstract now.
- **Controllers bundled (`pkg:telo/local/js`), not a published npm package** —
  the controller is JS and ships with the module, so bundling drops the whole
  publish/versioning surface (no `@telorun/scheduler`, no controller changeset;
  the module versions via changie alone). JS-only on the Node kernel is no
  constraint here. An ordered candidate list can add a `pkg:npm` fallback later
  if a registry-installable form is wanted. Rejected: a new `@telorun/scheduler`
  npm package.

## Usage after the change

Fire a job once a minute, ordered after the app's schema setup (single-instance
exclusion, when needed, is added by composing `Lease.Critical` inside the body,
not here):

```yaml
targets:
  - !ref setupDb
  - !ref cacheRefresh
---
kind: Schedule.Interval
metadata:
  name: cacheRefresh
every: "1m"
when: !cel "variables.enabled"
invoke: !ref refreshCache
```

Or on a cron schedule, nightly at 02:00:

```yaml
kind: Schedule.Cron
metadata:
  name: nightlyReport
cron: "0 2 * * *"
timezone: "UTC"
invoke: !ref generateReport
```
