# Workflow

Workflow orchestration primitives with pluggable backend providers. `Workflow.Graph` declares the shape of a workflow; a `Workflow.Backend` implementation executes it.

> **Warning**: this module is planned to be implemented, it is not available yet. The README is a placeholder for the intended design and API.

## Why use this

- **Backend-agnostic graphs** — the same `Workflow.Graph` targets Temporal, an in-process loop, or a queue-based executor without changes.
- **Invocable nodes** — each node calls any `Telo.Invocable` (HTTP, SQL, scripts, other graphs).
- **Backend-typed options** — per-node `options` is schema-driven via `x-telo-schema-from`, so retry policies and timeouts type-check against the chosen backend.
- **Composable** — graphs are themselves runnable / invocable, so they slot into `Run.Sequence` and Application `targets`.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Workflow.Backend` | Abstract — implemented by backend modules (e.g. `workflow-temporal`). |
| `Workflow.Graph` | Runnable list of named nodes that invoke resources via a `Workflow.Backend`. |

## Example

```yaml
kind: Workflow.Graph
metadata:
  name: OnboardUser
backend:
  kind: Workflow.Temporal.Backend
  name: Temporal
nodes:
  - name: createRecord
    invoke:
      kind: Sql.Exec
      name: InsertUser
  - name: sendWelcomeEmail
    invoke:
      kind: HttpClient.Request
      client: Mailer
    options:
      retryPolicy:
        maxAttempts: 5
        initialInterval: 10s
```

## The shape

- `backend` references a provider that implements the `Workflow.Backend` abstract. Its `$defs.NodeOptions` schema shape dictates what keys `options` accepts per node (resolved via `x-telo-schema-from`).
- `nodes[].invoke` is any `Telo.Invocable` reference.
- `nodes[].options` is backend-specific — retry policies, timeouts, task queues, etc.

## Backends

`Workflow.Backend` is a `Telo.Abstract` — it defines a capability with no concrete controller of its own. A backend module declares a `Telo.Definition` whose `capability: Workflow.Backend` and provides the runtime that actually executes the graph.

See [workflow-temporal](../workflow-temporal/README.md) for the reference implementation.

## Why a separate abstract

Keeping the backend pluggable means the same `Workflow.Graph` declaration can target different execution engines without changes:

- **Temporal** — durable, long-running workflows with history replay.
- **Local (in-process)** — simple loop, useful for tests and short jobs.
- **Queue-based** (SQS, Pub/Sub, etc.) — when you want durability without the weight of a workflow engine.

Callers don't care which backend is behind the graph; they just invoke it.

## Notes

- `Workflow.Graph` does not ship its own execution logic. Without a backend, loading a graph is a configuration error.
- Node `options` are only loosely typed at the graph level — the backend's `$defs.NodeOptions` provides the real schema. The analyzer resolves it and validates per-node options against the backend in use.
- `Workflow.Graph` is a runnable; to use it as an application target, add it to the Application `targets` list. To make it invocable, wrap it in a `Run.Sequence` whose first step invokes the graph.
