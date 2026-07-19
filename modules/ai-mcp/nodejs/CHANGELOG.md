# @telorun/ai-mcp

## 0.5.2

### Patch Changes

- 8af345f: The `Telo.Definition` schema is now the sole resource-config contract.

  A controller module's exports become the controller instance verbatim, so an
  `export const schema` silently won over the manifest's `schema:`. The analyzer
  never loads controllers, so those overrides were invisible to `telo check` and
  to the editor, could not be pre-compiled by the validator warm (recompiling on
  every boot, and failing to persist on a read-only image), and were free to drift
  from the manifest they shadowed.

  `ControllerInstance.schema` is removed, and the kernel now validates every
  resource against its definition's schema. All 35 controller-exported schemas are
  gone: 26 were `additionalProperties: true` catch-alls that merely _disabled_ the
  manifest's stricter validation, and 9 kept their TypeBox for `Static<typeof …>`
  typing but no longer export it.

  Two manifests had already drifted and are corrected:

  - `S3.Bucket` was missing `accessKeyId` / `secretAccessKey` entirely, though its
    controller required both. They are now declared (and required) in the manifest.
  - `Assert.ModuleContext` was missing `resources` / `variables` / `secrets`.

  Controller authors: declare config in `telo.yaml`, not in code. An
  `export const schema` is now inert.

- Updated dependencies [8af345f]
  - @telorun/ai@0.7.1

## 0.5.1

### Patch Changes

- Updated dependencies [ea7823a]
  - @telorun/ai@0.7.0

## 0.5.0

### Minor Changes

- e398d4d: Normalize MCP tool-result content into Ai content parts. An MCP `tools/call` result
  array is translated block-by-block — a text block stays a text part, and an **image**
  block (`{ type: "image", data, mimeType }`) becomes an Ai image part with its `mimeType`
  renamed to the contract's `mediaType`, so a vision MCP tool's image reaches the model as
  an image part instead of a JSON-stringified blob. A result containing any unrecognized
  block kind (resource link, audio, …) is handed back untouched, as before.

### Patch Changes

- Updated dependencies [e398d4d]
  - @telorun/ai@0.6.0

## 0.4.1

### Patch Changes

- Updated dependencies [5331205]
  - @telorun/ai@0.5.0

## 0.4.0

### Minor Changes

- c1432a6: ai: `Ai.Agent` tool-use loop + `Ai.ToolProvider` / `Ai.Tools`, with MCP discovery via `@telorun/ai-mcp`

  Adds a tool-use agent to the AI module. `Ai.Agent` (`Telo.Invocable`) runs a buffered
  loop over any `Ai.Model`: it advertises a tool set, executes the tools the model
  requests, replays the results, and loops until the model produces a final answer or
  `maxSteps` is reached. The loop lives in the controller (provider-agnostic, observable
  via the returned `steps` trace), not in the provider.

  Tools come from one field, `toolProviders` — a list of `Ai.ToolProvider` references.
  `Ai.ToolProvider` is a new `Telo.Abstract` (`capability: Telo.Mount`) exposing
  `listTools()` / `callTool()`; the agent mounts providers the way `Http.Server` mounts
  `Http.Api`s. Two implementations ship:

  - `Ai.Tools` (in `@telorun/ai`) — a static list of tools, each wrapping any
    `Telo.Invocable`, with a required model-facing `parameters` schema and optional
    `inputs:`/`result:` CEL mappings for invocables whose call shape diverges.
  - `AiMcp.ToolProvider` (new package `@telorun/ai-mcp`) — discovers a whole MCP server's
    tools at run time (`tools/list` → descriptors, `tools/call` → dispatch). It is the only
    module depending on both `@telorun/ai` and `@telorun/mcp-client`; the `ai` core stays
    MCP-agnostic and `mcp-client` stays a pure transport.

  The `Ai.Model` contract is extended additively: optional `tools` on input, optional
  `toolCalls` on output, a `tool` message role with `toolCallId` correlation, and a
  `tool-calls` finishReason. `Ai.Text` / `Ai.TextStream` never pass tools and are
  unaffected. `@telorun/ai-openai` wires tools through Vercel `generateText({ tools })`
  and translates the tool-role / assistant-tool-call messages.

  Loop bounds are configurable: `maxSteps` (default 8), `onMaxSteps` (`throw` | `return`,
  default `throw`), and `onToolError` (`feedback` | `throw`, default `feedback` — a failed
  or unknown tool is recorded in `steps` and returned to the model so it can recover,
  never silently swallowed).

  Analyzer fix (patch): seed the `Self` alias for every module that contributes
  definitions, not only modules whose `Telo.Library` doc is present in the flattened
  manifest set. `flattenForAnalyzer` forwards an imported library's definitions but not its
  module doc, so a kind declaring `extends: Self.<Abstract>` (an abstract in the same
  library) previously mis-keyed its `extendedBy` edge under the literal `"Self.<Abstract>"`
  when the library was imported rather than analyzed standalone. The bug stayed invisible
  until a second module implemented the same abstract (e.g. `Ai.Tools` + `AiMcp.ToolProvider`
  both implementing `Ai.ToolProvider`), at which point a valid reference to the
  `Self`-extending kind was wrongly rejected as not implementing the abstract.

### Patch Changes

- Updated dependencies [c1432a6]
  - @telorun/ai@0.4.0
