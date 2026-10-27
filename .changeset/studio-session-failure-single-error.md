---
"@telorun/studio": patch
---

A workspace session that fails to start, or whose files cannot be pushed to it, shows one error in the top bar's session status instead of a toast per attempt, and a Try again button there opens the session again. A failed push is no longer retried by itself, so it cannot loop.
