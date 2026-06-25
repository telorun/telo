# @telorun/k8s-runner

HTTP service that runs Telo Applications as sandboxed **Kubernetes Pods**. A
backend over [`@telorun/runner-core`](../../packages/runner-core), sibling to
[`docker-runner`](../docker-runner) — it presents the identical `/v1` session
contract (`/v1/health`, `/v1/capabilities`, `/v1/probe`, `/v1/sessions`,
`/v1/sessions/:id/events` SSE, `/v1/sessions/:id/io` WS) but spawns a Pod per
session instead of a container. On `/v1/capabilities` it advertises `image` /
`pullPolicy` as **`readOnly`** (server-enforced — the runner serves untrusted
code under a hard-ceiling policy), so the editor lets the user edit only the
runner URL.

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

Per session the runner resolves the image, creates a Pod (`telo run`), watches it
for status, attaches a PTY over the Pod `attach` subresource for the interactive
`/io` channel, and — when an ingress base domain is configured — creates a
per-session Service + Ingress (`<sessionId>.<base-domain>`) garbage-collected via
an ownerReference to the Pod.

**Every session runs a prebuilt per-app image** — there is no in-pod install
path. On a session-create the runner stages the bundle plus a generated
`Dockerfile` (`FROM <base>`, `ENV TELO_CACHE_DIR=/telo-cache`, `RUN telo install`),
runs a trusted **Kaniko** Job in the `telo-builds` namespace that bakes every
controller and module manifest into `/telo-cache/{manifests,npm}` and pushes the
result, then runs the session pod from that image — so the session never installs
anything on the start path and a slow/unreachable package registry can't stall it.

**The image is keyed on the dependency closure, not the whole bundle** — the
`imports:` set plus any controllers declared by inline `Telo.Definition` docs
(see `extractDependencyKey`). A body-only edit (resource config, CEL) reuses the
existing image; only an import or controller change rebuilds. The per-session
**body is delivered at boot**, not baked: a body-fetch initContainer untars the
staged bundle into a writable `/app` emptyDir, and the session runs `telo run
/app/<entry> --no-cache-write` — reading the baked deps from the read-only
`/telo-cache` and validating in-memory, so `readOnlyRootFilesystem` stays on with
nothing written to the cache. Builds are existence-checked before building and
single-flighted; a build failure surfaces as an actionable error carrying the
build pod's log tail. `RUNNER_IMAGE_REPOSITORY` is therefore **required** — the
runner refuses to start without a registry to build into.

**Coming-up progress** is reported over the `/v1` SSE stream as `progress` events
(`build` → `provision`) while the session is still `starting`. The session is
created with a fast `201` carrying the `streamUrl` **before** the build runs, so
the client connects immediately and sees build + provision progress live; the
backend then runs in the background and a start failure surfaces as a terminal
`failed` status on the stream. The session flips to `running` when the Pod reaches
`Running`.

Sandbox hardening is always on (non-root, read-only rootfs, drop-all caps, no
service-account token, seccomp `RuntimeDefault`); a sandbox RuntimeClass
(gVisor/Kata) is layered on when configured. In the prebuilt path the per-app
image is single-tenant, so install scripts run normally inside the trusted build
(native/postinstall controllers work) with no cross-tenant cache to poison.

## Configuration (env)

