---
status: draft
priority: high
depends-on: []
packages: [packages/runner-protocol, packages/runner-core, apps/docker-runner, apps/k8s-runner, apps/host-runner, apps/studio]
refinement: not-started
---

# A session that runs without its agent

## Problem

A session's co-resident agent is treated as a required member of the session. On every backend, an agent that cannot start or that ends takes the whole session down with it:

- docker: the agent container ending, or a failed pull, create or start of it during bring-up;
- k8s: the `agent` container terminating in the session pod;
- host runner: the agent process ending.

Each of these reports the session `failed`, ends every live app run, and removes the workload. Studio then resumes the session, the agent fails again, and the loop repeats. Meanwhile Studio's app-set changes are answered `409 session_busy` several times a second.

One defect in the agent therefore makes every application in the workspace unusable. That defect can be a bad module, a missing key, an out-of-memory kill or an image that will not pull. The concrete case is the docker dev stack: the agent's relative stdlib imports do not resolve in its container, so `telo run` stops with 37 `IMPORT_UNRESOLVED` errors. The user's apps never get to run, and the only message anyone sees is the session's `failed` status.

The runner also cannot say why an agent is missing. The `running` status carries the agent's endpoint or nothing. So Studio's only message for a running session without an agent is "The runner runs this session's agent but reports no address for it, so it cannot be reached." That sentence is wrong for every real cause, and nothing verifies that the agent actually listens on its declared port.

## Constraints

- I would rather have it fallback to manual mode if agent can't run, user should receive a message that agent is not available

## Surface

**Added**

- `agentStatus`: a field on the `running` status (event stream and `GET /v1/sessions/:id`). It is present exactly when the session document's `agent` is non-null.
- `AgentStatus`: the protocol schema def for that field, `{ state, restarts, reason?, ended? }`.
- `agentStatus.state`: `starting` | `available` | `unavailable`.
- `agentStatus.restarts`: the number of times the agent has been restarted since it was created. Required in every state.
- `agentStatus.reason`: the runner's sentence saying why the agent is unavailable and where its output can be read. It never contains any of the agent's own output. Present only when `unavailable`.
- `agentStatus.ended`: `{ code?, signal? }`, present when the agent's process ended.
- k8s: the agent pod. It carries the managed-by label and `telo.run/agent-session-id=<id>`, is owned by the session pod, and is held to the session pod's node.
- k8s: Service `telo-session-<id>-agent`, selecting only the agent pod.
- k8s: host `<port>-<sessionId>-agent.<base>`, routed through the routing mode in force (Ingress or HTTPRoute).
- Studio: **Retry agent** on the agent-unavailable notice.

**Changed**

- `running` status, `agent`: still a `RunnerEndpoint` with `token`. It is now present exactly when `agentStatus.state` is `available`, which a JSON Schema if/then condition on the `running` variant enforces.
- `PUT /v1/sessions/:id/agent`: the same name replaces the agent now, with a fresh token and the backoff reset.
  - On docker and the host runner a replacement ends no app run.
  - It answers `202` even when the new agent then fails to start, which becomes `unavailable`.
  - `500 set_agent_failed` is kept only for a replacement the runner could not carry out.
- An agent that ends or cannot start no longer makes the session `failed`, on any backend.
- k8s: the agent leaves the session pod, its port leaves the session Service, and the session pod no longer mounts `agent/` of the session claim.

**Removed**

- Studio's sentence "The runner runs this session's agent but reports no address for it, so it cannot be reached." It now appears only against a runner that sends no `agentStatus`.

## Solution

### The rule

The session's required members are the workspace and the app supervisors. Only a required member's ending fails the session.

The co-resident agent is an optional member. When it ends or cannot start, that is a state the runner reports in `agentStatus`. It never makes the session `failed` and never ends a run.

Why: a session exists to run the user's applications, and they run without the agent. This is the sidecar-versus-main-container split, systemd's `Wants=` against `Requires=`. The workspace container still fails the session exactly as today.

The create-time drop is unchanged. When an app declares the agent's port, the session starts without the agent, the record holds `null` and a `progress` notice says why. That is an admission decision, not an observed failure.

### Desired versus observed

