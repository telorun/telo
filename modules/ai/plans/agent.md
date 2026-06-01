# Plan — `Ai.Agent` (tool-use loop)

## Problem

`Ai.Text` and `Ai.TextStream` give single-turn LLM calls, but they can't use tools. A real agent runs a loop: the model is handed a set of tools, decides to call one, the call is executed, the result is fed back, and the loop repeats until the model produces a final answer. The current `Ai.Model` contract carries no tool support at all — input is `{ messages, options }`, output is `{ text, usage, finishReason }`, and messages only support `system | user | assistant` roles. Tools come in two flavours — statically declared in the manifest, or discovered at runtime from an MCP server — so the agent's machinery (tools in, tool-calls out, the loop, tool results back, discovery) is all net-new and spans `modules/ai` (the contract + agent + a `ToolProvider` abstract), `modules/ai-openai` (the provider), and a new `modules/ai-mcp` bridge (runtime tool discovery from MCP servers). The Vercel AI SDK underneath already supports tools, which keeps the provider plumbing tractable.

## Solution

A new `Ai.Agent` kind (`Telo.Invocable`, exported from `modules/ai`), invoked like `Ai.Text` — `prompt` xor `messages`, plus `system` and `options`. It owns the loop in its controller (`modules/ai/nodejs/src/ai-agent-controller.ts`): call the model, execute any requested tools, append results, repeat until the model finishes or a step cap is hit. The loop is controller-side (not delegated to the provider) so it stays provider-agnostic and observable.

**Tools — one contract, reusing the mount pattern.** The agent has a single `toolProviders` field (`x-telo-ref: "std/ai#ToolProvider"`): a list of references to `Ai.ToolProvider`, a new `Telo.Abstract` exported from `modules/ai` with `capability: Telo.Mount` — a tool provider is *mounted into* the agent exactly as an `Http.Api` is mounted into an `Http.Server` (the same `{ <config>, <mount ref> }` entry shape, host iterates and consumes each). A provider's runtime instance exposes two methods — `listTools()` (returning `{ name, description, parameters }` descriptors) and `callTool(name, arguments)` — which the agent calls to attach it, the way `Http.Server` calls `register()` on each mount; they layer onto the `Telo.Mount` role just as `Ai.Model` layers `invoke`+`stream` onto its capability. The agent lists each provider lazily on first invoke, caches the set, and merges all providers into one name→dispatch map (`list_changed` refresh deferred); each entry takes an optional `prefix` (namespacing names to avoid collisions) and optional `include`/`exclude` allow/deny lists, with `ERR_AGENT_TOOL_COLLISION` on an unresolvable clash. **Regular tools and MCP are both just implementations of this one contract** — there is no separate `tools` field:

- **`Ai.Tools`** (shipped by `modules/ai`, `capability: Telo.Mount, extends: Self.ToolProvider`) — a *static tool list*. Its schema is a `tools:` array, each entry `{ tool, name?, description?, parameters, inputs?, result? }`: `tool` is an `x-telo-ref: "telo#Invocable"` (so any stdlib invocable composes — `JS.Script`, `Http.Client`, `Sql`, another `Ai.Text`), and `parameters` is the **required** JSON Schema the model sees. By default the model's arguments forward verbatim to the invocable's `invoke()` and its output is JSON-stringified back; the optional `inputs:`/`result:` CEL mappings shape divergent call shapes. `listTools()` returns the declared entries; `callTool()` dispatches to the matching invocable. These entries are **statically typed at the manifest level**, partly via existing annotations and partly via one new analyzer check. `parameters` is the required, explicit model-facing schema. Inside the `inputs:` mapping, the `arguments` CEL variable is typed from the sibling inline `parameters` via the existing item-relative context mechanism — an `x-telo-context` scope over `tools[*]` resolves `manifestItem` to the entry, and `x-telo-context-from` reads its `parameters` (the same scope machinery Run.Sequence steps and HTTP handlers use; it degrades to an open type for non-object parameter schemas). `result` is typed best-effort from the invocable's output type (instance-declared `outputType` via `x-telo-context-ref-from: "tool/outputType"`, e.g. `JS.Script`; kind-level via `x-telo-context-from-ref-kind`, e.g. `Http.Client.Request`/`Sql.Select`; `any` when neither is declared). What the existing annotations do **not** give for free is cross-checking the hand-authored `parameters` against the wrapped invocable's declared `inputType` — in the verbatim-forward path the model's `arguments` go straight to `invoke()`, so a `parameters` that disagrees with a declared `inputType` would otherwise fail only at run time. Closing that statically is **new generic analyzer validation, in scope**: when the invocable declares an `inputType` (instance- or kind-level), the analyzer checks the tool's effective input (the `inputs:` mapping result, or the verbatim `arguments` ≡ `parameters`) is assignable to it, reusing the same inputs-vs-target-`inputType` compatibility the kernel already applies to `Telo.Definition` `inputs:`; where the invocable declares no `inputType`, `parameters` is the sole contract and the invocable's own runtime input validation is the backstop. `parameters` is explicit rather than auto-derived from `inputType` because most stdlib invocables carry none at the definition level, and a kind-aware fallback would violate the analyzer's topology constraint.
- **`AiMcp.ToolProvider`** (shipped by the new `modules/ai-mcp` bridge, `capability: Telo.Mount, extends: Ai.ToolProvider`) — *runtime discovery* from an MCP server. It holds an `Mcp.Client` reference and maps `listTools()` → `tools/list` and `callTool()` → `tools/call`. Its tools are **statically opaque** — set and schemas are known only at run time — so they are validated at the server boundary (the server checks arguments against its advertised `inputSchema`; `Mcp.ToolsCall` already throws on tool errors → surfaced via `onToolError`), not by the analyzer. `ai-mcp` is the only module depending on both `@telorun/ai` and `@telorun/mcp-client`; `modules/ai` and the agent stay entirely MCP-agnostic, knowing only the `Ai.ToolProvider` abstract.

