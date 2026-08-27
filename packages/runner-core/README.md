# @telorun/runner-core

Backend-neutral core shared by the Telo runners ([`docker-runner`](../../apps/docker-runner)
and [`k8s-runner`](../../apps/k8s-runner)). It owns everything about a run
*except* how the workload is actually spawned:

- the `/v1` HTTP+SSE **session contract** and Fastify routes (`/v1/health`,
  `/v1/probe`, `/v1/sessions`, `/v1/sessions/:id/events` SSE,
  `/v1/sessions/:id/io` WebSocket PTY);
- the in-memory **session registry**, event/byte **ring buffers** (SSE + PTY
  replay with gap detection), and bundle-path traversal guards;
- the **run projection** — per-app run outcomes derived from the kernel
  lifecycle events already on the debug stream, so the runner never parses a
  terminal to learn how a run ended;
- the **watch supervisor** — the workspace checkpoint timer and the idle reaper;
- the **workspace application** (`workspace-app/telo.yaml`), the manifest a watch
  session's `workspace` container runs. It lives here because the workspace
  surface is part of the `/v1` contract: both backends mount the same bytes, and
  a copy per backend would be two manifests to hold in agreement;
- graceful-shutdown helpers and base config parsing.

## The seam: `RunnerBackend`

Concrete runners implement a small abstract interface — a byte-stream out
(`onOutput`), a stdin writer, a resize signal, and a wait/exit (`done`) — *not*
any docker- or k8s-specific stream shape:

```ts
interface RunnerBackend {
  probe(config): Promise<AvailabilityReport>;
  start(spec): Promise<BackendSession>; // writeStdin / resize / done / stop
  reapOrphans?(): Promise<void>;
}
```

Every callback is qualified by the application it belongs to. A session runs one
container per application — usually exactly one — and each has its own terminal,
so the byte channel is keyed `(session, app)` rather than labelled on a merged
stream. A single-app session carries the qualifier too, so no client needs two
readings.

A watch session's `BackendSession` additionally exposes `workspace`, `reload`,
`setApps` and `suspend`: it is a workspace that runs continuously rather than one
run, so its lifetime outlives every run inside it.

Bundle delivery is the backend's responsibility (docker writes a shared-volume
workdir; k8s stages a tarball for an initContainer fetch, and a watch session
seeds through the workspace container's own routes), so `start` receives the raw
`bundle` rather than a pre-resolved path. `buildServer({ backend, config,
version })` wires a backend into the full `/v1` app.

## Two nouns, one stream

`status` is the SESSION's state; `run` is one application's outcome. They are
separate because a session can outlive its runs: a one-shot Runnable finishing in
a watch session emits `run` with `phase: "completed"` and leaves `status:
running`, so the next edit starts that app's next generation.

Workload output travels neither — it goes over the byte channel (`/io`), which
exists precisely because per-chunk events are wasteful for high-volume output.
The `stdout` / `stderr` `RunEvent` variants that used to be declared here were
emitted by nothing; they are gone rather than qualified.

## Development

```bash
pnpm --filter @telorun/runner-core build
pnpm --filter @telorun/runner-core test
```