| Env | Default | Purpose |
| --- | --- | --- |
| `RUNNER_SELF_URL` | _(required)_ | Runner's in-cluster base URL (bundle fetch) |
| `PORT` | `8062` | HTTP listen port |
| `RUNNER_SESSION_NAMESPACE` | `telo-sessions` | Namespace for session objects |
| `RUNNER_IMAGE` | `telorun/node:latest-slim` | Default base image; always offered in the picker and the fallback when the catalog is unreachable |
| `RUNNER_INIT_IMAGE` | `busybox:stable` | Build-context fetch initContainer image (wget + tar) |
| `RUNNER_RUNTIME_CLASS` | _(unset → runc)_ | Sandbox RuntimeClass (gvisor/kata) |
| `SESSION_INGRESS_BASE_DOMAIN` | _(unset → logs-only)_ | Wildcard base for per-session ingress |
| `SESSION_INGRESS_TLS_SECRET` | _(unset → no TLS block)_ | `kubernetes.io/tls` Secret (in `telo-sessions`) the session Ingress presents; must cover `*.<base-domain>`. Set for Cloudflare Full (Strict) / any origin-cert upstream |
| `RUNNER_MAX_CPU` | `50m` | CPU ceiling |
| `RUNNER_MAX_MEMORY` | `100Mi` | Memory ceiling |
| `RUNNER_MAX_TTL_SECONDS` | `3600` | Wall-clock TTL (Pod `activeDeadlineSeconds`) |
| `RUNNER_MAX_EPHEMERAL_STORAGE` | `512Mi` | Per-Pod ephemeral-storage ceiling |
| `RUNNER_MAX_SESSIONS` | `32` | Global session backstop; at capacity the oldest exited session is evicted before a new run is rejected |
| `RUNNER_EXIT_TTL_MS` | `14400000` | How long exited sessions stay in the registry (so the editor can re-attach and replay their history after a reload) before eviction |
| `RUNNER_TERMS_FILE` | _(unset)_ | Path to the agreement file (plain text / markdown), read at startup — mount it from a `ConfigMap` (e.g. `/etc/telo/terms.md`). Setting this (or `RUNNER_TERMS_BODY`) enables terms: the runner advertises them on `/v1/capabilities` and rejects `POST /v1/sessions` with `428` unless the client sends `x-telo-accepted-terms` matching the version. An unreadable path fails startup. The public cloud should set this |
| `RUNNER_TERMS_BODY` | _(unset)_ | Inline agreement text, for short notes; ignored when `RUNNER_TERMS_FILE` is set |
| `RUNNER_TERMS_TITLE` | `Usage agreement` | Heading shown above the agreement |
| `RUNNER_TERMS_VERSION` | _(hash of body)_ | Acceptance version; defaults to a content hash so any edit to the body automatically re-prompts every client. Set explicitly only to control material-change vs typo |

### Base-image picker

The runner advertises a menu of base images on `/v1/capabilities`, resolved from
a Docker Hub repo's tags (filtered) and cached. The editor renders it as an
editable `image` dropdown; the chosen image is **re-validated server-side**
against the same list, so a client that skips the editor can't widen the set.
`RUNNER_IMAGE` is always offered and is the fallback when Docker Hub is
unreachable. Disable the catalog to lock `image` to `RUNNER_IMAGE`.

Pinned tags (e.g. `0.30.1-slim`) are immutable. A picked **moving** tag like
`latest-slim` only refreshes when the session's `pullPolicy` is `always`: the
build then pins the per-app image to the base's current digest, so a moved tag
yields a new image and rebuilds (otherwise the cached build — keyed on the tag
string — is reused). Movement detection reads the digest from Docker Hub, so a
base hosted elsewhere (GHCR, a private registry) can't be tracked — `always`
degrades to reusing the cached build for it, same as `missing` / `never`.

| Env | Default | Purpose |
| --- | --- | --- |
| `RUNNER_BASE_IMAGE_CATALOG_ENABLED` | `true` | Resolve + advertise the picker; `false` locks `image` to `RUNNER_IMAGE` |
| `RUNNER_BASE_IMAGE_REPO` | `telorun/node` | `namespace/repository` queried on Docker Hub |
| `RUNNER_BASE_IMAGE_PINNED_ONLY` | `true` | Keep only pinned `MAJOR.MINOR.PATCH[-variant]` tags (drops `latest`, `0`, `0.30`) |
| `RUNNER_BASE_IMAGE_EXCLUDE_SHA` | `true` | Drop commit-hash tags |
| `RUNNER_BASE_IMAGE_EXCLUDE_PRERELEASE` | `true` | Drop semver prereleases (`-rc.1`, `-alpha`); `-slim` / `-rust-*` variants are kept |
| `RUNNER_BASE_IMAGE_INCLUDE` | _(unset)_ | Regex a tag must match (escape hatch) |
| `RUNNER_BASE_IMAGE_EXCLUDE` | _(unset)_ | Regex that drops a matching tag (escape hatch) |
| `RUNNER_BASE_IMAGE_LIMIT` | `20` | Cap on advertised tags (newest first) |
| `RUNNER_BASE_IMAGE_REFRESH_SECONDS` | `3600` | Catalog re-fetch cadence |

### Image build (required)

