---
sidebar_label: Coding Agents
slug: /build/coding-agents
description: Connect Claude Code, Cursor, or any MCP-aware editor to a live Telo module catalog so the LLM can author manifests against the real surface.
---

# Coding Agents

Telo manifests are dense and the standard library moves fast. The Telo
registry exposes a Model Context Protocol server at
`https://registry.telo.run/mcp` that any MCP-aware coding agent can plug
into. Once connected, the agent can search the module catalog, fetch any
module's `telo.yaml`, and follow a built-in primer that explains how Telo
works — so a model with no prior Telo context can compose a working
manifest.

No authentication is needed for reads.

## What the agent gets

On `initialize`, the server publishes two tools and an instructions primer:

- **`search_modules`** — lists every published module
  (`{ namespace, name, version, description }`). Takes no arguments.
- **`get_module_manifest(namespace, name, version)`** — returns the raw
  `telo.yaml` for a specific version. This is the agent's source of truth
  for `Telo.Definition` schemas, capability types, and CEL context shapes.
- **Instructions primer** — explains Telo's runtime model, built-in kinds
  (`Telo.Application`, `Telo.Library`, `Telo.Import`, `Telo.Definition`),
  CEL `${{ }}` templating, and the recommended workflow: search → read
  manifest → compose.

The primer is surfaced to the LLM as system context, so the model knows
Telo before you've written a single message.

## Claude Code

```bash
claude mcp add --transport http telo https://registry.telo.run/mcp
```

Verify:

```bash
claude mcp list
```

The next session picks up the tools and the primer automatically.

## Cursor

Add to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in your project root for
a per-project setup):

```json
{
  "mcpServers": {
    "telo": {
      "url": "https://registry.telo.run/mcp",
      "transport": "http"
    }
  }
}
```

Restart Cursor and the tools become available to the agent.

## Claude Desktop

Claude Desktop's MCP client speaks stdio rather than HTTP, so it needs a
small bridge. `mcp-remote` (npm) adapts any HTTP MCP server to a stdio
transport:

```json
{
  "mcpServers": {
    "telo": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://registry.telo.run/mcp"]
    }
  }
}
```

Put that in `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows), then
restart Claude Desktop.

## What to ask

Once connected, prompts that lean on the catalog work well:

- "Build me a Telo manifest for an HTTP API that writes feedback entries
  to SQLite."
- "Wire up an MCP server in Telo that exposes `get_user` and `list_users`
  against a Postgres database."
- "Add a daily job that reads new rows from a SQL database, summarizes
  each with `Ai.Text`, and writes the summaries to S3."

The agent will call `search_modules`, drill into the manifests of the
modules that match, and produce YAML against the actual schemas — no
guessed kind names, no stale field shapes.

## Self-hosted registries

If you run your own Telo registry, the MCP endpoint lives at `POST /mcp`
on the same HTTP server as the REST API. Point your agent at
`https://your-registry.example.com/mcp` and everything else is identical.
