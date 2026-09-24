---
description: "Mcp.Tools — passive bundle of tool entries dispatched via tools/call. Each entry maps an MCP envelope to any Telo.Invocable handler via CEL adapters."
sidebar_label: Mcp.Tools
---

# `Mcp.Tools`

> Examples below assume `mcp-server` is imported as `Mcp` and `javascript` as `JS`.

A passive bundle declaring tools that any `Mcp.StdioServer` or `Mcp.HttpEndpoint`
can advertise. Bundles are referenced by name from a transport's `tools:`
array — multiple bundles compose into a single transport, and one bundle can
serve multiple transports.

## Schema

```yaml
kind: Mcp.Tools
metadata: { name: <BundleName> }
entries:
  - name: <tool_id>                   # advertised to clients via tools/list
    description: <text>
    argumentsSchema:                  # JSON Schema validated by the MCP SDK
      type: object
      properties: { ... }
      required: [...]
    handler: <ref to a Telo.Invocable>
    inputs:                           # CEL: MCP request → handler input
      <handlerField>: !cel "request.arguments.<x>"
    result:                           # CEL: handler output → CallToolResult
      content:
        - type: text
          text: !cel "result.<y>"
      isError: !cel "result.<bool>?"  # optional
    catches:                          # optional — InvokeError → JSON-RPC error
      - code: <telo_error_code>       # match by code, omit for catch-all
        when: !cel "<bool>"           # optional CEL predicate
        error:
          code: <jsonrpc_int>
          message: !cel "error.message"
          data: !cel "error.data"     # optional
```

## CEL scopes

Each entry exposes three runtime scopes:

| Field      | Available                                                             |
| ---------- | --------------------------------------------------------------------- |
| `inputs:`  | `request.{name, arguments, meta, session.{id, clientInfo, capabilities}}` |
| `result:`  | `result` (handler output), `request.{name, arguments}`                |
| `catches:` | `error.{code, message, data}`, `request.{name, arguments}`            |

`request.session` is per-connection metadata: for `Mcp.HttpEndpoint` it's the
session ID minted on `initialize`; for `Mcp.StdioServer` it's a synthetic UUID
minted at process start (stdio has no transport-level session).

## Result envelope

`result:` is the **full MCP `CallToolResult`**, not just the content array:

| Field              | Required | Notes                                                   |
| ------------------ | -------- | ------------------------------------------------------- |
| `content`          | yes      | Array of content blocks (`{type, text}`, `{type, image}`, …). |
| `isError`          | no       | Soft tool failure — content describes what went wrong.  |
| `structuredContent`| no       | Optional structured object alongside `content`.         |
| `_meta`            | no       | MCP metadata passthrough.                               |

The client reading a result is not Telo, so a CEL value anywhere in the rendered envelope — or in a `catches:` entry's `error.data` — is written in its **plain encoding**, never type-tagged: a timestamp as RFC 3339 text in UTC (`"2026-01-15T07:30:00.000Z"`), a duration as seconds (`"5400s"`), bytes as base64url, a `uint` as its digits, NaN and ±Infinity as `"NaN"` / `"Infinity"` / `"-Infinity"`, and a map with int or bool keys as an object keyed by their text.

`isError: true` and `catches:` are **distinct**:

- `isError` — handler ran successfully but the *result* describes an upstream failure (e.g. a third-party 404). The LLM reads natural-language failure text.
- `catches:` — handler threw an `InvokeError`. Maps Telo error codes to JSON-RPC error responses with negative integer codes (convention: `-32001` and below for application errors).

## Cross-bundle composition

```yaml
kind: Mcp.HttpEndpoint
metadata: { name: McpHttp }
serverInfo: { name: my-mcp, version: 1.0.0 }
tools: [WeatherTools, DatabaseTools]   # entries from both bundles are merged
```

Duplicate `name` across bundles → init-time error naming both bundles. Same
bundle referenced twice → init-time error.