| Env | Default | Purpose |
| --- | --- | --- |
| `RUNNER_IMAGE_REPOSITORY` | _(required)_ | Registry repo for per-app images; tag = bundle hash |
| `RUNNER_BUILD_NAMESPACE` | `telo-builds` | Namespace the trusted Kaniko build Jobs run in |
| `RUNNER_BUILDER_IMAGE` | `gcr.io/kaniko-project/executor:latest` | Image builder |
| `RUNNER_BUILD_TIMEOUT_SECONDS` | `600` | Build Job deadline / wait budget |
| `RUNNER_REGISTRY_INSECURE` | `false` | Push/pull over HTTP / self-signed |
| `RUNNER_REGISTRY_API_URL` | _(unset → always build)_ | HTTP(S) base for the manifest existence check (authenticated via the push Secret) |
| `RUNNER_REGISTRY_PUSH_SECRET` | _(unset)_ | dockerconfig Secret (in `telo-builds`) Kaniko pushes with; also authenticates the existence check |
| `RUNNER_IMAGE_PULL_SECRET` | _(unset)_ | dockerconfig Secret (in `telo-sessions`) the kubelet pulls per-app images with |
| `TELO_REGISTRY_URL` | `https://registry.telo.run` | Telo module registry used by `telo install` |

## Deploy (Helm)

The runner **requires a registry to build into** (there is no in-pod install
fallback), so point it at one your cluster's kubelet can pull from:

```bash
helm install telo-runner ./chart \
  --set build.repository=registry.example.com/telo-sessions \
  --set-file registry.dockerconfigjson=./dockerconfig.json \  # private-registry auth
  --set session.runtimeClass=gvisor
```

For a private registry, `registry.dockerconfigjson` creates the dockerconfig
Secret in **both** namespaces (push in `telo-builds`, pull in `telo-sessions`) and
wires `RUNNER_REGISTRY_PUSH_SECRET` + `RUNNER_IMAGE_PULL_SECRET` — the kubelet
needs the pull copy because the per-app image is private. (Or manage the Secrets
yourself and reference them via `build.pushSecretName` / `build.pullSecretName`.)
The push Secret doubles as the credential for the manifest existence check, so
the runner can see an already-built image in a private registry and skip the
rebuild — without it a private registry answers `401` and every run rebuilds.
A no-auth registry needs none of this.

The chart provisions the static scaffolding: the runner Deployment (single
replica — the registry is in-memory and the runner reaps orphaned pods on boot),
Service, scoped RBAC, the `telo-runner` / restricted-PSS `telo-sessions` /
baseline-PSS `telo-builds` namespaces, a `ResourceQuota`, and NetworkPolicies
(session pod-to-pod isolation + the build namespace's registry egress). The
runner creates per-session and per-build objects at runtime.

The optional in-cluster registry (`--set registry.enabled=true --set
build.insecureRegistry=true`) derives `build.repository` for you, but works only
on clusters whose **nodes are configured to trust it** — otherwise an external/
cloud registry is simpler. Installing with neither a `build.repository` nor
`registry.enabled` is rejected at template time.

### Origin TLS (Cloudflare et al.)

To have the per-session Ingress present an origin cert (so an upstream like
Cloudflare in **Full (Strict)** mode validates the origin), give the chart a
`kubernetes.io/tls` Secret in `telo-sessions`. The cert must cover the wildcard
`*.<sessionIngress.baseDomain>` — session hosts are a single label
(`<port>-<sessionId>.<base-domain>`). Two ways:

```bash
# A — reference a Secret you manage in telo-sessions (cert-manager, your own sync)
helm install telo-runner ./chart --set sessionIngress.tls.secretName=telo-origin-tls

# B — let the chart create the Secret from your cert + key
helm install telo-runner ./chart \
  --set-file sessionIngress.tls.cert=origin.pem \
  --set-file sessionIngress.tls.key=origin.key
```

Either wires `SESSION_INGRESS_TLS_SECRET`, and the runner stamps a `spec.tls`
block on every session Ingress. Leave all three empty to skip TLS at the origin
(terminated entirely upstream).

> **Egress notes.** (1) The kubelet pulls session images directly and does **not**
> use cluster DNS, so the in-cluster registry only works where nodes trust it
> (e.g. containerd `registries.conf`). (2) Core NetworkPolicy is CIDR-only and
> cannot express the package-registry FQDN allowlist the build namespace needs —
> use a CNI with FQDN policy (Cilium) or an egress proxy to tighten it.

## Development

```bash
pnpm --filter @telorun/k8s-runner build   # tsc
pnpm --filter @telorun/k8s-runner test    # vitest (limits clamp, tar, bundle token)
```

The Kubernetes backend can't be exercised without a cluster; unit tests cover the
backend-independent logic (limit clamping, the tar writer, bundle tokens).
