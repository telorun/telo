---
"@telorun/runner-core": minor
---

`@telorun/runner-core/container` reads the container runners' session user: `loadSessionUserFromEnv` (`RUNNER_SESSION_USER`, `<uid>:<gid>`) and `loadSessionUserFromObject` (a configuration file's `{ uid, gid }` map) share one validation and the default `DEFAULT_SESSION_USER` (`1000:1000`) — numeric ids only, uid `0` refused, gid `0` allowed — each refusal naming the variable or the file key.
