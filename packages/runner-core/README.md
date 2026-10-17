# @telorun/runner-core

Backend-neutral core shared by the Telo runners: [`docker-runner`](../../apps/docker-runner),
[`k8s-runner`](../../apps/k8s-runner) and `telo runner`, the local-process
runner the CLI serves. It owns everything about a run *except* how the workload
is actually spawned:

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
seeds through the workspace container's own routes; the local runner writes a
directory it holds itself), so `start` receives the raw `bundle` rather than a
pre-resolved path. `buildServer({ backend, config, version })` wires a backend
into the full `/v1` app; pass `logStream` when the host's stdout is not the
runner's to write, as it is not inside a CLI.

## The session config belongs to the runner

`SessionConfig` is an opaque bag. It used to declare `image` and `pullPolicy`,
which is container vocabulary — invisible only while every backend ran
containers, and wrong for one that runs local processes. A runner describes its
own editable fields through `config.schema` on `/v1/capabilities`, which is what
the editor renders the form from, and enforces the same through `validateConfig`
against a client that skipped the editor. The container backends narrow the bag
with `containerConfig` / `validateContainerConfig`, which live here because both
of them need exactly the same two fields.

A narrowed `corsOrigins` is enforced by the runner too, not just handed to the
browser: a request carrying an origin the runner does not serve is refused
(`403 origin_not_allowed`), because CORS only governs what a browser hands back
to a page. A request with no origin is left alone — every CLI and health check
sends none — while the byte channel refuses a missing one, since a browser
always sends it on an upgrade.

`features.io` is enforced the same way: the modes a runner advertises are the
modes its session route accepts, an app that declares none gets the first, and
an explicit mode the runner does not serve is refused with `io_unsupported`
rather than downgraded — `isatty()` is observable to the application.

## Workload tokens

A `RUNNER_APPS` entry may declare `tokenEnv`. For every session started from it
— an app session, or a watch session's co-resident agent — core mints a token
(the session-id generator at 32 characters), injects it into that workload's
env under `tokenEnv` (the app session's env, or the agent's operator env, so no
other container sees it), and reports it as `RunnerEndpoint.token` on the
workload's endpoints: `status.agent` for an agent, every `status.endpoints[]`
entry for an app session. The token is carried on the retained launch, so a
resumed session keeps it; a runner restart forgets every session, so it means a
new token. A `tokenEnv` the entry's own `env` also sets is a `RunnerConfigError`
at catalog load, and a client-supplied env var of that name is dropped. Core
reports it, not the backend, so no backend can publish an endpoint without the
token its workload holds.

## Session containers

With `RUNNER_SESSION_CONTAINERS=true` a runner serves every session a container
engine of its own, so a test that starts the database it needs
(`Container.Instance` over `Docker.Engine`) runs in a session unchanged:

| Setting | Meaning |
| --- | --- |
| `RUNNER_SESSION_CONTAINERS` | `true` to serve the engine; default `false`, and a session then gets nothing. |
| `RUNNER_SESSION_CONTAINERS_MAX` | Most containers one session may hold at once (default `4`); a create beyond it is `429`. |
| `RUNNER_INTERNAL_URL` | The runner's base URL as a session's workload reaches it (`http://runner:8061`). Required when the engine is on — the runner refuses to boot without it. |

Each session's env gets `TELO_HOST_CONTAINER_ENGINE_URL`
(`<RUNNER_INTERNAL_URL>/v1/sessions/<id>/engine`) and
`TELO_HOST_CONTAINER_ENGINE_TOKEN`, a token minted for that session. The engine
answers the Docker Engine API 1.41 requests `Docker.Engine` sends, at
`/v1/sessions/:id/engine/v1.41/…`, and refuses every other one:

- a request without the token is `401`, with another session's `403`;
- a create body may carry `Image`, `Cmd`, `Entrypoint`, `Env`, `User`,
  `ExposedPorts`, `Labels`, and `HostConfig.PortBindings` only as one
  `{ "HostIp": "127.0.0.1", "HostPort": "" }` per exposed port; anything else is
  a `400` naming the field (`HostConfig.Privileged`,
  `HostConfig.PortBindings.5432/tcp[0].HostPort`);
- every container is labelled `run.telo.session=<id>`, and inspect, logs, delete
  and list see only the session's own;
- nothing is published on a host: inspect answers each requested binding with
  the address the session reaches the container at and the container port;
- a session's containers are removed when it stops, suspends, reaches its
  deadline or is deleted, when its app set changes, and when the runner shuts
  down; each backend's boot sweep removes what a killed runner left.

A backend implements `RunnerBackend.containers` (`SessionContainerEngine`); a
runner turning the setting on over a backend without one refuses to boot.

## Public addresses — the host contract

An application declares every address it is reached at as a need —
`Telo.PublicUrl` for one address, `Telo.PublicHostPattern` for a family of
tenant hosts — each naming a port, and its `Http.Server` mounts route by them.
Whoever runs it is the **host** of those addresses: a runner, Telo Cloud, any
other platform. This is what every host does, stated once.

**Report mode** — the host supplies every address need itself:

1. It reads `telo needs report -o json`: each address need's type, its
   `parameters` (`port`, `primary`, `customDomains`) and the variable its field
   is read from. Nothing else about the application.
2. It gives each `Telo.PublicUrl` a URL colliding with no other, routes its host
   to the port and sets `url`; `primary` marks the need it gives its main
   address. How it names addresses is its own choice.
3. It gives each `Telo.PublicHostPattern` a pattern (`https://*.t.example` or
   `https://*-t.example`) colliding with no other, routes every matching host to
   the port and sets `pattern`.
4. It may route further domains, exact or `*.` wildcards, to the port of a
   `customDomains` need, supplying nothing for them.

**Template mode** — the host states its naming and the kernel derives each
address:

1. It sets `TELO_HOST_PUBLIC_URL_TEMPLATE`, and
   `TELO_HOST_PUBLIC_URL_SECONDARY_TEMPLATE` (holding `{label}`) when it can
   serve several addresses on one port. It reads nothing before boot.
2. It routes each host a port's `publicUrls` on `Kernel.PortsResolved` names to
   that port, again on every load. Core carries them on
   `PortMapping.publicHosts`.
3. It answers `Telo.PublicUrl` only, so it is a partial host: a pattern or a
   `customDomains` need comes from the session's env, whose author acts as its
   host.

**In both modes** the host routes without changing the request — the path
unchanged, `Host` as the client sent it — and never routes one hostname and port
to two ports; it supplies origins (a `url` is an origin, a `pattern` a pattern
origin); it owns TLS, certificates and DNS, so the application holds no
certificate and learns of a domain only through a fulfilment; it may redirect a
domain instead of routing it; and it leaves unsupplied any need it cannot serve,
which the kernel refuses as `ERR_NEED_UNMET`, naming the variable.

**A set of host values serves exactly one root application.** A host running
several applications gives each its own, and a child an application starts with
`App.Instance` inherits none of them. The derivation rules are in the guide
*Providing needs*; the routing an application declares in `http-server`'s
host-routing doc.

Which mode each runner is: the k8s runner is a template-mode host on a routed
session; the docker runner and the local-process runner set no template, so
every address need comes from the session's env.

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
