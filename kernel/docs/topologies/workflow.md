# Topology: Workflow

A directed graph of task nodes. Steps are nodes and edges represent execution flow between them.

## Control Flow

Control flow is expressed as **gateway node kinds** — `Flow.If`, `Flow.While`, `Flow.Switch` — that appear as first-class nodes in the workflow canvas. Branching is represented by multiple outgoing edges from the gateway node, each labeled with the branch condition. This is necessary because in a graph topology, branching is a property of edges, not of fields.

Gateway nodes render with a distinct shape (`◇` diamond) to distinguish them from invocable task nodes. Edges from a gateway are labeled with their branch condition.

This differs from `Sequence`, where control flow is built into the step tree structure (`Job.Steps` controller) — no separate resource kinds exist for `if`, `while`, or `switch`. In Workflow, `Flow.If`, `Flow.While`, and `Flow.Switch` are resource kinds in the `Flow` module, each with their own controller.

## Editor Behavior

Activates the workflow canvas sub-editor (node-and-edge graph with drag-to-position layout).
