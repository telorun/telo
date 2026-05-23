# Workflow Temporal

[Temporal](https://temporal.io/) backend for [`Workflow.Graph`](../workflow/README.md). Provides durable, replayable workflow execution by translating each graph node into a Temporal activity.

> **Warning**: this module is planned to be implemented, it is not available yet. The README is a placeholder for the intended design and API.

## Why use this

- **Durable execution** — Temporal owns workflow history; in-flight workflows survive process restarts.
- **Per-node retry policies** — `scheduleToCloseTimeout`, `retryPolicy.maxAttempts`, and `retryPolicy.initialInterval` are typed via `$defs.NodeOptions` and validated by the analyzer.
- **Worker pool per backend** — each `Workflow.Temporal.Backend` owns its worker pool and drains in-flight activities on shutdown.
- **Eager connection** — misconfigured `address` fails at init, not on the first graph execution.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Workflow.Temporal.Backend` | Provider that implements `Workflow.Backend` against a Temporal cluster. |

## Example

```yaml
kind: Workflow.Temporal.Backend
metadata:
  name: Temporal
namespace: production
address: temporal.internal:7233
---
kind: Workflow.Graph
metadata:
  name: OnboardUser
backend:
  kind: Workflow.Temporal.Backend
  name: Temporal
nodes:
  - name: sendWelcomeEmail
    invoke:
      kind: HttpClient.Request
      client: Mailer
    options:
      scheduleToCloseTimeout: 10m
      retryPolicy:
        maxAttempts: 5
        initialInterval: 30s
```

## Configuration

- `namespace` — the Temporal namespace used for workflow executions. Create the namespace in your Temporal cluster before running the application.
- `address` — the Temporal frontend host/port. Defaults to Temporal's own defaults when omitted.

## Per-node options

When a `Workflow.Graph` uses this backend, each node's `options` slot accepts the Temporal-specific fields declared under `$defs.NodeOptions`:

| Option                        | Meaning                                                              |
| ----------------------------- | -------------------------------------------------------------------- |
| `scheduleToCloseTimeout`      | Total wall-clock budget for the activity (Temporal duration string). |
| `retryPolicy.maxAttempts`     | Maximum retry attempts before the activity fails permanently.        |
| `retryPolicy.initialInterval` | Initial backoff duration; Temporal doubles it between retries.       |

Duration strings follow Temporal's conventions — `10s`, `5m`, `1h30m`, etc.

## Operational notes

- The backend assumes the Temporal server is reachable at `address` at boot time. Connection is attempted eagerly — a misconfigured address is caught as an initialization error rather than surfacing during the first graph execution.
- Each `Workflow.Temporal.Backend` resource owns its own worker pool. When the application shuts down, the backend drains in-flight activities before exiting.
- Namespaces are not auto-created. If the namespace does not exist, initialization fails.
- The generated workflow's history is managed entirely by Temporal — Telo does not persist state itself. If you need to recover an in-flight workflow across restarts, you rely on Temporal's durability guarantees.

## See also

- [`Workflow.Graph`](../workflow/README.md) — graph declaration
- [Temporal docs](https://docs.temporal.io/) — namespaces, retry policies, durations
