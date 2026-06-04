# @telorun/runner-core

Backend-neutral core shared by the Telo runners ([`docker-runner`](../../apps/docker-runner)
and [`k8s-runner`](../../apps/k8s-runner)). It owns everything about a run
*except* how the workload is actually spawned:

- the `/v1` HTTP+SSE **session contract** and Fastify routes (`/v1/health`,
  `/v1/probe`, `/v1/sessions`, `/v1/sessions/:id/events` SSE,
  `/v1/sessions/:id/io` WebSocket PTY);
- the in-memory **session registry**, event/byte **ring buffers** (SSE + PTY
  replay with gap detection), and bundle-path traversal guards;
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

Bundle delivery is the backend's responsibility (docker writes a shared-volume
workdir; k8s stages a tarball for an initContainer fetch), so `start` receives
the raw `bundle` rather than a pre-resolved path. `buildServer({ backend, config,
version })` wires a backend into the full `/v1` app.

## Development

```bash
pnpm --filter @telorun/runner-core build
pnpm --filter @telorun/runner-core test
```