The session document's `agent` stays the name that was asked for. `agentStatus` is what the runner observes about it.

A failure never clears the recorded agent. Clearing it would turn an observation into a change of intent: a transient crash would downgrade the session for good, and a resume would silently drop the agent the user chose.

### Restarting

The backend restarts the agent by itself, under one policy the contract states:

- capped exponential backoff that never gives up;
- the backoff resets after a stable run;
- a restart ends no app run and keeps the agent's token.

The default numbers are 10 s to start, doubling, capped at 300 s, and reset after 10 minutes `available`.

| Backend | Who restarts the agent |
| --- | --- |
| docker | The runner, with the default numbers. It replaces the agent container alone. |
| host runner | The runner, with the default numbers. It restarts the agent process alone. |
| k8s | The kubelet: the agent pod's `restartPolicy: Always`, its crash-loop backoff and its image-pull backoff. The contract does not promise exact numbers here, because a cluster can tune the kubelet. |

Exactly one layer retries. No runner-driven restart is added on k8s, because the kubelet already redoes the work.

There are two other ways to restart the agent at once:
- `PUT /v1/sessions/:id/agent` with the same name, which Studio offers as **Retry agent**;
- a resume, which creates a new workload and so a new agent.

### Readiness

The session never waits for its agent:

1. Bring-up reports `running` once the workspace and the app slots are up, with `agentStatus.state: starting`.
2. Core opens a TCP connection to the agent's port, from the host the backend names:
   - docker: the agent container's address on the child network;
   - k8s: the agent pod's IP;
   - host runner: loopback.
3. The agent becomes `available`, and `agent` is published, only once that connection succeeds after each start.
4. If the agent is still running but not listening after 60 s, it is reported `unavailable`, with a reason naming the port. Probing continues, so an agent that starts listening later still becomes `available`.
5. Probing stops after the first success of each start. From then on, only the agent ending moves the state.

Every change of agent state re-emits a `running` status. It does not re-arm app relays and does not re-report app states.

### What the reason says

`reason` is written by the runner. It says what happened, and names where the operator reads the agent's output:
- docker: the container `telo-run-<sessionId>-agent`;
- k8s: the agent pod `telo-session-<id>-agent`;
- host runner: `agent/agent.log` in the session directory.

`ended` carries the exit code and signal.

Neither field ever carries the agent's own output, the kubelet's `terminated.message` included. The agent holds the operator's credentials, and no redaction catches a secret printed encoded or derived. That leaves the path to the output as the actionable part.

The runner also logs every agent ending at warn level, with the session id and the same facts.

### Compatibility across versions

Studio and runners release independently: the web Studio talks to user-hosted runners of any version. So the change is additive.

- `agent` keeps its shape and meaning: the endpoint, present while the agent can be reached.
- A client that does not know `agentStatus` ignores it, and keeps working against a new runner exactly as today.
- A new Studio reads `agentStatus` when it is present. When it is absent and the session names an agent, the runner is older, and Studio falls back to the generic sentence and still offers **Retry agent**.
- No `features` entry is added. A status is one stored snapshot per session, replayed to every subscriber, so no single client's version can shape it.

### Docker

- A failed pull, create or start of the agent during bring-up no longer aborts the bring-up.
- The agent container's ending no longer reaches the session's failure path.
- At adoption, an agent container that has already ended is adopted and restarted, rather than making adoption throw.
- An agent change replaces only the agent container and ends no app run.

### k8s

- **The agent runs in its own pod.** It is owned by the session pod, so the cluster deletes it with the session pod. A required pod-affinity rule on the node hostname holds it to the session pod's node, and its `restartPolicy` is `Always`.
  - Rejected, a native sidecar: the kubelet starts regular containers only after a sidecar has started, so an unpullable agent image would block the apps.
  - Rejected, a pod-level `restartPolicy: Always`: a crash-looping agent makes the pod not Ready, which takes the apps' own ports out of the session Service.
  - Rejected, recreating the pod to restart the agent: every crash would end every run.
