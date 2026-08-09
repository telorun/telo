---
"@telorun/ai": minor
---

Add the image-generation contract types and the provider-neutral usage quantity.

`@telorun/ai/types` gains `AiImageModelInstance`, `ImageInvokeInput`, `ImageGenerationResult`, `GeneratedImage`, `ImageBytes`, `ImageFinishReason` and `UsageQuantity` — the Node-side typing for a provider implementing the new `Ai.ImageModel` abstract. They are convenience typing only: the contract itself is declared in the manifest, which is what lets the kernel enforce it at dispatch and lets a provider in any language implement it.

`Usage` gains optional `unit` and `total`. They are optional on the producer-facing type because providers do not report them — `Ai.Text` and `Ai.Agent` stamp them from `totalTokens`, and declare them required on their own output — so a single consumer can total spend across text and image calls instead of the module carrying two unrelated usage shapes. Existing providers need no update.
