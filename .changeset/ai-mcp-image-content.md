---
"@telorun/ai-mcp": minor
---

Normalize MCP tool-result content into Ai content parts. An MCP `tools/call` result
array is translated block-by-block — a text block stays a text part, and an **image**
block (`{ type: "image", data, mimeType }`) becomes an Ai image part with its `mimeType`
renamed to the contract's `mediaType`, so a vision MCP tool's image reaches the model as
an image part instead of a JSON-stringified blob. A result containing any unrecognized
block kind (resource link, audio, …) is handed back untouched, as before.
