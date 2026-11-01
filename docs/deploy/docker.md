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
WORKDIR /workspace
COPY --chown=node:node ./apps/my-app/ ./
RUN telo install .

FROM telorun/node:<ver>-slim AS production
WORKDIR /workspace
COPY --from=build --chown=node:node /workspace /workspace
CMD ["telo", "run", "--no-input", "."]
```

`--no-input` makes a missing input a refusal (exit status 1, naming the variables) instead of a prompt when the container has a terminal. The image runs as the unprivileged `node` user (uid and gid 1000, `HOME=/home/node`) and its working directory `/workspace` belongs to it, so a derived image needs no `USER` line. Copy your files with `COPY --chown=node:node` — a plain `COPY` leaves them root-owned and `telo install` cannot write `.telo/` beside them — and switch with `USER root` … `USER node` for the one step that needs root, such as `RUN apt-get install`. A read-only root filesystem, an arbitrary uid and a health check: [Running unprivileged](/deploy/production#running-unprivileged).

The image has a smart entrypoint (like the official `node` image): a bare manifest path or a flag is routed to `telo`, so the explicit `CMD ["telo", "--watch", "apps/my-app/telo.yaml"]` and the terse `CMD ["apps/my-app/telo.yaml"]` both work. At run time, `docker run … <image> ./manifest.yaml` or `docker run … <image> --watch ./manifest.yaml` reach the CLI, while `docker run … <image> bash` drops into a shell.

## Warm the cache with `telo install`

`telo install` walks the manifest's `imports:` graph transitively, downloads every controller package, and writes both under the **cache root** (`.telo/`, see [below](#where-the-cache-lands)):

- `.telo/npm/<hash>/` — controller `node_modules` tree, one per runner rather than per app: keyed by where the CLI sits relative to the tree, plus the host platform. A tree warmed in the build stage is reused when the production stage copies it to another directory at the same depth, while a checkout bind-mounted from a different telo installation — a container over a host checkout — gets its own instead of inheriting one whose paths are true only on the other side.
- `.telo/manifests/…` — every imported `telo.yaml`, registry-served or HTTP-fetched, plus the module layers (bundled controllers, assets) each one ships.

Module layers are warmed for the build machine's os, arch and libc; pass `--platform os/arch[/libc]` when the image targets another. A layer built for one runtime ABI is warmed only with `--abi <family>-<version>` naming the runtime the image runs (`--abi node-137` for Node 24), because the process running `telo install` is not necessarily that runtime; without it, install lists each such layer it skipped, and a run that needs one fetches it then.

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
WORKDIR /workspace
COPY --chown=node:node . .
RUN telo install apps/my-app

FROM telorun/node:<ver>-slim AS production
WORKDIR /workspace
# The marker at /workspace/telo-workspace.yaml is what makes the kernel look for
# /workspace/.telo. The cache is copied as its own instruction, to its own path:
# a COPY with a directory source copies the directory's CONTENTS, so listing
# .telo beside the marker would scatter them across /workspace.
COPY --from=build --chown=node:node /workspace/telo-workspace.yaml /workspace/telo-workspace.yaml
COPY --from=build --chown=node:node /workspace/.telo /workspace/.telo
COPY --from=build --chown=node:node /workspace/apps/my-app /workspace/apps/my-app
CMD ["telo", "apps/my-app"]
```

Or, independent of any marker:

```dockerfile
ENV TELO_CACHE_DIR=/workspace/.telo
```

set in **both** stages, so the build writes where the run reads. Verify the image before shipping it: run it once with networking disabled (`docker run --network none …`) and it must boot.

## Image variants

| Tag                                       | Base        | Rust toolchain                                              |
| ----------------------------------------- | ----------- | ----------------------------------------------------------- |
| `telorun/node:<ver>`                      | debian      | no                                                          |
| `telorun/node:<ver>-slim`                 | debian-slim | no — **recommended for production**                         |
| `telorun/node:<ver>-rust-<rust-ver>`      | debian-slim | yes — for controllers compiling native deps at install time |
| `telorun/node:<ver>-rust-<rust-ver>-slim` | debian-slim | yes — the same image as the row above, published under both tag spellings |

