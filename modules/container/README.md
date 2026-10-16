# Container

`container` — disposable containers for the lifetime of an application or a
test. `Container.Instance` pulls an image, starts it, waits until it is ready
and removes it with its volumes when the application stops; `Container.Port`
reports the address a published port is reached at, so a connection string can
be built from it at startup.

The module names no engine. A backend module implements `Container.Engine` —
[`docker`](../docker/README.md) speaks the Docker Engine API to a local daemon
or to an engine a runner serves its session.

## Why use this

- **A test brings its own infrastructure.** A database, a queue or any service
  is started by the test that needs it, so the same file runs alone, in a suite
  and in a runner session with nothing set up beforehand.
- **Nothing is left behind.** The container is force-removed with its volumes
  when the application ends or its start fails, and one left by a killed
  process expires and is swept by the next start on the same engine.
- **Typed addresses.** A port's address is observed state, readable in any
  startup field (`resources.endpoint.status.host`), and a port the container
  does not publish is refused by `telo check`.

## Kinds

| Kind | What it is |
| --- | --- |
| [`Container.Instance`](docs/containers.md#containerinstance) | One container: image, command, environment, user, ports, readiness, startup deadline, lifetime. |
| [`Container.Port`](docs/containers.md#containerport) | The address one published port is reached at, as `status: { host, port }`. |
| [`Container.LogReady`](docs/containers.md#containerlogready) | Ready once a text appears in the container's output a number of times. |
| `Container.Engine` | Abstract: what runs containers. Contract: [docs/engine-contract.md](docs/engine-contract.md). |
| `Container.Readiness` | Abstract: when a started container counts as ready. |

## Example

```yaml
kind: Telo.Application
metadata: { name: OrdersTest, version: 1.0.0 }
imports:
  Container: oci://ghcr.io/telorun/container@<version>
  Docker: oci://ghcr.io/telorun/docker@<version>
  Postgres: oci://ghcr.io/telorun/postgres@<version>
variables:
  engineUrl:
    env: TELO_HOST_CONTAINER_ENGINE_URL
    type: string
    default: unix:///var/run/docker.sock
secrets:
  engineToken: { env: TELO_HOST_CONTAINER_ENGINE_TOKEN, type: string, default: "" }
---
kind: Docker.Engine
metadata: { name: docker }
endpoint: !cel "variables.engineUrl"
token: !cel "secrets.engineToken"
---
kind: Container.Instance
metadata: { name: database }
engine: !ref docker
image: pgvector/pgvector:pg18
user: "999:999"
env: { POSTGRES_PASSWORD: postgres }
ports: [5432]
readiness:
  kind: Container.LogReady
  text: database system is ready to accept connections
  times: 2
lifetime: 2h
---
kind: Container.Port
metadata: { name: databasePort }
container: !ref database
port: 5432
---
kind: Postgres.Connection
metadata: { name: db }
access:
  kind: Postgres.DatabaseAccess
  fields:
    url:
      scheme: postgres
      host: !cel "resources.databasePort.status.host"
      port: !cel "resources.databasePort.status.port"
      user: postgres
      password: postgres
      path: /postgres
```

## Reference

- [Containers: kinds, lifecycle, cleanup, errors and runners](docs/containers.md)
- [The engine and readiness contracts](docs/engine-contract.md)
