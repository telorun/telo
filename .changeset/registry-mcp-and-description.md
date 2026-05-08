---
---

Registry app changes (no published package — `apps/registry` is consumed via
its docker image, not npm).

Expose the registry over MCP at `POST /mcp` and start indexing module
descriptions on publish.

**MCP server.** A new `Mcp.HttpEndpoint` mounts on the existing `Http.Server`
and advertises two tools: `search_modules` (returns every module with its
description, no arguments) and `get_module_manifest` (returns the raw
`telo.yaml` for a `(namespace, name, version)`). On `initialize` the server
ships a Telo primer via the SDK Server's `instructions` option, so MCP
clients that surface instructions to their LLM (Claude Desktop, etc.) can
use the registry without a discovery round-trip first.

**Description indexing.** `PublishHandler` now parses the YAML body
server-side via `Yaml.Parse`, validates that the first document is a
`Telo.Library` or `Telo.Application`, and writes `metadata.description` into
the `description` column. Missing descriptions, missing `metadata` blocks,
and non-string descriptions (publisher mistakes — e.g. a YAML mapping where
a string is expected) all bind as SQL `NULL`, keeping "no description"
distinct from an explicit empty string. `ON CONFLICT … SET description =
EXCLUDED.description` means future republishes refresh the indexed value —
descriptions populate naturally as modules ship new versions, no separate
backfill step.

Adds a malformed-input route for `MANIFEST_PARSE_FAILED` / `INVALID_MANIFEST`
→ HTTP 400 in the PUT route's `catches:`.
