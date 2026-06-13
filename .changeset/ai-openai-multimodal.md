---
"@telorun/ai-openai": minor
---

Translate multimodal message content into OpenAI's wire shapes. A user message with
content parts becomes an OpenAI content array (text → `{ type: "text" }`, image →
`{ type: "image_url" }` with a base64 `data:` URL). Because OpenAI chat completions
can't carry images in a `tool` message, an image-bearing tool result is emitted as a
text placeholder plus a synthetic follow-up `user` message holding the images (the
documented OpenAI pattern); system messages flatten any parts to their text.
