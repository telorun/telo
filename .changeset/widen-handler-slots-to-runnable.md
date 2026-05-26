---
"@telorun/http-server": minor
"@telorun/mcp-server": minor
"@telorun/lambda": minor
---

Widen every "handler-shaped" `x-telo-ref` slot to accept both `telo#Invocable` and `telo#Runnable`, so dual-mode kinds — most commonly `Run.Sequence`, whose controller implements both `run()` and `invoke()` — pass static reference validation without each kind declaring secondary capabilities on its own definition.

Affected slots:

- `@telorun/http-server`: `Http.Server.parsers[].parser`, `Http.Server.notFoundHandler.invoke`, `Http.Api.routes[].handler`.
- `@telorun/mcp-server`: `Mcp.Tools.entries[].handler`, `Mcp.Resources.entries[].handler`, `Mcp.Prompts.entries[].handler`.
- `@telorun/lambda`: `Lambda.HttpApi.routes[].handler`, `Lambda.Sqs.handler`, `Lambda.Direct.handler`.

Mechanism: each slot's single `x-telo-ref: "telo#Invocable"` is replaced by an `anyOf:` block carrying both refs. The analyzer's reference-field-map walker already collects refs from `anyOf` branches and `checkKind` early-returns on the first match — so the union semantics are honoured without any analyzer change. AJV value-shape validation continues through the slot's existing `oneOf:` (string vs. object form), unchanged.

Runtime behaviour is unchanged: the kernel calls whichever method the handler's controller exposes (`.invoke()` or `.run()`). This release just lets the schema admit what the kernel already accepts.
