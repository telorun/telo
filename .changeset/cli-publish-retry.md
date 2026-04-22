---
"@telorun/cli": patch
---

`telo publish` now retries transient registry push failures with exponential backoff (up to 4 attempts). Retries on network errors (DNS, reset, `fetch failed`) and on `408`, `425`, `429`, and `5xx` responses so flaky CI pushes no longer fail the whole workflow.