A future non-MCP source (OpenAPI spec, DB-backed tool registry) is just another `extends: Ai.ToolProvider` package — the agent never changes.

**Model contract extension** (additive, `modules/ai/telo.yaml` + `nodejs/src/types.ts`): `Ai.Model` input gains optional `tools` (each `{ name, description, parameters }` — the model never sees refs); output gains optional `toolCalls` (`[{ id, name, arguments }]`); a new `tool` message role carrying `{ toolCallId, content }` plus optional `toolCalls` on assistant messages let prior calls and their results replay to the model each turn, with `toolCallId` correlating each result to the call that produced it (providers require this match, and a single turn may request several tools); the `finishReason` enum gains `tool-calls`. The agent controller generates the stable call ids and threads them through. `Ai.Text`/`Ai.TextStream` are untouched — they never pass tools.

**Loop bound**: a `maxSteps` field (default 8) and `onMaxSteps: "throw" | "return"` (default `throw`). On `throw`, raise `ERR_AGENT_MAX_STEPS`; on `return`, hand back the last turn's text with its real `finishReason` (`tool-calls`) so non-convergence is visible. **Tool failures and unknown tools** are governed by `onToolError: "feedback" | "throw"` (default `feedback`): on `feedback`, a tool that throws — or a model-requested tool name that doesn't exist — is recorded in the `steps` trace and returned to the model as the tool result (carrying the `toolCallId`) so it can recover; on `throw`, the agent invoke aborts with the underlying error (or `ERR_AGENT_UNKNOWN_TOOL`). Feedback is not error-swallowing — the failure is always surfaced in the trace, never silently dropped. **Output**: `{ text, usage (summed across all model calls), finishReason, steps }`, where `steps` traces each turn's tool calls + results (including failures).

**Providers & bridge**: `ai-openai`'s controller wires tools through Vercel's `generateText({ tools })` and surfaces `toolCalls`; its message translation learns the `tool` role and assistant `toolCalls`. The hermetic `Ai.EchoModel` fixture (`modules/ai/tests/__fixtures__/ai-echo.yaml`) gains deterministic tool-call emission on a marker input so the agent loop is tested without a live LLM, driving real tools through an `Ai.Tools` provider. `modules/ai-mcp` ships `AiMcp.ToolProvider` plus its own discovery/dispatch tests against a stub `Mcp.Client`.

**Docs & changeset** (mandatory): new `modules/ai/docs/ai-agent.md` and `ai-tool-provider.md` (the `Ai.ToolProvider` abstract + the `Ai.Tools` static-list provider), plus `modules/ai-mcp/docs/` + README, all wired into `pages/docusaurus.config.ts` + `pages/sidebars.ts`; `modules/ai/README.md` updated to move tool use out of "Out of Scope"; a changeset covering `@telorun/ai` and `@telorun/ai-openai` (minor — additive contract extension), `@telorun/ai-mcp` (new package, initial release), and `@telorun/analyzer` (the new `parameters`-vs-`inputType` agreement check).

## Decisions

