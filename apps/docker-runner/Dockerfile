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

FROM node:24 AS development

WORKDIR /app

RUN corepack enable
# The runner writes this onto the bundle volume at boot, for every app
# container to mount; the development stack runs this stage.
COPY --from=supervisor /out/supervisor /opt/telo-runner/supervisor

CMD ["pnpm", "run", "--filter", "@telorun/docker-runner", "dev"]

FROM development AS build

COPY . .

RUN pnpm install --frozen-lockfile
# `...` builds the @telorun/runner-core workspace dependency first; without it
# tsc cannot resolve runner-core's dist/index.d.ts.
RUN pnpm run --filter @telorun/docker-runner... build
# pnpm deploy produces a self-contained, hoisted node_modules for a single
# workspace package at /out, rewriting workspace:* deps and pruning devDeps.
# Sidesteps the isolated-node-linker / symlinked-store issue in a
# single-stage copy.
RUN pnpm deploy --legacy --filter=@telorun/docker-runner --prod /out

FROM node:24-slim AS production

WORKDIR /app
COPY --from=build /out ./
COPY --from=supervisor /out/supervisor /opt/telo-runner/supervisor

ENV PORT=8061 BUNDLE_ROOT=/bundles
# Deliberately NO `VOLUME ["/bundles"]`:
# A VOLUME directive makes Docker auto-create an anonymous volume at /bundles
# if the operator runs the image without -v <named>:/bundles. That anonymous
# volume is invisible to spawned sibling containers, which then see an empty
# workspace. The runner's boot-time BUNDLE_VOLUME check is the sole enforcement
# point.
# Deliberately NO default BUNDLE_VOLUME / RUNNER_CHILD_NETWORK in ENV:
# There is no safe default. Every deployment mode (compose / standalone) must
# make a deliberate choice and pass it in; the runner refuses to start when
# unset.

EXPOSE 8061
CMD ["node", "dist/server.js"]
