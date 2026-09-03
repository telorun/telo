---
"@telorun/k8s-runner": minor
"@telorun/runner-core": minor
---

k8s-runner no longer builds a per-app image. A run session runs the plain kernel
image, takes its body over the existing bundle initContainer, and resolves its
own module closure into a `/telo-cache` emptyDir at boot — the shape a watch
session already had. The on-cluster Kaniko path, the `telo-builds` namespace and
everything that fed them are gone.

**Breaking, and it needs a `helm upgrade` to clear.** `RUNNER_IMAGE_REPOSITORY`
is no longer read and is no longer required (the runner used to refuse to start
without it), along with `RUNNER_BUILD_NAMESPACE`, `RUNNER_BUILDER_IMAGE`,
`RUNNER_BUILD_TIMEOUT_SECONDS`, `RUNNER_REGISTRY_INSECURE`,
`RUNNER_REGISTRY_API_URL` and `RUNNER_REGISTRY_PUSH_SECRET`.
`RUNNER_IMAGE_PULL_SECRET` stays — it is now the kubelet's credential for the
kernel image and any operator catalog image in a private registry, and the chart
takes it from `session.imagePullSecret`. The chart drops its whole `build:` and
`registry:` blocks (including the optional in-cluster `registry:2`), the
`telo-builds` namespace and its Role/RoleBinding, and the build-egress
NetworkPolicy; an upgrade removes those objects, and a `telo-builds` deleted by
hand no longer breaks anything. `pullPolicy` now means the Pod's own
`imagePullPolicy` rather than base-image-freshness for a rebuild.

`RunPhase` keeps `build`, though nothing in this repo emits it any more: it is
the vocabulary a *backend* reports in, and a client is still talking to whatever
runner is on the other end of the stream. `extractDependencyKey` /
`DependencyKey` and `resolveTagDigest` are removed from `@telorun/runner-core` —
the build was their only consumer.

**The cost is start latency**: a run session's cache dies with its pod, so it
re-downloads its closure on every start, where the build used to put it on disk
ahead of boot. A watch session pays it once per pod and is the shape to reach for
when that matters.

**Run-session ceilings move with the work**: 50m / 100Mi / 512Mi described a pod
that only RAN a prebuilt image, with the closure in image layers, which are not
charged to ephemeral-storage. The pod now downloads, unpacks and resolves the
closure into an emptyDir, which is — so those numbers meant an OOMKill on memory
and an eviction on storage for an ordinary session. `RUNNER_MAX_CPU` /
`RUNNER_MAX_MEMORY` / `RUNNER_MAX_EPHEMERAL_STORAGE` now default to 500m / 512Mi
/ 1Gi, the tier the watch path already ran this same workload under. **The
chart's `resourceQuota` moves with them**: its old 4 CPU / 8Gi was exactly 32
pods at the old ceilings, so leaving it would have capped concurrency at four —
as a 403 the client sees — while `runner.maxSessions` still said 32. It is now
32 x the per-pod ceiling, and the arithmetic is written down beside it.
