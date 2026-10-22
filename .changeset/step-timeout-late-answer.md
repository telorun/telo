---
"@telorun/sdk": patch
---

A step's `timeout:` also holds when its target's answer is delivered before the deadline timer has run: an answer at or past the deadline now fails the step `ERR_STEP_TIMEOUT`, as an elapsed timer does. Before, a busy event loop could hand the step a late answer as a success, so the same call timed out or succeeded depending on which of the two the runtime processed first.
