---
"@telorun/k8s-runner": minor
---

The session user is configurable: the session file's `user: { uid, gid }` (chart: `session.user`, default `1000:1000`) sets every session pod's `runAsUser`, `runAsGroup` and `fsGroup`, `runAsNonRoot` staying on. uid `0`, a non-numeric id, a missing `gid` or an unknown key under `user` refuses to boot, naming the key, and a `RUNNER_SESSION_USER` variable refuses to boot naming `user`. An adopted pod running as another user is removed and its session suspended; `resume` rebuilds it. The agent container now gets `HOME` and `npm_config_cache` as the other containers do, so an agent image runs under any numeric uid.
