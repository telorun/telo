---
"@telorun/runner-core": minor
"@telorun/k8s-runner": minor
---

A session's co-resident `agent` is now **reachable**, so an editor can talk to
one instead of launching an agent session of its own.

The pod half already worked: the agent container mounted the shared volume, took
the operator env and nothing else, and wrote the tree the app containers watch.
But no backend published its port and no route reached it, so an agent could be
asked for and could edit files while nothing outside the pod could ask it to.

**The port is the operator's to declare.** A `RUNNER_APPS` entry gains `port` —
the tcp port its image listens on — with deliberately **no default**: the catalog
is operator configuration and the runner has no built-in knowledge of any
specific app, so defaulting to 8080 would be exactly that knowledge. Requesting
an agent whose entry declares none is `400 agent_port_undeclared`, naming the
setting to add, rather than a container started where nothing can reach it. The
port is unique across the whole session like an app's (`400 port_conflict`),
because session hosts carry no container name.

**`RunStatus.running` gains an `agent` endpoint**, beside `endpoints` rather than
inside it: `endpoints` are the ports the user's applications declared, and an
operator-launched container is not one of them. An ENDPOINT rather than a URL
string, because a runner publishing to the host knows the port and not the
hostname the client reached it by — the same reason an app's endpoint has an
empty `host` for the client to fill.

On kubernetes nothing is arranged beyond declaring it: the pod's containers share
one network namespace, so the port joins the session's own Service and Ingress
and answers at `<agentPort>-<sessionId>.<base-domain>`. A reload that declares
that port for an app is rejected with the agent named as the reason.

---

**A docker watch session's workspace is now `/workspace`**, the path kubernetes
already uses, instead of `/srv/<sessionId>/workspace`.

The application containers and the agent mount only that session's own
`workspace` subdirectory of the shared volume. Three things follow, and the
third is why the change had to happen:

- A manifest is `/workspace/telo.yaml` on both backends, and no session id
  reaches any path a workload sees.
- One session's containers can no longer read another session's files on disk.
  The workspace API is still name-addressable with no auth, so the runner is
  still not the multi-tenant one — but the disk half of that exposure is gone
  for watch sessions.
- Nothing is mounted over a directory an operator's catalog image may already be
  using. Mounting the volume whole at `/srv` covered up the authoring agent's own
  installation, which is why a **co-resident agent could never start on docker**.

The runner's own `workspace` container keeps the whole-volume bind, because its
manifest and its module cache sit beside the workspace it serves — and that same
siblinghood is what keeps both out of the user's file tree now that the mount is
scoped.

**This needs Docker Engine API 1.45 (Docker 26) or newer.** An older daemon
ignores the subpath and mounts the volume whole at the target — every session's
files in every container, at a path that looks correct — so the runner probes the
daemon at boot and advertises `features.watch: false` when it is too old rather
than degrading into that silently. Run sessions are unaffected and keep their
whole-volume `/srv` bind.
