---
sidebar_label: Docker image
slug: /deploy/docker
description: Package a Telo manifest as an OCI container using the telorun/node base image, with a build stage that warms the controller cache so production boots offline.
---

# Deploying with Docker

The `telorun/node` image ships a Telo kernel and CLI on top of a Node.js base. Your Dockerfile adds the manifest and a pre-warmed controller cache; the container runs `telo <manifest>` on start.

## Two-stage Dockerfile

The canonical pattern: a **build** stage runs `telo install` to materialize `.telo/`, a **production** stage copies the warmed tree and does no network I/O at boot.

```dockerfile
FROM telorun/node:1.4.2-slim AS build
WORKDIR /srv
COPY apps/my-app/ apps/my-app/
RUN telo install apps/my-app/telo.yaml

FROM telorun/node:1.4.2-slim AS production
WORKDIR /srv
COPY --from=build /srv /srv
CMD ["telo", "apps/my-app/telo.yaml"]
```

The image has a smart entrypoint (like the official `node` image): a bare manifest path or a flag is routed to `telo`, so the explicit `CMD ["telo", "apps/my-app/telo.yaml", "--watch"]` and the terse `CMD ["apps/my-app/telo.yaml"]` both work. At run time, `docker run … <image> ./manifest.yaml` or `docker run … <image> --watch ./manifest.yaml` reach the CLI, while `docker run … <image> bash` drops into a shell.

## Warm the cache with `telo install`

`telo install` walks the manifest's `Telo.Import` graph, downloads every controller package, and writes both to `<manifest-dir>/.telo/`:

- `.telo/npm/` — controller `node_modules` tree, one realm per manifest.
- `.telo/manifests/…` — every imported `telo.yaml`, registry-served or HTTP-fetched.

Running this in the build stage means the production image is a hermetic snapshot. The kernel resolves every controller and every `Telo.Import` from disk — boot does **zero** network I/O, which is what makes the image safe to run in airgapped, scale-out, and cold-start scenarios.

Skip the warm-up and your container will pull controllers on every boot, suffer slow start times, and break entirely if it has no outbound network.

## Image variants

| Tag                                       | Base        | Rust toolchain                                              |
| ----------------------------------------- | ----------- | ----------------------------------------------------------- |
| `telorun/node:<ver>`                      | debian      | no                                                          |
| `telorun/node:<ver>-slim`                 | debian-slim | no — **recommended for production**                         |
| `telorun/node:<ver>-rust-<rust-ver>`      | debian      | yes — for controllers compiling native deps at install time |
| `telorun/node:<ver>-rust-<rust-ver>-slim` | debian-slim | yes                                                         |

`<ver>` accepts an exact CLI version (`1.4.2`), a major (`1`), a major.minor (`1.4`), or `latest`. **Pin to an exact version in production** — rolling tags move with each release.

The `-rust-*` variants only need to be present in the **build** stage if your controllers compile native code at install time. Use the slim variant for the production stage either way; copying the warmed `/srv` tree across is a single `COPY --from=build`.

## Configuring at runtime

`Telo.Application` reads host env vars declared in its `variables:` / `secrets:` blocks — see [Application Environment Variables](/reference/kernel/application-env-variables). Pass them with `-e` or via your orchestrator:

```bash
docker run --rm \
  -e PORT=8080 \
  -e DATABASE_URL=postgres://… \
  -p 8080:8080 \
  my-registry/my-app:1.0.0
```

No `Config.Env` resource is needed — the binding is declarative on the Application.

## Compose example

```yaml
services:
  api:
    image: my-registry/my-app:1.0.0
    environment:
      PORT: 8080
      LOG_LEVEL: info
      DATABASE_URL: ${DATABASE_URL}
    ports:
      - "8080:8080"
    restart: unless-stopped
```

## One-shot vs long-running

The same image runs both shapes — the difference is what the manifest declares.

- A `Telo.Application` whose `targets:` are `Telo.Service` resources keeps the process alive (HTTP servers, workers, schedulers). The orchestrator's restart policy (compose, Kubernetes, ECS) handles failover.
- A manifest whose `targets:` are `Telo.Runnable` resources runs to completion and exits. Good for batch jobs, migrations, CI tasks, scheduled cron units.

## Building and pushing

Standard OCI flow — nothing Telo-specific:

```bash
docker build -t my-registry/my-app:1.0.0 .
docker push my-registry/my-app:1.0.0
```

For multi-arch builds (e.g. shipping both `linux/amd64` and `linux/arm64`):

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t my-registry/my-app:1.0.0 \
  --push .
```

## See also

- [Installation & CLI](/learn/installation-and-cli) — full `telo install` reference, including registry and package-manager overrides.
- [Application Environment Variables](/reference/kernel/application-env-variables) — declaring `variables:` / `secrets:` against host env.
- [AWS Lambda](/deploy/lambda) — the serverless alternative, for event-driven workloads.
