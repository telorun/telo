---
"@telorun/runner-core": minor
"@telorun/debug-wire": patch
"@telorun/k8s-runner": minor
"@telorun/docker-runner": minor
"@telorun/studio": minor
"@telorun/cli": minor
---

Watch sessions: a session can now be a workspace that runs continuously instead
of one run. One pod holds a shared `/workspace` volume, a `workspace` container
serving the editor's file routes, one container per application under `telo run
--watch`, and optionally a co-resident agent from the operator's app catalog — so
an edit costs a kernel reload rather than a pod. Off unless
`RUNNER_WATCH_SESSIONS` is set; run sessions are unchanged.

Session status and run outcome become two nouns on one stream. `status` is the
session's (`starting`/`running`/`suspended`/`stopped`/`failed`), while a new `run`
event carries one application's generation — so a one-shot Runnable finishing
leaves the session alive and the next edit starts the next generation. `run`
events are projected from the kernel debug stream rather than parsed out of a
terminal, and the CLI now emits `Kernel.RunFailed` for the one case that stream
did not carry: a manifest that fails to load at all.

Breaking, and the ripple is the reason the version moves rather than the size of
it: `RunnerFeatures.io` becomes a list of attach modes; `progress`, `debug`,
`reachability` and the byte channel are qualified by application (`/io` takes
`?app=`, and every binary frame gains a stream tag); and the `stdout` / `stderr`
`RunEvent` variants are deleted — nothing ever emitted them, so they were a
contract in shape only. Workload output travels the byte channel, as it always
did in practice.

`@telorun/debug-wire` gains no code — its README now writes down the four kernel
events a HOST derives behaviour from (`Kernel.Starting`, `Kernel.Stopped`,
`Kernel.RunFailed`, `Kernel.PortsResolved`) and the requirement that a stream
with a replay buffer carry a monotonic `id:` and honour `Last-Event-ID`. The
dotted event vocabulary is otherwise open; these four are the exception because a
kernel that omits them leaves a runner with no run outcomes and no way to
re-route a port, so a second runtime needs them written down.

The CLI also honours `CLICOLOR_FORCE` for Node's colour libraries, bridging it
onto `FORCE_COLOR` when that is not already set — one variable now reaches a
Rust, Go or Node workload alike, and `FORCE_COLOR=0` beside `CLICOLOR_FORCE=1`
keeps its meaning.
