---
"@telorun/kernel": patch
"@telorun/cli": patch
"@telorun/sdk": patch
---

A stop asked between `Kernel.Started` and `start()` reaching its idle wait is no longer lost: `forceIdle()` with no wait pending releases the next `waitForIdle()`, so a SIGTERM in that window ends the process instead of leaving it running.
