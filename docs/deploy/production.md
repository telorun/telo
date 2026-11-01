---
sidebar_label: Running in production
slug: /deploy/production
description: Process lifecycle, signal handling and shutdown, exit codes, health checks, running unprivileged on a read-only filesystem, a Kubernetes deployment, persistent state and replicas, and logs and traces for operators.
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
   still flushed. Tearing a resource down runs the inverses its `init()` and
   `run()` returned, newest first; one that refuses is recorded and the cascade
   continues — a single failure cannot abandon the rest.
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
| `1` | Load, init, or a target run failed — the error is printed with the manifest location that caused it. That includes an input nothing supplies under `--no-input`, a manifest `telo check` refuses, and an argument the manifest does not declare. Also the code a failed assertion sets. |
| `2` | The CLI refused the invocation before any work: an unknown flag, a missing argument, a value outside an option's choices. Nothing was loaded. |
| _n_ | Whatever a controller passed to `ctx.requestExit(n)`. The highest requested code wins; `Assert.*` uses `1`. |

`telo run` exits with the application's own status, so a code of 2 after the
manifest path is the application's. The CLI's contract for every command is
[Exit status](/learn/telo-cli#exit-status).

**Start containers with `--no-input`.** Without it, a run whose stdin and stderr
are both a terminal (`docker run -it`, a Kubernetes pod with `tty: true`) asks
for each missing input and waits for an answer instead of failing. `--no-input`
turns that into the exit-1 refusal naming the missing variables; every runner
passes it. Use `CMD ["telo", "run", "--no-input", "."]`.

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
  - !ref server
ports:
  http:
    env: PORT
    default: 8080
---
kind: Http.Server
metadata:
  name: server
listen:
  port: !cel "ports.http"
mounts:
  - path: /
    mount: !ref health
---
kind: Http.Api
metadata:
  name: health
routes:
  - request:
      path: /healthz
      method: GET
    handler:
      kind: Run.Value
      value:
        status: ok
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
```

A liveness probe should stay this shallow — it answers "is the process still
serving?". If you want a readiness check that also proves a dependency is
reachable, point the route's `handler:` at a resource that exercises it (a
`Sql.Query` running `SELECT 1`, for instance) and let the route's `catches:`
render a non-2xx on failure.

## Running unprivileged

The `telorun/node` image runs as the `node` user (uid and gid 1000,
`HOME=/home/node`) and owns its working directory `/workspace`, so a container
started from it is already unprivileged. It sets no `HEALTHCHECK`: the image
cannot know your application's route. A production stage needs only to copy your
files in as that user and, if you want one, add the check:

```dockerfile
FROM telorun/node:<ver>-slim AS production
WORKDIR /workspace
COPY --from=build --chown=node:node /workspace /workspace
HEALTHCHECK --interval=10s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["telo", "run", "--no-input", "--no-cache-write", "."]
```

A step that needs root (`apt-get install`) is bracketed by `USER root` and
`USER node`. The Rust variant keeps its toolchain world-writable, so a
`pkg:cargo` controller builds under any uid.

The image has no `curl`, so the health check is a one-line Node request to the
route from [Health checks](#health-checks). Orchestrators that probe from
outside (Kubernetes, ECS) ignore `HEALTHCHECK` and use their own probe.

**An arbitrary uid** (`docker run --user 12345:12345`, OpenShift, Kubernetes
`runAsUser`) boots the same image. The user has no entry in `/etc/passwd`, so
`HOME` is `/` and nothing under `/home/node` is writable by it; the files you
copied with `--chown=node:node` are read-only to it. The `.telo/` cache is then
unwritable and a run without `--no-cache-write` logs a warning per derived entry
it cannot store (compiled validators, the analysis stamp, emitted CEL) and runs
on without them — pass `--no-cache-write`, or make the cache root writable for
that uid. Only the places in the table below have to be writable by it.

**A read-only root filesystem** needs only the places the process writes
mounted writable:

| Path | Why | Needed when |
| --- | --- | --- |
| The `.telo/` cache root | Derived entries (compiled validators, the analysis stamp, emitted CEL) are written beside the warmed controllers. | Never, with `--no-cache-write` and a cache warmed by `telo install`. Without the flag it may be unwritable: the run warns and recomputes those entries on every start. |
| `TELO_HOST_STATE_DIR`, or the path of each `Telo.DurableDirectory` need | The application's persistent files. The directory must already be writable by the running uid; a fresh Docker named volume mounted at a path the image does not have is root-owned and boots as `ERR_NEED_DIRECTORY_UNUSABLE`. | The application declares a durable directory. Create and `chown` the mount point in the image (`RUN mkdir -p /var/lib/app && chown node:node /var/lib/app`), or `chown` the volume for a uid other than 1000. |
| `/tmp` | The temporary directory controllers using one expect, and the fallback unpack root of a packaged binary. | A controller or the application uses it; a plain HTTP application booted without it. Mount a tmpfs or `emptyDir` as a matter of course. |
| `TELO_APP_DIR` | Where a [packaged binary](/learn/packaging-an-app) unpacks itself. | The container runs a packaged binary rather than `telo`. With no writable location the binary refuses to start and names the variable. |
| A `Telo.FileSink` `destination:`, or `--debug`'s `.telo.debug.jsonl` | Wherever you point them. | You use them. |

Prove the combination before shipping it: `docker run --read-only --network none
--tmpfs /tmp --user 12345:12345 <image> telo run --no-input --no-cache-write .` must
boot and serve.

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
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: app
          image: my-registry/my-app:1.0.0
          args: ["run", "--no-input", "--no-cache-write", "."]
          ports:
            - containerPort: 8080
          env:
            - name: PORT
              value: "8080"
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef: { name: my-app, key: database-url }
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: [ALL] }
          volumeMounts:
            - { name: tmp, mountPath: /tmp }
          readinessProbe:
            httpGet: { path: /healthz, port: 8080 }
            periodSeconds: 5
          livenessProbe:
            httpGet: { path: /healthz, port: 8080 }
            periodSeconds: 10
          resources:
            requests: { cpu: 100m, memory: 128Mi }
      volumes:
        - name: tmp
          emptyDir: {}
```

`runAsUser` is stated because the image's default user, `node`, is a name,
which `runAsNonRoot` cannot verify; 1000 is its uid. A `Deployment` suits an application that keeps no
state of its own; one with a durable directory needs the next section.

This is the manifest for deploying *your application*. `apps/k8s-runner` and its
chart are not a way to run it: they host sandboxed editor sessions (see the
[Deploy overview](/deploy#pick-a-model)).

Notes specific to Telo:

- **The image should be built with a warmed cache.** `telo install` in the build
  stage puts every controller and imported manifest under the `.telo/` cache
  root, so boot does no network I/O. In a monorepo that root is beside
  `telo-workspace.yaml`, not beside the manifest — see
  [where the cache lands](/deploy/docker#where-the-cache-lands).
- **The `.telo/` tree is read-only at run time** and identical in every replica,
  so it needs no volume and creates no shared state. Replicas are independent
  processes; nothing in the kernel coordinates between them. Coordination you
  want is declared — see the `lease`, `idempotency`, and `rate-limit` modules in
  the [standard library](/reference/standard-library), and
  [durable execution](/learn/durable-execution) for work that must survive a
  replica dying.
- **Pass `--no-cache-write`** when the container filesystem is read-only. The
  run still reads the baked cache; it just never persists derived entries.
- **Provide the needs** the application declares — `telo needs report` lists
  them — as env entries, volumes, or the host values below.
  [Providing needs](/learn/providing-needs).
- One `telo` process is one Node.js process. Scale with replicas.
- **Boot may touch your database.** A declared schema (`Sql.Schema` on a
  backend) reconciles tables at boot, a durable journal creates its own tables,
  and both run in every replica that starts. Each is written to tolerate
  concurrent boots. The PostgreSQL journal can be told not to create its tables
  (`createTable: false`) where your migrations own them or the runtime user
  holds no DDL grant; a declared schema always reconciles, so its connection
  needs the DDL grant — see each module's own docs on the hub.
- **Pin the kernel image AND the module pins together.** A module published
  against a newer Telo declares a floor the pinned image may not meet; see
  [Upgrades & version skew](/deploy/upgrades).

## Persistent state and replicas

An application asks for disk that outlives a restart with a
`Telo.DurableDirectory` need, and the need's `access` parameter is the contract
the host must honour ([Durable directories](/learn/providing-needs#durable-directories)):

- **`single-writer`** (the default) — at most one running instance has the
  directory at any moment, a rollout included. SQLite relies on it. On
  Kubernetes that is one replica and `strategy: { type: Recreate }`, so the old
  pod is gone before the new one starts, or a `StatefulSet` with a
  `ReadWriteOnce` claim:

  ```yaml
  apiVersion: apps/v1
  kind: StatefulSet
  metadata:
    name: my-app
  spec:
    serviceName: my-app
    replicas: 1
    selector:
      matchLabels: { app: my-app }
    template:
      metadata:
        labels: { app: my-app }
      spec:
        containers:
          - name: app
            image: my-registry/my-app:1.0.0
            args: ["run", "--no-input", "--no-cache-write", "."]
            env:
              - { name: TELO_HOST_STATE_DIR, value: /var/lib/my-app }
            volumeMounts:
              - { name: state, mountPath: /var/lib/my-app }
    volumeClaimTemplates:
      - metadata: { name: state }
        spec:
          accessModes: [ReadWriteOnce]
          resources: { requests: { storage: 5Gi } }
  ```

  A `StatefulSet` never runs two pods of one name at once; do not raise
  `replicas` above 1 for an application with a `single-writer` directory.
- **`shared`** — every instance has the directory at once, on different
  machines. It needs a `ReadWriteMany` volume, and file locking across machines
  is not reliable, so the application coordinates its own writes. SQLite is not
  safe on it.

`size` is the least the application needs; nothing measures it, and a full volume
reaches the application as the operating system's `ENOSPC`. A durable directory
is not a backup.

**One volume, one variable.** Setting `TELO_HOST_STATE_DIR` makes every directory
need with no variable of its own `<state dir>/needs/<need path>` (the path
`.`-separated: `needs/uploads`, `needs/Orders.uploads`), created at load. Mount
the volume at that path, as above. Use the directory for one application only —
two sharing it read each other's directories. To give each need its own volume
instead, leave `TELO_HOST_STATE_DIR` unset and set the variable
`telo needs report` lists for the need's `path`.

**Renaming a need or an import alias** gives it a new, empty directory. What the
operator sees at the next start:

- an entry under `needs/` that no durable-directory need names is an *orphan*;
- if the load would also create a fresh directory, it stops with
  `ERR_NEED_ORPHANED` naming both paths. Move the old directory to the new path
  to keep its files, or delete it;
- otherwise it only logs a `NEED_ORPHANED` warning.

Nothing is moved or deleted for you. If the directory is not writable the load
stops with `ERR_NEED_DIRECTORY_UNUSABLE` before any resource initializes — with
`runAsUser: 1000`, set `fsGroup: 1000` on the pod so the volume is writable.

## Logs and traces

**Where logs go.** With no `logging:` block, records go to the console sink on
**stderr**: JSON lines when stderr is not a terminal — a container without a TTY
— and the aligned, coloured form when it is (`docker run -t`, `tty: true`).
Standard output stays free for what the application deliberately prints
(`Console.writeLine`), so a collector can treat the two streams separately.
Pin the format with a sink: `- kind: Telo.ConsoleSink` with `encoding: json` and,
if your collector reads stdout, `destination: stdout`. Records carry the emitting
resource and, inside a dispatch, the trace and span ids. Values bound to
`secrets:` are redacted without configuration.

**Level without a rebuild.** There is no `TELO_LOG_LEVEL`. Bind a variable to
an env var of your choosing and read it in `logging:`; the level defaults to
`info`, and sampling is off — when enabled, `error` and above are not sampled by
default. Silence per-request access logs by raising the HTTP module's import to
`warn` ([Logging](/build/logging#raising-verbosity-for-one-dependency)).

**Traces over OTLP.** Tracing is off until a trace sink is attached. The `otlp`
module's `Otlp.TraceSink` exports spans as OTLP/JSON to the endpoint you give
it; the module reads no `OTEL_*` variables, so bind your own:

```yaml
kind: Telo.Application
metadata:
  name: MyApp
  version: 1.0.0
imports:
  Http: oci://ghcr.io/telorun/http-server@<version>
  Otlp: oci://ghcr.io/telorun/otlp@<version>
variables:
  logLevel: { env: LOG_LEVEL, type: string, default: info }
  otlpEndpoint: { env: OTLP_ENDPOINT, type: string, default: "" }
secrets:
  otlpToken: { env: OTLP_TOKEN, type: string, default: "" }
logging:
  level: !cel "variables.logLevel"
tracing:
  sinks:
    - sink:
        kind: Otlp.TraceSink
        endpoint: !interpolate "${{ variables.otlpEndpoint }}/v1/traces"
        headers:
          authorization: !interpolate "Bearer ${{ secrets.otlpToken }}"
        resourceAttributes: { service.name: my-app }
      when: !cel "variables.otlpEndpoint != ''"
targets:
  - !ref server
```

With `OTLP_ENDPOINT` unset the sink is not attached and tracing stays off.
`Otlp.Sink` ships log records the same way. A span never carries inputs or
outputs. **There is no metrics signal**: counters and latency distributions are
aggregations over exported spans, computed by the backend. See
[Logging](/build/logging) and [Tracing](/build/tracing).

## Runtime configuration

Everything the application itself needs is declared on `Telo.Application` as
`variables:`, `secrets:` and `ports:`, each bound to a host environment
variable — see [Application environment variables](/reference/kernel/application-env-variables)
and [Application ports](/reference/kernel/application-ports). A manifest-declared
name is bound by the kernel, not read ad-hoc: once an Application declares `PORT`
in its `ports:` block, that variable is served through `ports.http` and reading
`process.env.PORT` from inside a controller returns `undefined` by design, so a
declared binding cannot be bypassed.

The variables the runtime reads itself — the host values, `TELO_NEED_*`, the
cache, registry and egress settings, the packaged-app switches — and which of
them are hidden from controllers are in
[Environment variables](/reference/environment-variables).

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
ExecStart=/usr/bin/telo run --no-input --no-cache-write /srv/my-app/telo.yaml
Environment=PORT=8080
# Only for an application with a Telo.DurableDirectory need.
StateDirectory=my-app
Environment=TELO_HOST_STATE_DIR=/var/lib/my-app
NoNewPrivileges=true
ProtectSystem=strict
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
- [Upgrades & version skew](/deploy/upgrades) — moving pins and images without
  stranding one behind the other.
- [Security & supply chain](/deploy/security) — pinning, verification, and what
  a module can reach.
- [Diagnostics reference](/reference/diagnostics) — every error code, and what
  to do about it.
- [Logging](/build/logging) — levels, sinks, redaction, sampling.
- [Environment variables](/reference/environment-variables) — everything the runtime reads, and what it hides.
- [Providing needs](/learn/providing-needs) — durable directories, public addresses and the needs report.
