---
"@telorun/ai": minor
---

Multimodal message content and content-part tool results.

- `Message.content` widens from `string` to `string | ContentPart[]` — a text part
  (`{ type: "text", text }`) or an image part (`{ type: "image", data, mediaType }`,
  where `data` is raw bytes or a base64 string). Additive: plain-string messages are
  unchanged, and `Ai.Text` / `Ai.TextStream` / `Ai.Agent` accept the new shape.
- `Ai.Agent` carries content-part tool results through the `tool` message and the
  `steps` trace untouched instead of unconditionally JSON-stringifying them, so a
  vision tool can hand the model an image.
- `Ai.Tools`' `tool` slot widens from `telo#Invocable` to `telo#Invocable |
  telo#Runnable`, so a `Run.Sequence` pipeline can be wrapped as a single tool; its
  `result:` mapping may produce content parts.
- New `@telorun/ai/content` export with the `ContentPart` types and helpers.

Note: because an MCP tool's `content` array is already content-part-shaped, MCP
text results now flow to the model as a text part instead of a JSON-stringified
blob (`AiMcp.ToolProvider`).
