# Scheduler

Recurring time sources. Where `timer` ships the one-shot `Timer.Delay`, scheduler ships the inbound **time** source: a body fired on a period or a cron schedule.

## Why use this

- **Schedules live in the manifest** — a periodic job is a declared resource, not a `JS.Script` holding a `setInterval`.
- **Orderable against boot** — both kinds are Services listed in `targets`, so a schedule starts *after* the migrations and seed targets it must not race, exactly like an `Http.Server`.
- **A bad tick never kills the schedule** — a failing body is logged and the timer re-arms; the error surfaces rather than being swallowed.
- **Composes with the rest of the stdlib** — wrap the body in `Lease.Critical` for cross-instance exclusion, or `Idempotency.Once` for at-most-once work.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Schedule.Interval` | Fire the body every fixed duration. |
| `Schedule.Cron` | Fire the body on a cron expression, in a chosen timezone. |

## Example

```yaml
targets:
  - !ref setupDb        # migrations first …
  - !ref cacheRefresh   # … then the schedule starts
---
kind: Schedule.Interval
metadata: { name: cacheRefresh }
every: "1m"
invoke: !ref refreshCache
---
kind: Schedule.Cron
metadata: { name: nightlyReport }
cron: "0 2 * * *"
timezone: UTC
invoke: !ref generateReport
```

Listing a schedule in `targets` is what makes its start position explicit. A schedule that armed itself during the init loop could fire before resources it holds no reference to exist, and an author would have no way to sequence it.

## Fields

| Field | `Interval` | `Cron` |
| --- | --- | --- |
| `every` | Tick period as a duration (`30s`, `1m`). | — |
| `cron` | — | 5-field expression (`m h dom mon dow`), or 6 with leading seconds. |
| `timezone` | — | IANA timezone (default `UTC`). |
| `invoke` | The body fired on each tick. | Same. |
| `inputs` | Forwarded to the body, re-evaluated per tick. | Same. |
| `when` | Optional CEL boolean gating each fire. | Same. |

## Gating a tick with `when`

`when` is evaluated before each fire. A false gate **skips the tick entirely** — no dispatch, no lease or idempotency claim, no trace event — and the timer re-arms. It is a skip, not an error.

```yaml
kind: Schedule.Interval
metadata: { name: cacheRefresh }
every: "1m"
when: !cel "variables.refreshEnabled"
invoke: !ref refreshCache
```

Cron expresses the calendar; `when` gates on state the calendar cannot see — a feature flag, a maintenance window, a queue depth.

## Ticks never overlap themselves

The timer re-arms only after a tick settles, so a body slower than the period cannot stack up an unbounded queue of runs on one instance. That is **not** cross-instance exclusion: every replica runs its own schedule. When only one replica may run the job, wrap the body:

```yaml
kind: Schedule.Cron
metadata: { name: nightlyReport }
cron: "0 2 * * *"
invoke: !ref reportOncePerNight
---
kind: Lease.Critical
metadata: { name: reportOncePerNight }
store: !ref store          # a shared durable store
ttl: "30m"
invoke: !ref generateReport
```

Mutual exclusion is `Lease.Critical`'s job — building an overlap flag here would duplicate single-flight and, worse, cross-instance locking.

## Lifecycle

- `init()` prepares — parses the schedule, so a malformed cron expression or unknown timezone fails at boot rather than at the first missed tick. It arms nothing.
- `run()` starts ticking, from the app's `targets`.
- `teardown()` disarms first, then awaits the tick already in flight, so shutdown drains rather than abandoning a running body.

The first tick lands one full period (or at the next cron occurrence) after the schedule starts — never immediately on boot.
