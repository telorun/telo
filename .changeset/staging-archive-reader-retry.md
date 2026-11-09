---
"@telorun/kernel": patch
---

Fetch each upstream archive a module stages files from once per kernel instead of once per file, and retry transient download failures (network errors, 5xx, 429) up to three attempts, so a clean checkout no longer times out starting servers or fails on one flaky upstream response.