- **Loop lives in the agent controller, not the provider.** Keeps it provider-agnostic and observable (per-step trace, manifest-level control); the alternative — Vercel `generateText({ tools, stopWhen })` running the whole loop — hides the loop from Telo and forces tools into provider-callable closures.
- **A declarative loop via `Run.Sequence` (`while`/`switch`) was weighed and rejected for v1.** It would better fit the generic-primitive / visual-editing / static-analysis / polyglot goals, but dynamic dispatch over a per-agent, runtime-determined tool set doesn't map to `switch`'s enumerated cases; accumulating the tool-augmented message history (assistant `toolCalls` plus `tool` results with correlation ids) across iterations needs stateful array growth CEL expressions can't express ergonomically; and the tool-call/result message plumbing is provider-contract-level, not manifest-level. The loop is genuinely imperative control + state, so a controller is its right home. The `Ai.Model` contract is language-neutral and the algorithm small, so a polyglot re-impl is bounded and a future declarative decomposition isn't precluded.
- **One tool contract, not two parallel mechanisms.** The agent's only tool field is `toolProviders`; a static tool list (`Ai.Tools`) and an MCP server (`AiMcp.ToolProvider`) are both implementations of the single `Ai.ToolProvider` abstract. An earlier draft had a separate `tools:` field that bypassed the abstract — dropped, because an abstraction the main case routes around doesn't earn itself and reads as MCP-only.
- **One runtime contract, two static-analysis treatments.** At run time every provider is uniform (`listTools()`/`callTool()`). Statically they differ: `Ai.Tools` entries are typed at the manifest level — explicit `parameters`; `arguments`/`result` via existing context annotations; and `parameters`-vs-declared-`inputType` agreement added as a new analyzer check (see Solution) so a hand-authored schema can't silently diverge from the invocable it forwards to — while discovered tools are opaque (the server advertises them at run time) and validated at the server boundary. A deliberate, confined narrowing of "manifests MUST be type-safe": everything declarable stays typed; only the inherently-dynamic discovered set is runtime-validated.
- **`Ai.ToolProvider` is a generic abstract in `modules/ai`, and every tool flows through it — including regular ones.** `Ai.Tools` is the built-in static implementation, `AiMcp.ToolProvider` the MCP one, a future OpenAPI/DB source another. So the abstraction is genuinely multi-implementation (not an MCP escape hatch), the agent depends only on `listTools()`/`callTool()` and never learns about MCP, and the topology constraint holds.
- **The tool-provider mechanism reuses the `Telo.Mount` pattern, not a bespoke one.** `Ai.ToolProvider` declares `capability: Telo.Mount` and the agent aggregates `toolProviders` exactly as `Http.Server` aggregates `mounts` — a proven host↔mount shape. `Telo.Provider` was rejected: its `provide(): T` value-flow contract (compile-eval'd fields, output checked against the abstract's `outputType`) doesn't fit a runtime-attached collection exposing `listTools()`/`callTool()`. And unlike `Http.Server`'s bare `x-telo-ref: "telo#Mount"`, the agent types the slot to the domain abstract (`std/ai#ToolProvider`), so it accepts only tool providers, not arbitrary mounts.
- **The MCP→`Ai.ToolProvider` adapter lives in a dedicated `ai-mcp` bridge, not in `ai` or `mcp-client`.** Putting it in `ai` would force the agnostic core to depend on `mcp-client` + the MCP SDK (inherited by every `Ai.Text` user); putting it in `mcp-client` would make a general RPC transport depend on the AI domain (inherited by every non-AI MCP consumer) and chain the transport's releases to the churn-prone `Ai.ToolProvider` abstract. A bridge package quarantines the coupling and matches the repo's existing fine-grained packaging (`ai-openai`, the codec family).
- **An `Ai.Tools` entry's model-facing schema is an explicit required `parameters` field, not auto-derived from `inputType`.** Most stdlib invocables have no definition-level `inputType` (per-instance config for `JS.Script`, absent for `Http.Client.Request`), so generic derivation is impossible, and a "required-unless-derivable" rule would force kind-specific reasoning into the analyzer, violating the topology constraint. Explicit `parameters` is enforced by ordinary JSON-Schema `required`. The optional `inputs:`/`result:` mappings shape model args ↔ invocable I/O when shapes diverge, type-checked via existing generic `x-telo-*` annotations on the `Ai.Tools` schema.
- **`Ai.Model` is extended additively, not forked into a second abstract.** One provider implementation serves text, stream, and agent use; a separate `Ai.ToolModel` would fragment providers and duplicate the contract surface.
- **`onMaxSteps` defaults to `throw`.** Surfacing non-convergence over silently returning a partial answer follows the no-swallowing rule; `return` is offered for callers that prefer the partial result, which still carries the `tool-calls` finishReason and full step trace.
- **`onToolError` defaults to `feedback`.** Returning a failed tool's error to the model — and recording it in `steps` — is the agentic norm; an agent that aborts on any tool hiccup can't recover. It does not swallow the error, which stays visible in the trace; `throw` is offered for callers wanting hard-fail semantics.
- **Buffered only; streaming agent deferred.** Matches how `Ai.Text` shipped before `Ai.TextStream`; a streaming agent is a clean additive kind once the buffered loop is in use.

