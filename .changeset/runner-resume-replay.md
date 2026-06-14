---
"@telorun/runner-core": minor
---

Retain exited sessions long enough for the editor to re-attach and replay a run's console + inspection history after a page reload. The exit-eviction TTL default goes from 5 minutes to 4 hours, the max retained sessions default from 8 to 32, and at capacity the registry now evicts the oldest *terminal* session before rejecting a new run (live sessions are never evicted), so a long TTL never blocks a new run.
