---
sidebar_label: Coding Agents
slug: /build/coding-agents
description: Connect Claude Code, Cursor, or any MCP-aware editor to the Telo hub so the LLM can discover modules and author manifests against the real surface.
---

# Coding Agents

Telo manifests are dense and the standard library moves fast. The Telo
**hub** — the federated discovery index over every registered module — exposes
a Model Context Protocol server at `https://telo.sh/mcp` that any MCP-aware
coding agent can plug into. Once connected, the agent can search for a resource
kind by what it does, fetch the owning module's `telo.yaml`, and follow a
built-in primer that explains how Telo works — so a model with no prior Telo
context can compose a working manifest.

No authentication is needed for reads.

## What the agent gets

On `initialize`, the server publishes two tools and an instructions primer:

- **`search_resources(query)`** — searches resource *kinds* across every
  registered module, on any host or transport. The unit an agent composes with
  is a kind it can import, not a package, so each hit carries the bare kind
  suffix (e.g. `Bucket` — the prefix is *your* chosen import alias), its
  capability and description, and the owning module's exact location ref +
  version.
- **`get_module_manifest(ref, version?)`** — returns the raw `telo.yaml` for a
  tracked module by its location ref (e.g. `std/console` or
  `oci://ghcr.io/acme/telo-s3`). `version` defaults to `latest`. This is the
  agent's source of truth for `Telo.Definition` schemas, capability types, and
  CEL context shapes.
- **Instructions primer** — explains Telo's runtime model, built-in kinds
  (`Telo.Application`, `Telo.Library`, `Telo.Definition`), CEL `!cel "…"`
  templating, and the recommended workflow: search → read manifest → compose.

The primer is surfaced to the LLM as system context, so the model knows
Telo before you've written a single message.

The hub only indexes discovery metadata and cached manifests — it never stores
artifact payloads. Installing and running resolve against each module's own
origin, so the discovery surface and the resolution path are fully decoupled.

## Claude Code

```bash
claude mcp add --transport http telo https://telo.sh/mcp
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
      "url": "https://telo.sh/mcp",
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
      "args": ["-y", "mcp-remote", "https://telo.sh/mcp"]
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

The agent will call `search_resources`, drill into the manifests of the
modules that own the matching kinds, and produce YAML against the actual
schemas — no guessed kind names, no stale field shapes.
