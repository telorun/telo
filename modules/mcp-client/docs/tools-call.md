---
description: "Mcp.ToolsCall — dispatches tools/call against any Mcp.Client. Typed content array, isError converted to ERR_MCP_TOOL_ERROR."
sidebar_label: Mcp.ToolsCall
---

# `Mcp.ToolsCall`

> Examples below assume `mcp-client` is imported as `McpClient`.

Dispatches the `tools/call` MCP RPC through a referenced `Mcp.Client`
(`Mcp.HttpClient`, `Mcp.StdioClient`, or any future transport). Has zero
transport knowledge — JSON-RPC framing, session handling, content-type
negotiation, and re-handshake-on-invalidation all live inside the client.

## Schema

```yaml
kind: McpClient.ToolsCall
metadata: { name: <Name> }
client: <ClientName>                # any resource extending Mcp.Client
```

## Inputs

```yaml
inputs:
  name: <tool_name>                 # required
  arguments: { ... }                # optional, validated server-side
```

## Output

```yaml
result:
  content: [ <content block>, ... ] # required
  structuredContent: { ... }        # optional, open shape in v1
```

`content[]` is a closed union keyed by `type`:

| `type`          | Required fields                                                                         |
| --------------- | --------------------------------------------------------------------------------------- |
| `text`          | `text`                                                                                  |
| `image`         | `data` (base64), `mimeType`                                                             |
| `audio`         | `data` (base64), `mimeType`                                                             |
| `resource_link` | `uri`; optional `name`, `description`, `mimeType`                                       |
| `resource`      | `resource.uri`; optional `resource.mimeType`, `resource.text`, `resource.blob` (base64) |

In v1 the chain validator catches accesses to *undeclared* properties on any
content variant (e.g. `result.content[0].bogus`). Cross-variant access
(`result.content[0].data` against a `text` item) is still accepted today and
becomes a static error once the analyzer's `oneOf`-discriminator narrowing
ships.

`structuredContent` is intentionally open in v1: the MCP spec ties its shape
to a per-tool `outputSchema` declared by the server. A typed `Mcp.Tool` +
`Mcp.ToolsCallTyped` variant will land when per-tool schemas are
first-class.

## Soft failures

`isError: true` on the server response is converted to an
`ERR_MCP_TOOL_ERROR` throw — the success path of `Mcp.ToolsCall` never
observes the `isError` field. Map this throw in a surrounding
`Run.Sequence` try/catch (or HTTP route `catches:` block) when you want to
render the LLM-readable failure message as user-facing content.

```yaml
steps:
  - name: Wrap
    try:
      - name: Call
        inputs: { name: get_weather, arguments: { city: Atlantis } }
        invoke: { kind: McpClient.ToolsCall, name: CallGetWeather }
    catch:
      - name: HandleToolError
        inputs:
          content: "${{ error.data.content }}"
        invoke: ...
```

## Errors

| Code                      | Source                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| `ERR_MCP_TOOL_ERROR`      | Originated by `Mcp.ToolsCall` from `isError: true` server responses.                           |
| `ERR_MCP_JSON_RPC_ERROR`  | Originated by the client when the server returned a JSON-RPC error envelope.                    |
| `ERR_MCP_TRANSPORT`       | Originated by the client on network failure / unexpected Content-Type / non-2xx HTTP responses. |
| `ERR_MCP_PROTOCOL`        | Originated by the client on malformed JSON-RPC envelopes.                                       |
| `ERR_MCP_SESSION_INVALID` | HTTP only. Originated by the client after exhausted internal retry.                             |
