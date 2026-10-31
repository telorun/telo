# ScheduledJobs

Recurring work from one declaration. List the jobs by name, each with a cron
expression and the work to run; every job gets its own schedule, and all of
them run while the application is up.

```yaml
imports:
  ScheduledJobs: oci://ghcr.io/telorun/blueprints/scheduled-jobs-app@<version>
targets:
  - !ref jobs
---
kind: ScheduledJobs.App
metadata:
  name: jobs
jobs:
  nightlyReport:
    cron: "0 2 * * *"
    timezone: Europe/Warsaw
    invoke: !ref buildReport
  hourlyCleanup:
    cron: "0 * * * *"
    invoke: !ref purgeExpired
```

## Fields

| Field | Meaning |
|---|---|
| `jobs` | The jobs, keyed by name (at least one). Written literally: a `jobs:` that is computed (`!cel`) is refused before the app runs, because the number of schedules must be known then. |
| `jobs.<name>.cron` | Cron expression, five fields (`m h dom mon dow`) or six with a leading seconds field. |
| `jobs.<name>.timezone` | IANA timezone the expression is read in (default `UTC`). |
| `jobs.<name>.invoke` | The work to run on each tick: a reference to, or an inline declaration of, any invocable or runnable. |

## What it creates

The template body declares a `Scheduler.Cron` family, one member per job, and
starts the members in the order the jobs are written. A member is named by its
job (`crons['nightlyReport']` in logs and traces), so adding a job leaves every
other schedule's name unchanged.

The [`example/`](./example) runs two jobs, and [`tests/`](./tests) runs a
declaration on a once-per-second schedule and checks each job's work ran.
