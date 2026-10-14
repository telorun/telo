# Containers

> Examples assume this module is imported under the alias `Container` and an
> engine module (here `docker`) under `Docker`.

## Container.Instance

One container, started when the application starts and removed when it stops.
A `Telo.Provider`: everything happens in its `init()`, as one effect whose
inverse force-removes the container together with its anonymous volumes — on
shutdown, and on a start that fails anywhere after the container was created.

| Field | Required | Meaning |
| --- | --- | --- |
| `engine` | yes | `!ref` to a `Container.Engine` (e.g. `Docker.Engine`). |
| `image` | yes | Image reference. No tag or digest means `latest`. Pulled only when the engine does not hold it. |
| `command` | no | Arguments replacing the image's default command. |
| `entrypoint` | no | Executable and arguments replacing the image's entrypoint. |
| `env` | no | Environment variables (string map). Only their **names** appear in the resource's reading (`envNames`); values are never published. |
| `user` | no | User the process runs as (`999:999`). A numeric non-root user runs on every engine, including one that refuses root. |
| `ports` | no | Unique TCP container ports to publish. Each is bound on the engine's loopback interface to a port the engine chooses. |
| `readiness` | no | `!ref` (or inline) `Container.Readiness`. Omitted: ready as soon as it is running. |
| `startupTimeout` | no | `Telo.Duration` bounding pull + create + start + readiness together. Omitted: `120s`. |
| `lifetime` | yes | `Telo.Duration`: how long the container may outlive its start (see *Cleanup*). Set it above the longest the application runs. |

### Start

1. Reach the engine (`ping`).
2. Remove every container whose expiry label has passed (see *Cleanup*).
3. Pull the image when the engine does not hold it.
4. Create the container with the label `run.telo.container.expires` and one
   loopback binding per port, then start it.
5. Wait for readiness, when one is named.
6. Inspect it: it must be running, and the engine must report a binding with a
   specified address for every port. That binding is what `Container.Port`
   reports.

The resource's reading (`resources.<name>`) is `{ image, ports, envNames }`.

## Container.Port

The address at which one published port is reached, reported as observed state
the moment the container is ready:

```yaml
kind: Container.Port
metadata: { name: databasePort }
container: !ref database
port: 5432
```

`resources.databasePort.status.host` and `.status.port` (a `Telo.TcpPort`) are
readable in any field, including startup (compile-eval) fields of other
resources: a Provider's status is published when its `init()` returns, and the
read orders the reader after it. The status is closed, so a misspelled field is
`CEL_UNKNOWN_FIELD` at `telo check`.

The address is exactly the binding the engine reports for that port — on a
local engine `127.0.0.1` and the port it chose; on a runner-served engine the
address the session reaches the container at. Nothing else is consulted.

A `port` the container does not list under `ports` is refused by `telo check`
(`RESOURCE_RULE_VIOLATED`, rule `CONTAINER_PORT_NOT_EXPOSED`) and at creation
(`ERR_CONTAINER_PORT_NOT_EXPOSED`) where the check could not see the container.

## Container.LogReady

```yaml
readiness:
  kind: Container.LogReady
  text: database system is ready to accept connections
  times: 2
```

Ready once `text` has appeared `times` times (default 1) in the container's
standard output and standard error, read together from its start. `text` is a
plain substring, never a pattern, and may span lines. When the output ends
before that — the container stopped — the start fails with
`ERR_CONTAINER_EXITED`.

A readiness kind of your own extends `Container.Readiness` and implements
`waitUntilReady` ([engine-contract.md](engine-contract.md)).

## Cleanup

- **Normal end or failed start**: the effect's inverse force-removes the
  container and its anonymous volumes.
- **A killed process** cannot run its inverse. Every container carries the
  label `run.telo.container.expires` — the Unix seconds of its start plus
  `lifetime` — and every `Container.Instance` start on the same engine first
  removes each container whose expiry has passed. After a test is killed, the
  next run on that engine past the expiry leaves no trace:
  `docker ps -a --filter label=run.telo.container.expires` is empty.

## Errors

Each names the resource; all are raised by the start, after which nothing of
the container remains.

| Code | When |
| --- | --- |
| `ERR_CONTAINER_ENGINE_UNREACHABLE` | The engine could not be reached or refused to answer; the message names the endpoint. |
| `ERR_CONTAINER_START_FAILED` | The engine refused a step (a pull, a create, a start), carrying its message; or reported no usable binding (none, or `0.0.0.0` / `::`) for a published port. |
| `ERR_CONTAINER_NOT_READY` | `startupTimeout` passed before the container was ready. |
| `ERR_CONTAINER_EXITED` | The container stopped before it was ready; carries its exit code and the last lines of its output — or, when that output cannot be read (its request also bounded by `startupTimeout`), why not. |
| `ERR_CONTAINER_PORT_NOT_EXPOSED` | A `Container.Port` names a port its container does not publish. |

## Testing with containers

An integration test starts what it needs as top-level resources (or through an
imported fixture library), so it runs alone under `telo run`, in a suite, and
in a runner session unchanged. Bind the engine to the environment a runner
sets:

```yaml
variables:
  engineUrl:
    env: TELO_HOST_CONTAINER_ENGINE_URL
    type: string
    default: unix:///var/run/docker.sock
secrets:
  engineToken: { env: TELO_HOST_CONTAINER_ENGINE_TOKEN, type: string, default: "" }
```

Locally nothing is set and the developer's engine is used. A suite that boots
several applications against one container passes its address down through
`Test.Suite.env`; an `App.Instance` child receives it through `variables`.

Declare a container at the top level or import it — not inside a
`Run.Sequence`'s `with:` scope, whose startup fields cannot read a scoped
sibling's status.

## Running on a runner

The docker and Kubernetes runners serve each session a container engine of its
own when their operator turns it on (`RUNNER_SESSION_CONTAINERS`; the chart's
`session.containers.enabled`). Every session then gets
`TELO_HOST_CONTAINER_ENGINE_URL` (`<runner>/v1/sessions/<id>/engine`) and
`TELO_HOST_CONTAINER_ENGINE_TOKEN` (a token minted for that session), so the
test above runs in a session unchanged. The engine:

- answers exactly the requests `Docker.Engine` sends (`docs/engine-api.md` in the
  `docker` module) and refuses every other one; a create carrying any other
  field is a 400 naming it (`HostConfig.Privileged`, a fixed `HostPort`);
- refuses a request without the session's token (401) or with another one (403);
- holds at most `RUNNER_SESSION_CONTAINERS_MAX` containers per session (4 by
  default) and answers a create beyond that with 429;
- scopes every container to the session that created it — another session's id
  is a 404, and a list shows only the session's own;
- publishes nothing on any host and answers each port's binding with the address
  the session reaches the container at: its address on the runner's child
  network (docker), or its pod's IP (Kubernetes), with the container port;
- removes every container the session started when the session stops, suspends,
  reaches its deadline or is deleted, and the runner removes any left by a
  previous process when it boots.

On Kubernetes each container is a pod under the session namespace's `restricted`
Pod Security standard, so `user` must be a numeric non-root `uid[:gid]` — a root
or named user is refused, naming `User`. The node pulls the image when the pod
starts, so the start is where an image that cannot be pulled fails.
