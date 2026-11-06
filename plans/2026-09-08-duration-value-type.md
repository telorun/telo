---
status: done
priority: high
depends-on: []
packages: [cel, sdk, sdk/rust/core, cel/rust/value, modules/cache, modules/cache-redis, modules/channel, modules/durable, modules/durable-local, modules/idempotency, modules/kv-store-redis, modules/lease, modules/oauth-client, modules/otlp, modules/rate-limit, modules/scheduler, modules/sql, modules/timer]
tracking: feat/duration-days
---

# Durations: one grammar, adopted by the standard library

## Problem

`Telo.Duration` is a shipped value type: a slot declaring it is checked by `telo check`,
decoded to CEL's own duration before the controller sees it, and reads an integer as
milliseconds. But its grammar is CEL's — `ns`, `us`, `ms`, `s`, `m`, `h`, no day unit —
while fourteen standard-library modules still declare their durations `type: string` and
parse them by hand with `parseDurationMs`, a second grammar that accepts `30d`. So
`ttl: "5 minutes"` passes `telo check` and fails at boot, and moving a field to
`Telo.Duration` would stop `reclaim: { afterDuration: 30d }` parsing.

## Solution

### 1. One grammar with days and weeks

**Before.** `duration('30d')` is an error; a `Telo.Duration` slot refuses `30d`; the Rust
SDK's slot decoding has a grammar of its own beside the value crate's.

**After.** The grammar gains `d` (exactly 24 hours) and `w` (exactly 7 days), in CEL's
`duration()` and in every `Telo.Duration` slot, Node and Rust alike — one reader per
runtime, the Rust slot decoding reading through the value crate's parser under protobuf's
range as Node's does. Months and years stay out: they are not fixed lengths. Output is
unchanged: a duration is written as seconds (`86400s`). `parseDurationMs` /
`tryParseDurationMs` stay on the SDK, deprecated and unchanged, for third-party controllers.

**Verify.** CEL conformance rows: `duration('1d') == duration('86400s')`,
`duration('1w') == duration('7d')`, `duration('1d12h30m')`, `duration('1.5d') ==
duration('36h')`, `duration('-1w')`; `1y`, `2M`, `1d 30m` refused — passing in both
engines. A `30d` literal at a `Telo.Duration` slot passes `telo check` and runs; `30x` is a
`SCHEMA_VIOLATION`.

Release: `.changeset/`, `@telorun/cel` and `@telorun/sdk` minor.

### 2. Adoption

**Before.** Each duration field in `cache`, `cache-redis`, `channel`, `durable`,
`durable-local`, `idempotency`, `kv-store-redis`, `lease`, `oauth-client`,
`otlp`, `rate-limit`, `scheduler`, `sql` and `timer` is `type: string`, with its grammar in
the description and its check at boot.

**After.** Each is `x-telo-type: Telo.Duration`, with a bound where the controller refused
zero or negative; controllers read it with `durationMs`. Where a field is evaluated, a
computed value must be a duration (`!cel "duration('5m')"`), not a string — a breaking
change, released as `Added`; so is text with a space before the unit (`5 m`). Every module
requires `>=0.129.0`, the first SDK exporting `durationMs`; a module whose old reader
accepted `d` requires `>=0.130.0`, the first runtime whose `Telo.Duration` reads it.

**Verify.** Each module's manifest tests pass; `ttl: "5 minutes"` is a `SCHEMA_VIOLATION`
at `telo check` on its own line; `30d` is accepted.

Release: one `telo release add` fragment per module, `Added`.
