---
description: "Mcp.ToolsList — dispatches tools/list against any Mcp.Client. Returns the typed tools array advertised by the server."
sidebar_label: Mcp.ToolsList
---

# `Mcp.ToolsList`

> Examples below assume `mcp-client` is imported as `McpClient`.

Dispatches the `tools/list` MCP RPC through a referenced `Mcp.Client`. Takes
no inputs and returns the typed `tools` array the server advertises.

## Schema

```yaml
kind: McpClient.ToolsList
metadata: { name: <Name> }
client: <ClientName>                # any resource extending Mcp.Client
```

## Output

```yaml
result:
  tools:
    - name: <string>
      description: <string>
      inputSchema: { ... }          # per-tool JSON Schema; open shape
```

`inputSchema` stays open because the inner schema is per-tool and unknown
statically. Consumers that need to introspect arguments can read it as a
plain object via CEL.

## Errors

Same code set as `Mcp.ToolsCall` minus `ERR_MCP_TOOL_ERROR` — `tools/list`
has no soft-failure envelope. See the
[README error contract](../README.md#error-contract).