`<ver>` accepts an exact CLI version (`1.4.2`), a major (`1`), a major.minor (`1.4`), or `latest`. **Pin to an exact version in production** — rolling tags move with each release.

The `-rust-*` variants carry rustc, cargo and rust-std plus a C build environment of gcc, libc6-dev, make and pkg-config — enough for a pure-Rust crate or one whose `build.rs` drives a C compiler. They deliberately do not carry git, python3 or cmake; a dependency whose build needs one of those must vendor it or ship prebuilt.

The `-rust-*` variants only need to be present in the **build** stage if your controllers compile native code at install time. Use the slim variant for the production stage either way; copying the warmed `/workspace` tree across is a single `COPY --from=build`.

## Provide needs

An application that declares `needs:` fails at load with `ERR_NEED_UNMET` unless the container is given each required one. Run `telo needs report ./manifest.yaml` in the build stage or in CI — it boots nothing — and supply what it lists:

- **`Telo.DurableDirectory`** — mount a volume and set the `TELO_NEED_<NEED>__PATH` variable the report names, or mount one volume and set `TELO_HOST_STATE_DIR` to it: every directory need without a variable then becomes `<state dir>/needs/<need path>`. See [Persistent state and replicas](/deploy/production#persistent-state-and-replicas) and [Durable directories](/learn/providing-needs#durable-directories).
- **`Telo.PublicUrl`** — set the need's variable to the address the container is reached at, or set `TELO_HOST_PUBLIC_URL_TEMPLATE` (and `TELO_HOST_PUBLIC_URL_SECONDARY_TEMPLATE` for a second address on one port) and let the kernel derive them. See [Public addresses](/learn/providing-needs#public-addresses) and [deriving addresses from the templates](/learn/providing-needs#deriving-addresses-from-the-templates).
- **Any other need** — one variable per field, `TELO_NEED_<PATH>__<FIELD>` or the name its `env:` binds.

Every name is in [Environment variables](/reference/environment-variables); the host values and need variables are hidden from controllers once read.

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

## Air-gapped and private registries

Modules and the image come from two places and are resolved separately.

**Modules.** An `oci://<host>/<repo>@<version>` import is fetched over HTTPS from the host written in the ref, and from nowhere else; there is no registry setting that redirects `ghcr.io` elsewhere (`TELO_OCI_REGISTRY` is where `telo release` publishes, not where imports are read from). Credentials come from the Docker configuration: the `config.json` under `DOCKER_CONFIG` (default `~/.docker`), using a per-registry `credHelpers` entry, then a global `credsStore`, then an inline `auths` entry, and anonymous access when none matches. In a build stage, mount that file as a build secret rather than copying it into a layer.

**A mirror.** To serve modules from a registry you control, copy the artifacts of the `telorun/*` modules you import to it with an OCI copy tool, keeping the org layout (the standard library's modules import each other by relative path, so they must stay siblings), then change each `imports:` source to the mirror's host. The `#sha256-` pin is over the manifest's bytes, so a byte-identical copy verifies against the pin you already have. Confirm a mirror with `telo install` against it and the offline run below.

**No registry at run time.** The deploy needs none when the image is built from a warmed cache:

```bash
docker build -t my-app:1.0.0 .
docker run --rm --network none --read-only --tmpfs /tmp -e PORT=8080 my-app:1.0.0
```

Run the built image once with `--network none` and the real environment; if it boots, nothing was fetched. Only the build stage ever reaches a registry, and it is the only place the credentials are needed. To carry the image into a network with no registry at all, `docker save` / `docker load` it. The base image comes from a registry too: mirror `telorun/node` and name the mirror in `FROM`, pinned by digest ([hardening checklist](/deploy/security#hardening-checklist)).

Packaging as a [standalone binary](/learn/packaging-an-app) is the other offline shape: the payload carries every module and controller.

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

- [Telo CLI](/learn/telo-cli) — full `telo install` reference, including registry and package-manager overrides.
- [Application Environment Variables](/reference/kernel/application-env-variables) — declaring `variables:` / `secrets:` against host env.
- [Environment variables](/reference/environment-variables) — every variable the runtime reads.
- [Running in production](/deploy/production) — signals, exit codes, probes, non-root, persistent state.
- [AWS Lambda](/deploy/lambda) — the serverless alternative, for event-driven workloads.
