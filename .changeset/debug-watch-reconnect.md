---
"@telorun/cli": patch
---

Fix `telo run --watch --inspect` dropping the debug UI on every reload. The
inspection server is now created once per session and the rebuilt kernel
re-attaches to it each cycle, so the browser's SSE connection (and replay buffer
+ JSONL) survive reloads instead of the UI showing the process as terminated.
