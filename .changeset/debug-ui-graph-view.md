---
"@telorun/debug-ui": minor
---

debug-ui: new **Graph** view — now the first tab, beside Events/Logs.

- A left rail lists every traced **invocation** (root calls); selecting one scopes the canvas to just the resources that took part in that call, wired by the real parent→child **call edges**, each node showing its inputs → outputs.
- With nothing selected, the canvas shows the live **resource topology**: nodes appear gray on `Created`, brighten on `Initialized`, and pulse on each invocation (tinted by outcome), with dependency wiring from the `Created` payload. A "Hide unconnected" toggle (on by default) drops resources with no dependency wiring.

Adds the pure, framework-agnostic folds `deriveGraph` (topology), `deriveInvocations` + `traceSubgraph` (call traces, from event `metadata.invocationId` / `parentInvocationId`), and the `EventGraph` component (built on `@xyflow/react` + dagre).
