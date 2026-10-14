# Docker.Engine — the Engine API it speaks

`Docker.Engine` implements [`Container.Engine`](../../container/docs/engine-contract.md)
over the Docker Engine API, version 1.41, as raw HTTP. The requests below are
**all** it sends: an endpoint that answers them — a Docker or Podman daemon, or
a runner serving its sessions an engine — is an endpoint it can use.

## Endpoint

| `endpoint` | Transport |
| --- | --- |
| `unix:///var/run/docker.sock` | HTTP over a unix socket. |
| `tcp://host:2375` | Plain HTTP to `host:2375`. |
| `http://host[:port][/prefix]`, `https://…` | HTTP(S); every request path is prefixed with `/prefix`. |

Any other scheme is refused by `telo check` (`SCHEMA_VIOLATION`). With a
non-empty `token`, every request carries `Authorization: Bearer <token>`.

Bind both to the environment a runner sets, so one manifest runs locally and in
a session:

```yaml
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
```

## The requests

Paths are relative to the endpoint (after its prefix). `{id}` is a container id
the engine returned from create; `{image}` an image reference as written.

| Operation | Request | Body / query | Success |
| --- | --- | --- | --- |
| ping | `GET /v1.41/_ping` | — | 2xx |
| image inspect | `GET /v1.41/images/{image}/json` | — | 200 held, 404 not held |
| image pull | `POST /v1.41/images/create` | query `fromImage`, `tag` (`tag` omitted for a digest reference; `latest` for a reference with neither) | 200 and a JSON-lines progress stream; a line carrying `error` / `errorDetail` is a failed pull |
| container create | `POST /v1.41/containers/create` | JSON body, below | 201 `{ "Id": … }` |
| container start | `POST /v1.41/containers/{id}/start` | — | 2xx |
| container inspect | `GET /v1.41/containers/{id}/json` | — | 200; read: `State.Running`, `State.ExitCode`, `NetworkSettings.Ports` |
| container logs | `GET /v1.41/containers/{id}/logs` | query `follow` (`true` / `false`), `stdout=true`, `stderr=true`, `tail` (only for the output of a container that exited) | 200, the multiplexed stream framing (8-byte header: stream id, three zero bytes, big-endian payload length) |
| container list by label | `GET /v1.41/containers/json` | query `all=true`, `filters={"label":["run.telo.container.expires"]}` | 200 `[{ "Id", "Labels" }]` |
| container delete | `DELETE /v1.41/containers/{id}` | query `force=true`, `v=true` | 2xx; 404 and 409 are read as already gone / being removed |

It never stops a container (the delete is forced), never names one, and never
attaches to one.

### The create body

Exactly these keys, and no others:

```json
{
  "Image": "pgvector/pgvector:pg18",
  "Cmd": ["postgres", "-c", "fsync=off"],
  "Entrypoint": ["docker-entrypoint.sh"],
  "Env": ["POSTGRES_PASSWORD=postgres"],
  "User": "999:999",
  "ExposedPorts": { "5432/tcp": {} },
  "Labels": { "run.telo.container.expires": "1760430000" },
  "HostConfig": {
    "PortBindings": { "5432/tcp": [{ "HostIp": "127.0.0.1", "HostPort": "" }] }
  }
}
```

`Cmd`, `Entrypoint` and `User` are present only when the resource sets them.
`HostConfig` holds only `PortBindings`: one entry per published port, on
`127.0.0.1`, with an empty `HostPort` so the engine chooses a free one.

### What a binding means

The binding inspect reports for a port —
`NetworkSettings.Ports["<port>/tcp"][0]`, its `HostIp` and `HostPort` — is the
address at which the requester reaches the port, and the only address read. A
container's network address (`NetworkSettings.IPAddress`, `Networks`) is never
consulted. A port with no binding, or one reported on `0.0.0.0` / `::`, fails
the start with `ERR_CONTAINER_START_FAILED`.

## Supported engines

- **Directly**: an engine whose loopback-bound published ports appear on the
  loopback of the machine running Telo — native Docker (rootful or rootless),
  Docker Desktop, Colima, and a Podman socket.
- **Through a runner**: a daemon on another machine, or a socket mounted into a
  container, publishes on a loopback Telo does not share, so its bindings are
  not reachable. Such an engine is served through a runner: the docker and
  Kubernetes runners, with `RUNNER_SESSION_CONTAINERS` on, serve each session
  an engine at `<runner>/v1/sessions/<id>/engine` behind a per-session token
  (`TELO_HOST_CONTAINER_ENGINE_URL` / `_TOKEN`). It answers exactly the
  requests above, accepts exactly the create body above (any other field is a
  400 naming it), publishes nothing, and answers each binding with the address
  the session reaches the container at — its address on the runner's network,
  or its pod's IP, with the container port.
