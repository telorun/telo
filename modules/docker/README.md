# Docker

`docker` — a [`Container.Engine`](../container/README.md) over the Docker
Engine API. `Docker.Engine` runs the containers `Container.Instance` declares on
a local Docker or Podman daemon, or on an engine a runner serves its session,
reached over a unix socket or HTTP(S) with an optional bearer token.

## Why use this

- **No client library, no CLI.** A small fixed set of Engine API requests over
  raw HTTP — the whole contract an endpoint has to answer is one table
  ([docs/engine-api.md](docs/engine-api.md)).
- **Nothing exposed beyond the machine.** Every published port is bound on the
  engine's loopback interface to a port the engine picks.
- **One manifest, local or remote.** Bound to `TELO_HOST_CONTAINER_ENGINE_URL`
  and `TELO_HOST_CONTAINER_ENGINE_TOKEN`, the same file uses the local daemon
  when nothing is set and the engine a runner serves when one is.

## Kinds

| Name | What it is |
| --- | --- |
| `Docker.Engine` | A `Container.Engine`. Fields: `endpoint` (`unix://`, `tcp://`, `http(s)://` with an optional path prefix), `token` (optional bearer token; empty sends none). |

## Example

```yaml
kind: Telo.Application
metadata: { name: WithRedis, version: 1.0.0 }
imports:
  Container: oci://ghcr.io/telorun/container@<version>
  Docker: oci://ghcr.io/telorun/docker@<version>
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
metadata: { name: redis }
engine: !ref docker
image: redis:7
ports: [6379]
readiness: { kind: Container.LogReady, text: Ready to accept connections }
lifetime: 1h
```

## Reference

- [The Engine API requests, the create body, bindings and supported engines](docs/engine-api.md)
