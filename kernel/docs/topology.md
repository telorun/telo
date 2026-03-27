# Topology

**Status:** Design proposal — not yet implemented.

## Overview

A `topology` field on `Kernel.Definition` declares the **structural composition pattern** of a resource kind. It is distinct from `capability`, which assigns a lifecycle role:

| Field        | Describes                                            | Consumer                 |
| ------------ | ---------------------------------------------------- | ------------------------ |
| `capability` | What the resource CAN DO (runnable, invokable, etc.) | Kernel runtime           |
| `topology`   | How the resource IS COMPOSED internally              | Kernel, analyzer, editor |

A definition may declare both. `capability` and `topology` are orthogonal.

```yaml
kind: Kernel.Definition
metadata: { name: Steps, module: Job }
capability: Runnable
topology: Sequence
schema: ...
```

## Motivation

Without `topology`, the kernel and analyzer have no generic understanding of how a resource is internally structured. Every routing resource and every sequential job requires a bespoke controller that re-implements dispatch or step execution from scratch. The analyzer cannot validate handler references or step ordering without kind-specific knowledge.

`topology` gives the kernel and analyzer a stable, named pattern to work with. It also enables **controller-less resource kinds** — kinds that opt into a built-in execution engine by declaring a topology rather than providing a controller implementation.

`topology` is also the signal to the editor that a resource kind has meaningful internal structure worth visualizing. A kind with no `topology` is treated as configuration or data — it is selectable (opens the detail panel) but not navigable (no canvas view is activated). This rule is static and definition-level: it depends on the kind's definition, not on whether a specific resource instance has connections.

## Role Annotations

A topology defines named **structural roles** — the slots that both the kernel's built-in execution engine and the editor need to locate in a resource's schema. Because definitions may use any field names, roles are declared explicitly via `x-telo-topology-role` annotations on schema properties.

Role annotations are required regardless of whether built-in or custom execution is used. Custom controllers replace runtime execution but the editor still reads role annotations to render topology-aware UI (route tables, step lists).

## Execution Model

Topology and execution are two separate layers. Topology is always an annotation — the editor and analyzer read it regardless of how execution is handled.

**Built-in execution:** a definition with a known topology that omits `controllers` uses the kernel's built-in execution engine. The kernel locates fields via role annotations and handles dispatch or step execution automatically.

**Custom execution:** a definition with `controllers` uses the controller for runtime execution. The controller replaces only the execution layer — topology and role annotations still drive the editor and analyzer. A controller does not "take precedence over" topology; the two layers are orthogonal.

## Relationship to Capabilities

Capabilities and topology describe different things and may be combined freely:

| Capabilities | Topology   | Meaning                                                        |
| ------------ | ---------- | -------------------------------------------------------------- |
| `Runnable`   | —          | Can be started; editor shows detail panel only (not navigable) |
| `Runnable`   | `Sequence` | Can be started; internally executes ordered steps              |
| `Mount`      | `Router`   | Can be mounted onto a server; internally dispatches routes     |
| `Invocable`  | —          | Can be invoked; editor shows detail panel only (not navigable) |

## Known Topologies

- [Sequence](topologies/sequence.md) — ordered step execution; each step invokes an invocable and may pipe outputs into subsequent steps
- [Router](topologies/router.md) — matcher-to-handler dispatch; entries are evaluated in order and the first match is invoked
- [Workflow](topologies/workflow.md) — directed graph of task nodes; control flow via gateway node kinds (`Flow.If`, `Flow.While`, `Flow.Switch`)