## Example

An agent whose tools come from two providers — a static `Ai.Tools` list wrapping a regular invocable, and a whole MCP server discovered via the `ai-mcp` bridge:

```yaml
kind: Telo.Application
metadata: { name: file-assistant, version: 1.0.0 }
secrets:
  openaiApiKey:
    env: OPENAI_API_KEY
    type: string
imports:
  Ai: std/ai@^0.4.0
  AiOpenai: std/ai-openai@^0.4.0
  Mcp: std/mcp-client@^0.4.0
  AiMcp: std/ai-mcp@^0.4.0          # the bridge — present only because we use MCP
  Js: std/javascript@^0.4.0
targets:
  - name: ask
    invoke: { kind: Ai.Agent, name: Assistant }
    inputs:
      prompt: "List the markdown files in /data, then tell me that count times 7."
      # steps.ask.result → { text, usage, finishReason, steps }
---
# Model — ai-openai implements Ai.Model.
kind: AiOpenai.OpenaiModel
metadata: { name: Gpt4o }
model: gpt-4o-mini
apiKey: "${{ secrets.openaiApiKey }}"
---
# Transport — a stdio MCP server (filesystem). mcp-client stays a pure transport.
kind: Mcp.StdioClient
metadata: { name: FilesMcp }
command: npx
args: ["-y", "@modelcontextprotocol/server-filesystem", "/data"]
clientInfo: { name: file-assistant, version: 1.0.0 }
---
# Bridge — ai-mcp turns an Mcp.Client into an Ai.ToolProvider. Only this module
# depends on both @telorun/ai and @telorun/mcp-client; `ai` never sees MCP.
kind: AiMcp.ToolProvider
metadata: { name: FileTools }
client: { kind: Mcp.StdioClient, name: FilesMcp }
---
# A regular invocable, used as a tool.
kind: Js.Script
metadata: { name: Multiplier }
inputType:  { type: object, additionalProperties: false, required: [a, b], properties: { a: { type: number }, b: { type: number } } }
outputType: { type: object, additionalProperties: false, required: [product], properties: { product: { type: number } } }
code: |
  function main({ a, b }) { return { product: a * b }; }
---
# Static tool list — a built-in Ai.ToolProvider holding regular invocable tools.
# Entries are statically typed: explicit `parameters`, analyzer-checked mappings.
kind: Ai.Tools
metadata: { name: LocalTools }
tools:
  - tool: { kind: Js.Script, name: Multiplier }
    name: multiply
    description: Multiply two numbers.
    parameters:
      type: object
      additionalProperties: false
      required: [a, b]
      properties: { a: { type: number }, b: { type: number } }
---
kind: Ai.Agent
metadata: { name: Assistant }
model: { kind: AiOpenai.OpenaiModel, name: Gpt4o }
system: "You help with files and arithmetic. Use tools when needed."
maxSteps: 10
onMaxSteps: throw
onToolError: feedback
# One field: every tool source is an Ai.ToolProvider — a static list (Ai.Tools)
# or runtime discovery (AiMcp.ToolProvider). The agent treats them uniformly.
toolProviders:
  - provider: { kind: Ai.Tools, name: LocalTools }
  - provider: { kind: AiMcp.ToolProvider, name: FileTools }
    prefix: "fs_"                          # → fs_read_file, fs_list_directory, …
    include: [read_file, list_directory]   # optional allowlist
```

What it shows:

- **Regular tool** (`multiply`) — a `Js.Script` wrapped as a statically-typed entry in an `Ai.Tools` provider; the model's arguments forward straight to `invoke()`, output JSON-stringified back.
- **MCP tools** (`fs_*`) — the filesystem server's entire tool set, discovered through `AiMcp.ToolProvider` and namespaced with `prefix` (here narrowed by `include`); no per-tool declaration.
- **One contract, clean boundaries** — both sources are `Ai.ToolProvider`s behind a single `toolProviders` field; `ai` ships `Ai.Tools`, `ai-mcp` ships the MCP provider and is the only module touching both `ai` and `mcp-client`. Remove the MCP block and `ai-mcp` is never pulled in.
