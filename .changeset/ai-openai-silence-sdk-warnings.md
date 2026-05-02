---
"@telorun/ai-openai": patch
---

Silence the Vercel AI SDK's `AI SDK Warning: …` console output by setting `globalThis.AI_SDK_LOG_WARNINGS = false` at module load. The warnings (e.g. `temperature is not supported for reasoning models`) are useful during library development but noise for Telo manifest consumers who can't act on them. Suppressed once at import time; affects every consumer of `@telorun/ai-openai` in the same Node process.
