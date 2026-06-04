# @telorun/k8s-runner

HTTP service that runs Telo Applications as sandboxed **Kubernetes Pods**. A
backend over [`@telorun/runner-core`](../../packages/runner-core), sibling to
[`docker-runner`](../docker-runner) — it presents the identical `/v1` session
contract (`/v1/health`, `/v1/probe`, `/v1/sessions`, `/v1/sessions/:id/events`
SSE, `/v1/sessions/:id/io` WS) but spawns a Pod per session instead of a
container.

## ⚠️ Security posture

The runner is a **dumb executor**: no auth, no per-IP concurrency, no rate
limiting — only a global `RUNNER_MAX_SESSIONS` backstop. **Do not expose it
directly to anonymous internet traffic.** Front it with the Telo Cloud control
plane (or an equivalent abuse-control proxy), which resolves identity → tier →
limits and forwards to the runner. Standalone, it is safe only on a
trusted/internal network.

Resource limits are **hard ceilings**: a request may ask for *less* than the
configured cap but never more (`min(requested, ceiling)`). For a bare runner
serving an anonymous tier, the ceiling *is* the policy.

## How it works

Per session the runner: stages the bundle as a tokenized in-memory tarball;
creates a Pod (`telorun/node` running `telo run`) whose initContainer fetches
the bundle into a shared `emptyDir`; watches the Pod for status; attaches a PTY
over the Pod `attach` subresource for the interactive `/io` channel; and, when an
ingress base domain is configured, creates a per-session Service + Ingress
(`<sessionId>.<base-domain>`) garbage-collected via an ownerReference to the Pod.

Sandbox hardening is always on (non-root, read-only rootfs, drop-all caps, no
service-account token, seccomp `RuntimeDefault`); a sandbox RuntimeClass
(gVisor/Kata) is layered on when configured. Dependency caching is currently
**per-session** (an `emptyDir` at `/telo-cache`); `RUNNER_CACHE_ROOT` is reserved
for a future shared cache fed by a trusted build path (a writable shared cache
across tenants would be a poisoning channel).

## Configuration (env)

| Env | Default | Purpose |
| --- | --- | --- |
| `RUNNER_SELF_URL` | _(required)_ | Runner's in-cluster base URL (bundle fetch) |
| `PORT` | `8062` | HTTP listen port |
| `RUNNER_SESSION_NAMESPACE` | `telo-sessions` | Namespace for session objects |
| `RUNNER_IMAGE` | `telorun/node:latest-slim` | Image spawned per run |
| `RUNNER_INIT_IMAGE` | `busybox:stable` | Bundle-fetch initContainer image |
| `RUNNER_RUNTIME_CLASS` | _(unset → runc)_ | Sandbox RuntimeClass (gvisor/kata) |
| `RUNNER_INGRESS_BASE_DOMAIN` | _(unset → logs-only)_ | Wildcard base for per-session ingress |
| `RUNNER_CACHE_ROOT` | `/var/lib/telo-cache` | Node path for the per-node `.telo` cache |
| `RUNNER_MAX_CPU` | `50m` | CPU ceiling |
| `RUNNER_MAX_MEMORY` | `100Mi` | Memory ceiling |
| `RUNNER_MAX_TTL_SECONDS` | `3600` | Wall-clock TTL (Pod `activeDeadlineSeconds`) |
| `RUNNER_MAX_EPHEMERAL_STORAGE` | `512Mi` | Per-Pod ephemeral-storage ceiling |
| `RUNNER_MAX_SESSIONS` | `8` | Global concurrent-session backstop |

## Deploy (Helm)

```bash
helm install telo-runner ./chart \
  --set ingress.baseDomain=run.example.com \
  --set session.runtimeClass=gvisor
```

The chart provisions the static scaffolding: the runner Deployment (single
replica — the registry is in-memory and the runner reaps orphaned pods on boot),
Service, scoped RBAC, the `telo-runner` and restricted-PSS `telo-sessions`
namespaces, a `ResourceQuota`, and NetworkPolicies (pod-to-pod isolation + broad
egress with blocked CIDRs — not yet a registry allowlist). The runner creates
per-session objects at runtime.

> **Egress note.** Core NetworkPolicy is CIDR-only and cannot express the
> package-registry FQDN allowlist the trusted build path needs — use a CNI with
> FQDN policy (Cilium) or an egress proxy for that.

## Development

```bash
pnpm --filter @telorun/k8s-runner build   # tsc
pnpm --filter @telorun/k8s-runner test    # vitest (limits clamp, tar, bundle token)
```

The Kubernetes backend can't be exercised without a cluster; unit tests cover the
backend-independent logic (limit clamping, the tar writer, bundle tokens).
