FROM node:24 AS development

WORKDIR /app

RUN corepack enable

CMD ["pnpm", "run", "--filter", "@telorun/k8s-runner", "dev"]

# The session supervisor every app container runs: one static musl executable
# per target architecture, built on the build platform (see
# packages/runner-core/supervisor/README.md). The build platform's own musl
# target links natively; another architecture is cross-linked with rust-lld —
# set for that target only, since proc-macros still link for the host. The whole
# context is copied because cargo reads every workspace member's manifest.
FROM --platform=$BUILDPLATFORM rust:1-alpine AS supervisor
ARG TARGETARCH
WORKDIR /src
COPY . .
RUN case "$TARGETARCH" in \
      amd64) triple=x86_64-unknown-linux-musl ;; \
      arm64) triple=aarch64-unknown-linux-musl ;; \
      *) echo "no session supervisor target for TARGETARCH '$TARGETARCH'" >&2; exit 1 ;; \
    esac \
 && if [ "$triple" != "$(uname -m)-unknown-linux-musl" ]; then \
      rustup target add "$triple" \
      && export "CARGO_TARGET_$(echo "$triple" | tr 'a-z-' 'A-Z_')_LINKER=rust-lld"; \
    fi \
 && cargo build --release --locked -p telo-runner-supervisor --target "$triple" \
 && install -D -m 0755 "target/$triple/release/supervisor" /out/supervisor

FROM development AS build

COPY . .

RUN pnpm install --frozen-lockfile
# `...` builds the @telorun/runner-core + @telorun/debug-wire workspace
# dependencies first; without it tsc / the runtime can't resolve their dist.
RUN pnpm run --filter @telorun/k8s-runner... build
# pnpm deploy produces a self-contained, hoisted node_modules for a single
# workspace package at /out, rewriting workspace:* deps and pruning devDeps.
RUN pnpm deploy --legacy --filter=@telorun/k8s-runner --prod /out

FROM node:24-slim AS production

WORKDIR /app
COPY --from=build /out ./
# Copied into every session pod by its `supervisor` init container, which runs
# this image (RUNNER_SUPERVISOR_IMAGE).
COPY --from=supervisor /out/supervisor /opt/telo-runner/supervisor

# The kernel image spawned for each session, baked at build time so a runner's
# tested kernel and its runtime kernel are the same artifact. The default was a
# mutable `telorun/node:latest-slim`, which made the session kernel whatever was
# last released — that is how a 0.74.0 kernel ended up running a module published
# against 0.76.0, failing with four unresolvable-$ref schema errors. CI passes the
# CLI version this image was built against; an operator can still override with
# RUNNER_IMAGE (Helm: `session.image`).
ARG TELO_SESSION_IMAGE=telorun/node:latest-slim
ENV RUNNER_IMAGE=${TELO_SESSION_IMAGE}

ENV PORT=8062
# No safe default for RUNNER_SUPERVISOR_IMAGE — this image's own reference, which
# only the deployment knows (the Helm chart sets it). The runner refuses to
# start when unset.

EXPOSE 8062
CMD ["node", "dist/server.js"]
