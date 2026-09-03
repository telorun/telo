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
FROM telorun/node:<ver>-slim AS build
WORKDIR /build
COPY ./apps/my-app/ ./
RUN telo install .

FROM telorun/node:<ver>-slim AS production
WORKDIR /srv
COPY --from=build /build /srv
CMD ["telo", "."]
```

The image has a smart entrypoint (like the official `node` image): a bare manifest path or a flag is routed to `telo`, so the explicit `CMD ["telo", "apps/my-app/telo.yaml", "--watch"]` and the terse `CMD ["apps/my-app/telo.yaml"]` both work. At run time, `docker run … <image> ./manifest.yaml` or `docker run … <image> --watch ./manifest.yaml` reach the CLI, while `docker run … <image> bash` drops into a shell.

## Warm the cache with `telo install`

`telo install` walks the manifest's `imports:` graph transitively, downloads every controller package, and writes both under the **cache root** (`.telo/`, see [below](#where-the-cache-lands)):

- `.telo/npm/<hash>/` — controller `node_modules` tree, one per runner rather than per app: keyed by where the CLI sits relative to the tree, plus the host platform. A tree warmed in the build stage is reused when the production stage copies it to another directory at the same depth, while a checkout bind-mounted from a different telo installation — a container over a host checkout — gets its own instead of inheriting one whose paths are true only on the other side.
- `.telo/manifests/…` — every imported `telo.yaml`, registry-served or HTTP-fetched, plus the module layers (bundled controllers, assets) each one ships.

Running this in the build stage means the production image is a hermetic snapshot. The kernel resolves every controller and every imported module from disk — boot does **zero** network I/O, which is what makes the image safe to run in airgapped, scale-out, and cold-start scenarios.

Skip the warm-up and your container will pull controllers on every boot, suffer slow start times, and break entirely if it has no outbound network.

## Where the cache lands

The cache root is resolved the same way by `install`, `check` and `run`:

1. `TELO_CACHE_DIR`, if set.
2. `.telo/` **beside `telo-workspace.yaml`**, when that marker sits anywhere above the manifest.
3. `.telo/` beside the manifest, when there is no marker.

The two-stage Dockerfile above copies only the app directory, so no marker is copied and rule 3 applies — the cache is next to the manifest and the `COPY --from=build` ships it.

**A monorepo is different.** [`telo release`](/extend/releasing-modules) asks you to put `telo-workspace.yaml` at the repository root, and a workspace whose apps import shared libraries by relative path has to copy the whole tree into the build stage anyway. Then `telo install apps/my-app` writes to `/build/.telo`, not `/build/apps/my-app/.telo` — and a production stage that copies only `apps/my-app` ships **no cache at all**. Nothing fails at build time; the container pulls on every boot, and fails outright when it has no network.

Either keep the marker with the manifest, or pin the location:

```dockerfile
FROM telorun/node:<ver>-slim AS build
WORKDIR /build
COPY . .
RUN telo install apps/my-app

FROM telorun/node:<ver>-slim AS production
WORKDIR /srv
# The marker at /srv/telo-workspace.yaml is what makes the kernel look for
# /srv/.telo. The cache is copied as its own instruction, to its own path:
# a COPY with a directory source copies the directory's CONTENTS, so listing
# .telo beside the marker would scatter them across /srv.
COPY --from=build /build/telo-workspace.yaml /srv/telo-workspace.yaml
COPY --from=build /build/.telo /srv/.telo
COPY --from=build /build/apps/my-app /srv/apps/my-app
CMD ["telo", "apps/my-app"]
```

Or, independent of any marker:

```dockerfile
ENV TELO_CACHE_DIR=/srv/.telo
```

set in **both** stages, so the build writes where the run reads. Verify the image before shipping it: run it once with networking disabled (`docker run --network none …`) and it must boot.

## Image variants

| Tag                                       | Base        | Rust toolchain                                              |
| ----------------------------------------- | ----------- | ----------------------------------------------------------- |
| `telorun/node:<ver>`                      | debian      | no                                                          |
| `telorun/node:<ver>-slim`                 | debian-slim | no — **recommended for production**                         |
| `telorun/node:<ver>-rust-<rust-ver>`      | debian-slim | yes — for controllers compiling native deps at install time |
| `telorun/node:<ver>-rust-<rust-ver>-slim` | debian-slim | yes — the same image, under its historical name             |

`<ver>` accepts an exact CLI version (`1.4.2`), a major (`1`), a major.minor (`1.4`), or `latest`. **Pin to an exact version in production** — rolling tags move with each release.

The `-rust-*` variants carry rustc, cargo and rust-std plus a C build environment of gcc, libc6-dev, make and pkg-config — enough for a pure-Rust crate or one whose `build.rs` drives a C compiler. They deliberately do not carry git, python3 or cmake; a dependency whose build needs one of those must vendor it or ship prebuilt.

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
