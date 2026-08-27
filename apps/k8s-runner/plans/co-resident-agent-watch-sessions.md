# Co-resident agent + watch sessions

**Status: landed.**

A session can now be a **workspace that runs continuously** rather than one run:
one pod, a shared `/workspace` volume, one container per application under
`telo run --watch`, and optionally a co-resident agent from the operator's
catalog — so an edit costs a kernel reload instead of a pod. Off unless
`RUNNER_WATCH_SESSIONS` is set; run sessions are untouched.

The design and its rationale now live where they are read:

- `apps/k8s-runner/README.md` — the pod shape, the credential boundary, the two
  nouns on one stream, the routes, suspend/resume, `io` modes, the shared cache,
  the port-set re-route.
- `apps/docker-runner/README.md` — the same model over sibling containers.
- `packages/runner-core/README.md` — the `RunnerBackend` seam and the run
  projection.
- `apps/authoring-agent/README.md` — the agent's own two deployments, its routes
  and what its tools are allowed to do.
- `CLAUDE.md` — the one-paragraph summary and where to look.

This file is now only what is left.

---

## Standing divergences

Properties of the design as built, not tasks — but a reader will otherwise trip
on them.

- **`Kernel.RunFailed` and `Kernel.PortsResolved` need a `telorun/node` release.**
  Both are emitted by the CLI *inside* the app container, which runs a released
  image. Until one ships with them, a load failure surfaces only on the terminal
  and a port-set change does not re-route. Both verified against a locally built
  image; nothing else is required of them.
- **A one-shot app's `run.completed` lands late.** Under `--watch` the kernel
  holds itself open, so `Kernel.Stopped` fires when the *next* generation starts.
  The pairing is correct (`completed(N)` immediately before `started(N+1)`); only
  the timing is off. Closing it needs a kernel signal for "went idle while held".
- **Docker multi-app behind a proxy.** A proxy resolves one name per session
  (`telo-run-<sessionId>`); the port-owning container takes it as a network alias.
  With several port-declaring apps that name is ambiguous — docker round-robins a
  shared alias — so nothing is aliased and those ports are reported `rejected`.
  Single-app and no-proxy multi-app both work fully. The agent does not count
  toward this: it takes `telo-run-<sessionId>-agent`, a name of its own that the
  proxy's existing rule already resolves.
- **The user's first save after an agent turn re-pushes what the agent wrote.**
  The editor diffs each save against a snapshot of what IT last pushed, and an
  agent writes the volume directly, so that snapshot is one turn stale: the file
  is written again with identical bytes, and the watcher fires on the write
  rather than on a change. One redundant reload, and only one — the snapshot is
  correct from that save on. Closing it means threading the agent's write set
  into the editor's per-app bundle snapshots, which is more machinery than one
  reload is worth. There is no loop: reflecting an agent write into the editor
  goes through the file-mutation path, not the save path, so it pushes nothing.
- **An agent runs on every watch session the runner offers one for.** The editor
  asks for it whenever `features.agents` names the authoring agent, not when the
  chat panel happens to be open — a session's container set is fixed at creation,
  so a panel opened later could not gain one, and the same button would mean two
  things. The cost is an idle container per watch session; an operator who does
  not want that omits the name from the catalog. Tokens are spent only on a turn.
- **A suspended session is best-effort.** The checkpoint lives in the runner's
  memory, so a restart loses it and `resume` answers `404`. The editor holds the
  authoritative workspace and re-seeds in one change set. That is a requirement
  *on* the editor, not an observation about it: a client driving a watch session
  without holding the workspace loses work, and nothing in the runner prevents it.
- **Egress widened to the session namespace.** A watch session resolves its own
  module closure, so that namespace must reach module registries as well as the
  model provider. Core NetworkPolicy is CIDR-only, so a locked-down operator needs
  a CNI with FQDN policy or an egress proxy. Run sessions are unaffected.

## Worth measuring before rollout

- **First-boot resolve latency is unmeasured**, and it is the only cost this
  design does not remove — every session pays it once, and the `workspace`
  container gates the session on it. It differs sharply by closure: bundled OCI
  modules are a few digest-addressed blob fetches, while anything touching a
  deferred `pkg:npm` module (`http-server`, which the workspace app itself
  imports) pays a real npm install. If the second dominates, the answer is to
  bundle those modules, not to reintroduce a cache tier.
- **Capacity inverts** from concurrent runs to concurrent editors. The
  `RUNNER_WATCH_*` ceilings are separate from the run-session ones for that
  reason, but they have not been sized against real usage.

## Non-goals

- Hot reload without a kernel restart. `--watch` restarts the kernel; services are
  torn down and ports rebound. Much cheaper than a pod, not instantaneous.
- Cross-session workspace persistence (accounts, named projects). A checkpoint
  survives a pod, not a runner restart — durable storage is only worth building
  once there is an identity to reattach it to.
- Retiring the on-cluster image build. Run sessions keep it unchanged; watch
  sessions never reach it.
