---
sidebar_label: Running in production
slug: /deploy/production
description: Process lifecycle, signal handling and shutdown, exit codes, health checks, a Kubernetes deployment, and every environment variable the runtime reads.
---

# Running in production

Whatever hosts your manifest — systemd, Docker Compose, Kubernetes, ECS — it is
supervising one `telo <manifest>` process. This page describes how that process
behaves: when it stays up, how it stops, what it exits with, and what you can
probe and configure from outside.

## Process lifecycle

`telo ./manifest.yaml` runs four phases and then waits:

1. **Load** — parse the manifest and its imports, resolve controllers, bind
   `variables:` / `secrets:` / `ports:` from the host environment.
2. **Init** — the multi-pass loop constructs every resource in dependency order.
   `init()` performs no observable side effects.
3. **Run targets** — everything listed in `targets:` is dispatched.
4. **Wait for idle** — the process stays alive while any **hold** is
   outstanding, then tears down and exits.

A hold is what a long-lived resource takes to keep the app up. `Http.Server`
acquires one when it starts listening and releases it on teardown, which is why
an application whose target is a server stays up until it is signalled, while
one whose targets are all `Telo.Runnable` runs to completion and exits on its
own. Nothing needs to be configured for either shape — it follows from what the
manifest declares.

## Shutdown and signals

`SIGINT` and `SIGTERM` are both handled, identically:

1. The boot run is **cancelled** with reason `interrupted`. Targets that have
   not started are refused at the dispatch gate; long-lived runnables and
   in-flight invoke trees observe `ctx.cancellation` and stop early.
2. The idle wait is released even though holds are still outstanding.
3. **Teardown** cascades: child contexts first, then each resource in reverse
   order, with log sinks pinned last so anything logged during shutdown is
   still flushed. A resource whose `teardown()` throws is recorded and the
   cascade continues — one bad teardown cannot abandon the rest.
4. The process exits with the [exit code](#exit-codes) the run accumulated.

Two properties matter when you configure a supervisor:

- **There is no shutdown timeout.** Teardown runs to completion. Give the
  orchestrator a grace period longer than your slowest teardown
  (`terminationGracePeriodSeconds` on Kubernetes, `stop_grace_period` in
  Compose) or it will `SIGKILL` mid-drain.
- **The handlers fire once.** A second `SIGTERM` is not caught, so it kills the
  process immediately with Node's default behaviour. That is the intended
  escape hatch for a teardown that hangs.

Cancellation is cooperative: a controller that never checks its cancellation
token runs to its natural end. See
[Invoke cancellation](/reference/kernel/invoke-cancellation).

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The app went idle (or was signalled) and tore down cleanly. |
| `1` | Load, init, or a target run failed — the error is printed with the manifest location that caused it. Also the code a failed assertion sets. |
| _n_ | Whatever a controller passed to `ctx.requestExit(n)`. The highest requested code wins; `Assert.*` uses `1`. |

An init failure is reported by root cause, not by count: the kernel classifies
which resources actually failed and which were merely blocked behind them, so
the message names the one you have to fix. See
[Resource lifecycle](/reference/kernel/resource-lifecycle).

## Health checks

Telo has no built-in probe endpoint — a health check is a route you declare,
which is what lets it mean something specific to your app.

**Readiness is already implied by the socket.** `Http.Server` binds its port in
`run()`, after every resource has initialized. A connection is refused until
init has completed, so a TCP or HTTP probe against the port is a truthful
readiness signal with nothing extra declared.

For an HTTP probe endpoint, declare a route like any other:

```yaml
kind: Telo.Application
metadata:
  name: MyApp
  version: 1.0.0
imports:
  Http: oci://ghcr.io/telorun/http-server@<version>
  Run: oci://ghcr.io/telorun/run@<version>
targets:
  - !ref Server
ports:
  http:
    env: PORT
    default: 8080
---
kind: Http.Server
metadata:
  name: Server
port: !cel "ports.http"
mounts:
  - path: /
    mount: !ref Health
---
kind: Http.Api
metadata:
  name: Health
routes:
  - request:
      path: /healthz
      method: GET
    handler: !ref HealthValue
    returns:
      - status: 200
        content:
          application/json:
            schema:
              type: object
              properties:
                status: { type: string }
              required: [status]
            body:
              status: !cel "result.status"
---
kind: Run.Value
metadata:
  name: HealthValue
value:
  status: ok
```

A liveness probe should stay this shallow — it answers "is the process still
serving?". If you want a readiness check that also proves a dependency is
reachable, point the route's `handler:` at a resource that exercises it (a
`Sql.Query` running `SELECT 1`, for instance) and let the route's `catches:`
render a non-2xx on failure.

## Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  replicas: 3
  selector:
    matchLabels: { app: my-app }
  template:
    metadata:
      labels: { app: my-app }
    spec:
      # Longer than the slowest teardown in the manifest — there is no
      # in-process shutdown timeout to fall back on.
      terminationGracePeriodSeconds: 60
      containers:
        - name: app
          image: my-registry/my-app:1.0.0
          ports:
            - containerPort: 8080
          env:
            - name: PORT
              value: "8080"
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef: { name: my-app, key: database-url }
          readinessProbe:
            httpGet: { path: /healthz, port: 8080 }
            periodSeconds: 5
          livenessProbe:
            httpGet: { path: /healthz, port: 8080 }
            periodSeconds: 10
          resources:
            requests: { cpu: 100m, memory: 128Mi }
```

Notes specific to Telo:

- **The image should be built with a warmed cache.** `telo install` in the build
  stage puts every controller and imported manifest under `<manifest-dir>/.telo/`,
  so boot does no network I/O. See [Docker image](/deploy/docker).
- **The `.telo/` tree is read-only at run time** and identical in every replica,
  so it needs no volume and creates no shared state. Replicas are independent
  processes; nothing in the kernel coordinates between them. Coordination you
  want is declared — see the `lease`, `idempotency`, and `rate-limit` modules in
  the [standard library](/reference/standard-library).
- **Pass `--no-cache-write`** when the container filesystem is read-only. The
  run still reads the baked cache; it just never persists derived entries.
- One `telo` process is one Node.js process. Scale with replicas.

## Observability

**Logging is fully declared in the manifest** — level, sinks, redaction and
sampling. Records are structured, carry the resource that emitted them, and
carry trace and span identifiers when emitted inside a dispatch. There is no
`TELO_LOG_LEVEL`: bind a variable to your env var and reference it, so the
configuration stays visible to `telo check` and the editor. See
[Logging](/learn/logging).

Records can be shipped to an OpenTelemetry collector with the `otlp` module's
sink. **Metrics and distributed tracing are not yet exposed as a runtime
export** — the record model carries the trace context, but there is no metrics
endpoint or span exporter to point a collector at today. Plan for logs, and
scrape your own application-level counters through whatever your app already
serves.

## Runtime configuration

Everything the application itself needs is declared on `Telo.Application` as
`variables:`, `secrets:` and `ports:`, each bound to a host environment
variable — see [Application environment variables](/reference/kernel/application-env-variables)
and [Application ports](/reference/kernel/application-ports). The kernel reads
the host environment directly for exactly the following:

| Variable | Read by | Effect |
| --- | --- | --- |
| `TELO_CACHE_DIR` | run, install, check | Relocates the `.telo` cache root (default: `<manifest-dir>/.telo`). Used for the manifest cache, compiled validators, the analysis stamp, and the npm install root. |
| `TELO_REGISTRY_URL` | run, install, upgrade | Base URL of the Telo module registry. Overridden by `--registry-url`. |
| `TELO_PKG_MANAGER` | install | Package manager invoked for the controllers still delivered over npm. Defaults to `npm`. |
| `TELO_REGISTRY_TOKEN` | publish | Bearer token for the registry's publish endpoint. Build-time only — never needed by a running app. |
| `TELO_HUB_URL` | search | Hub used by `telo search`. Overridden by `--hub-url`. |
| `TELO_EGRESS` | run, install, check | Set to `public-only` to refuse fetches from private, loopback or link-local hosts. See [Security & supply chain](/deploy/security). |

A manifest-declared name is bound by the kernel, not read ad-hoc: once an
Application declares `PORT` in its `ports:` block, that variable is served
through `ports.http` and reading `process.env.PORT` from inside a controller
returns `undefined` by design, so a declared binding cannot be bypassed.

## Bare CLI under a supervisor

Docker is the recommended packaging, but a plain process works. The unit below
relies on the same signal behaviour described above — systemd's default
`KillSignal` is `SIGTERM`, which is exactly what triggers graceful teardown:

```ini
[Unit]
Description=My Telo app
After=network-online.target

[Service]
Type=simple
User=telo
WorkingDirectory=/srv/my-app
ExecStart=/usr/bin/telo /srv/my-app/telo.yaml
Environment=PORT=8080
EnvironmentFile=/etc/my-app.env
Restart=always
RestartSec=2
# Must exceed the slowest teardown; systemd SIGKILLs after this.
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
```

Run `telo install /srv/my-app/telo.yaml` as part of deployment, before starting
the unit, so the first boot does not depend on the network.

## See also

- [Docker image](/deploy/docker) — packaging and cache warming.
- [Security & supply chain](/deploy/security) — pinning, verification, and what
  a module can reach.
- [Diagnostics reference](/reference/diagnostics) — every error code, and what
  to do about it.
- [Logging](/learn/logging) — levels, sinks, redaction, sampling.
