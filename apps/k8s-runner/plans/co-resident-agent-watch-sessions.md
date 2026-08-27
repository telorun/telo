# Co-resident agent + watch sessions

**Status: landed, minus the items under "Remaining" below.**

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
- `CLAUDE.md` — the one-paragraph summary and where to look.

This file is now only what is left.

---

## Remaining

### 1. The co-resident agent is not reachable from the editor

The pod half is done and tested: the agent container mounts the shared volume,
receives the operator env and nothing else, and its manifest is rooted at
`WORKSPACE_DIR` (which both runners set), so its file tools write the tree the
app containers watch.

What is missing is the editor:

- The studio never sends `agent` on a session, so there is no way to ask for one.
  `/v1/capabilities` already advertises `features.agents` (the operator catalog),
  and the session route already validates the field — `400 unknown_agent`, and
  `400 agent_requires_watch` without `mode: "watch"`.
- The studio still opens a **separate** agent session via
  `POST /v1/apps/authoring-agent/sessions` and polls that session's `/workspace`.
  For editor-driven authoring that is what the co-resident agent replaces: the
  agent writes the session's own volume directly, and the editor reads and writes
  it through `/v1/sessions/:id/workspace` like any other client.
- The agent's own `/workspace` routes stay, for standalone use.

**Verify.** Start a watch session with an agent from the editor; have the agent
write a file; assert the app reloads (a `run` event with `trigger: "watch"`) and
that the editor's workspace tree shows the agent's file.

### 2. `apps/authoring-agent/README.md` does not exist

The workspace is now the session's shared volume, written through the agent's own
filesystem tools and rooted at `WORKSPACE_DIR`; the agent can observe a running
app. There is no README to say so.

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
  Single-app and no-proxy multi-app both work fully.
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