- **Routing.** The agent gets its own Service, `telo-session-<id>-agent`, and its own host, `<port>-<sessionId>-agent.<base>`.
  - Both are owned by the session pod, so replacing the agent keeps its address.
  - The agent pod never carries `telo.run/session-id`, which the session Service selects on.
  - The session NetworkPolicies extend to the agent pod by its labels: ingress from the runner's namespace and the routing data plane, and the agent's own egress.
  - The operator's credentials leave the network namespace that runs user code.
- **Storage.** The session claim stays `ReadWriteOnce`, and the affinity rule keeps both pods on the node that mounts it.
  - Only the agent pod mounts `agent/`, so the agent's state has one writer. Both pods mount the workspace.
  - The agent pod is created after the session pod has started, so `agent/` already exists.
  - Every replacement deletes the old agent pod and waits until it is gone before creating the next. That covers an agent change, a session pod replacement and a suspend.
  - An agent pod that cannot be scheduled on that node is `unavailable` with that reason, and the apps run.
- **Adoption.** The agent's token moves into the agent pod's spec, and adoption reads it back from there.
  - The session pod is adopted first.
  - An agent pod that is missing, has ended, is not the stored agent, or is owned by another session pod is replaced, with a fresh token from core.
  - Any other agent pod is adopted as it is.
  - The agent pod never makes adoption throw or suspend the session.
- **The boot sweep** also removes an agent pod whose owner is not its session's current session pod. Ownership covers the rest.
- **The failure watch** fails the session on the session pod's required containers only. The agent pod's state feeds `agentStatus`, and a waiting reason is reported by its name only.

### Host runner

- The agent process ending no longer fails the session.
- The runner restarts the process under the default policy.
- An agent change restarts only the agent process.

### Studio

- Reads `agentStatus`:
  - `starting`: shows the agent as starting.
  - `unavailable`: shows `reason` with **Retry agent**, which sends `PUT /v1/sessions/:id/agent` with the session's current agent name.
  - `available`: connects through `agent`, as today.
- Falls back to the generic sentence only when `agentStatus` is absent.
- A send to the agent while it is unavailable fails with the reason, instead of waiting.

### Documentation

- The runner-protocol README: the `running` line under Events, the new def, the presence rule and the fallback reading.
- The runner-core guide § Co-resident agent, and its docker backend section's "a container that ends is the session's failure" sentence.
- The k8s runner guide: the pod, the claim and the supervisor, and the routing section.
- The host runner guide.
- Studio's guide § Agent.

Release fragments name each unit:
- `packages/runner-protocol`
- `packages/runner-core`
- `apps/docker-runner`
- `apps/k8s-runner`
- `apps/host-runner`
- `apps/studio`

## Verify

- **Docker dev stack, with the agent module that cannot load:**
  - the session reaches `running`;
  - `my-web` runs and is reachable at its host;
  - `agentStatus` is `unavailable`, its `reason` naming `telo-run-<sessionId>-agent`, and Studio shows that reason with Retry agent;
  - no `PUT …/apps` loop shows in the runner log.
- **Agent killed during a live run, on each backend:** the run continues, the session stays `running`, `agent` disappears, and `agentStatus.state` is `unavailable`.
- **Workspace container killed:** the session goes `failed`, as today.
- **Agent that exits on every start:**
  - `restarts` climbs at about 10, 20, 40 … 300 s, without end;
  - no run ends;
  - Retry agent restarts it at once and resets the backoff;
  - after a resume, the agent is tried again.
- **Agent declared on the wrong port:**
  - the session runs;
  - `agentStatus` shows `starting`, then at 60 s `unavailable` naming the port;
  - an agent that starts listening at 90 s becomes `available` with no restart.
- **Agent that prints its environment and exits:** `reason` contains none of that output on all three backends.
- **k8s:**
  - with an unpullable agent image, an app can be Run and reached at its host;
  - deleting the agent pod brings the agent back without touching the session pod;
  - during every replacement, `agent/` is never mounted by two pods at once;
  - after a runner restart, a live session keeps its agent and its token.
- **Schema:** every `running` status a new runner serves passes the protocol schema, including the rule that `agent` is present exactly when the state is `available`.
- **Cross-version:**
  - today's Studio, unchanged, connects to a new runner's agent;
  - a new Studio against an old runner shows the generic sentence and a working Retry agent.
