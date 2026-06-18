# @telorun/k8s-runner

## 0.5.1

### Patch Changes

- @telorun/runner-core@0.5.1

## 0.5.0

### Minor Changes

- bc2eeff: k8s-runner: per-session Ingress now exposes every tcp port under its own host `<port>-<sessionId>.<domain>` (one Ingress rule per port), matching the docker runner's proxy scheme — previously only the first port was routed. The port rides as a leading label, so each host stays a single label under the base domain and remains compatible with a single-label wildcard cert. Announced endpoints carry a `url` for each tcp port; udp ports stay host-less.

### Patch Changes

- Updated dependencies [bc2eeff]
  - @telorun/runner-core@0.5.0

## 0.4.0

### Minor Changes

- 2558e41: k8s-runner: add a base-image picker resolved from a filtered Docker Hub tag catalog and validated server-side, and make `pullPolicy` a live base-image freshness control — `always` digest-pins the build so a moved moving-tag (e.g. `latest-slim`) rebuilds. Adds a generic `BaseImageCatalog` + `resolveTagDigest` and a `validateConfig` server hook to runner-core.

### Patch Changes

- Updated dependencies [2558e41]
  - @telorun/runner-core@0.4.0

## 0.3.0

### Minor Changes

- 8133912: Add operator-defined, server-enforced usage terms. A runner advertises `terms` on `/v1/capabilities` (sourced from `RUNNER_TERMS_FILE` or inline `RUNNER_TERMS_BODY`, with the version defaulting to a content hash) and rejects `POST /v1/sessions` with `428 terms_required` unless the client sends the `x-telo-accepted-terms` header matching the current version. runner-core gains `loadTermsFromEnv`, the `RunnerTerms` type, the `ACCEPTED_TERMS_HEADER` constant, and the `terms` capability field. docker-runner reads terms from the environment (off by default); k8s-runner wires them through the Helm chart via a terms ConfigMap.

### Patch Changes

- Updated dependencies [8133912]
- Updated dependencies [8133912]
  - @telorun/runner-core@0.3.0

## 0.2.1

### Patch Changes

- @telorun/runner-core@0.2.1

## 0.2.0

### Minor Changes

- e6e8d88: Unify the docker and kubernetes runners behind a `/v1/capabilities` discovery
  endpoint. Runners advertise their own editable config schema; the editor
  collapses the docker-api and k8s adapters into a single capability-driven
  http-runner adapter with managed add/edit/remove/switch runners, and preflights
  required variables/secrets before a run.

### Patch Changes

- Updated dependencies [e6e8d88]
  - @telorun/runner-core@0.2.0

## 0.1.0

### Minor Changes

- 3dc20d0: Add a Kubernetes runner. Extract backend-neutral `@telorun/runner-core` from docker-runner (shared `/v1` contract, routes, registry, SSE, ring buffers) behind a `RunnerBackend` seam; docker-runner becomes a thin backend over it with no behaviour change. Add `@telorun/k8s-runner`, a `KubernetesBackend` that runs Telo apps as sandboxed Pods (attach-based PTY, hard-ceiling limit clamping, tokenized bundle delivery, per-session ingress, orphan reaping) plus a Helm chart (RBAC, quota, NetworkPolicy) and a CI image job. Add a k8s editor `RunAdapter` via a shared `createHttpRunnerAdapter` factory. Rename the docker image `telorun/telo-runner` → `telorun/docker-runner`.

### Patch Changes

- Updated dependencies [3dc20d0]
  - @telorun/runner-core@0.1.0
