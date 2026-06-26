---
"@telorun/runner-core": minor
"@telorun/k8s-runner": minor
"@telorun/docker-runner": minor
"@telorun/debug-ui": minor
"@telorun/editor": minor
---

Surface session port reachability on the endpoint badge instead of the log stream.

After a session goes running, the runner (`watchReachability` in
`@telorun/runner-core`, used by the k8s and docker backends) probes each declared
tcp port and emits a structured `reachability` `RunEvent` per port — `checking`,
then `reachable`, or `unreachable` after a 30s timeout (flipping back to
`reachable` if it recovers). The editor renders this on each endpoint link in the
debug panel: a spinner while checking, a green icon when reachable, a red icon
when unreachable — turning the loopback-bind / wrong-port failure (previously an
opaque downstream 502, or a late log line) into live status on the URL itself.

The badge reflects reachability from the runner to the workload (pod network for
k8s, published port / container for docker) — a proxy for the common loopback-bind
failure, not end-to-end health of the public link, and a startup signal rather
than continuous monitoring (a port that comes up then dies keeps its green icon).
