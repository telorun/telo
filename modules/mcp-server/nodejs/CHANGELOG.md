# @telorun/mcp-server

## 1.0.0

### Patch Changes

- Updated dependencies [ae0bf77]
  - @telorun/sdk@1.0.0

## 0.5.1

### Patch Changes

- 4c1a50b: Refresh in-tree documentation version pins to the current registry latest.

## 0.5.0

### Minor Changes

- 0331069: Widen every "handler-shaped" `x-telo-ref` slot to accept both `telo#Invocable` and `telo#Runnable`, so dual-mode kinds — most commonly `Run.Sequence`, whose controller implements both `run()` and `invoke()` — pass static reference validation without each kind declaring secondary capabilities on its own definition.

  Affected slots:

  - `@telorun/http-server`: `Http.Server.parsers[].parser`, `Http.Server.notFoundHandler.invoke`, `Http.Api.routes[].handler`.
  - `@telorun/mcp-server`: `Mcp.Tools.entries[].handler`, `Mcp.Resources.entries[].handler`, `Mcp.Prompts.entries[].handler`.
  - `@telorun/lambda`: `Lambda.HttpApi.routes[].handler`, `Lambda.Sqs.handler`, `Lambda.Direct.handler`.

  Mechanism: each slot's single `x-telo-ref: "telo#Invocable"` is replaced by an `anyOf:` block carrying both refs. The analyzer's reference-field-map walker already collects refs from `anyOf` branches and `checkKind` early-returns on the first match — so the union semantics are honoured without any analyzer change. AJV value-shape validation continues through the slot's existing `oneOf:` (string vs. object form), unchanged.

  Runtime behaviour is unchanged: the kernel calls whichever method the handler's controller exposes (`.invoke()` or `.run()`). This release just lets the schema admit what the kernel already accepts.

### Patch Changes

- be79957: Move `@telorun/sdk` to `peerDependencies` across the kernel, analyzer, templating, and every module.

  The SDK carries the `Stream` class registered with `@marcbachmann/cel-js` for stream-typed CEL values. cel-js identifies object types by constructor identity, so a second copy of `@telorun/sdk` in the install tree silently breaks streaming-typed evaluations with `Unsupported type: Stream`. The contract was previously enforced with three layered mechanisms (a generated `dist/generated/runtime-deps.json` driving install-root `dependencies`, `overrides` + `pnpm.overrides` blocks, and a `globalThis`-keyed singleton in `stream.ts`); the build artifact silently degraded when the kernel was run without a build step, defeating the layering.

  The new shape:

  - Every package that imports `@telorun/sdk` declares it as a `peerDependency`. Consumers (the kernel's install root, the CLI, apps) provide a single copy and `peerDependencies` cause npm/pnpm to resolve every transitive import to it.
  - The kernel's `NpmControllerLoader` no longer reads `runtime-deps.json`; the realm-collapse name list is a hardcoded constant (`REALM_COLLAPSE_NAMES = ["@telorun/sdk"]`) in `npm-loader.ts`. The install-root `package.json` it writes drops the `overrides` and `pnpm.overrides` blocks — peer-dep resolution makes them redundant.
  - `scripts/generate-runtime-deps.mjs` and the generated artifact are removed; `scripts/prepack-bake-overrides.mjs` no longer chains the runtime-deps regeneration.
  - The `globalThis` singleton in `sdk/nodejs/src/stream.ts` is **kept** as a safety net for environments that still end up with mismatched SDK copies (e.g. a controller install from a tarball that predates this change).

  Consumers installing `@telorun/kernel` or any module directly must now ensure `@telorun/sdk` is present in their dependency tree. The kernel already lists it via the install root for any manifest it boots, so kernel-driven usage is unaffected.

- Updated dependencies [849f57a]
- Updated dependencies [be79957]
  - @telorun/sdk@0.12.0

## 0.4.2

### Patch Changes

- Updated dependencies [58362c4]
  - @telorun/sdk@0.11.1

## 0.4.1

### Patch Changes

- Updated dependencies [f1c35bc]
- Updated dependencies [47f7d83]
  - @telorun/sdk@0.10.0

## 0.4.0

### Minor Changes

- 733029e: Add `stateful` flag to `Mcp.HttpEndpoint` and flip the default to stateless. In stateless mode (the new default) every request builds a fresh SDK `Server`+transport pair, no `Mcp-Session-Id` is minted, and the endpoint scales horizontally without sticky session affinity at the load balancer. Set `stateful: true` to keep the v1 behaviour where each session owns an in-memory `Server` keyed by `Mcp-Session-Id` — required for server-pushed notifications, resource subscriptions, and tool inputs that branch on `request.session.id`. The transition is transparent for tools-only consumers; clients that previously relied on session continuity should opt in to `stateful: true` and configure header-based affinity at their LB if they run more than one replica.

## 0.3.0

### Minor Changes

- 019c62a: Add optional `instructions: string` field on `Mcp.HttpEndpoint` and
  `Mcp.StdioServer`. Forwarded to the SDK `Server` constructor's `instructions`
  option and surfaced to clients on `initialize` — compatible MCP clients
  (Claude Desktop, etc.) pass this to their LLM as system context, so it's the
  natural place to ship a primer that teaches the model what the server is and
  how to use its tools without requiring a discovery tool round-trip.

## 0.2.0

### Minor Changes

- 5288f6c: Initial release of the `mcp-server` module.

  Adds five resource kinds for exposing a Model Context Protocol server from Telo
  manifests: `Mcp.StdioServer` (stdio transport, `Telo.Service`), `Mcp.HttpEndpoint`
  (Streamable-HTTP transport, `Telo.Mount` on `Http.Server`), and three passive
  bundle kinds — `Mcp.Tools`, `Mcp.Resources`, `Mcp.Prompts` (`Telo.Type`). v1 ships
  runtime dispatch for `Mcp.Tools`; `Resources` and `Prompts` are schema-only and
  gain runtime in v2.

  Bundles compose by reference: a transport's `tools:` array can reference multiple
  bundles (entries are merged with cross-bundle duplicate detection at init), and a
  single bundle can be referenced from both stdio and HTTP transports without
  re-declaration. Each tool entry maps the MCP envelope (`request.{name, arguments,
meta, session}`) to any `Telo.Invocable` handler via CEL `inputs:` / `result:` /
  `catches:` adapters — the handler stays oblivious to MCP.
