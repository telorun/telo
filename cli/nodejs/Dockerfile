# syntax=docker/dockerfile:1.7
#
# Multi-target Dockerfile for `telorun/node`. Four release variants share one
# builder stage so the monorepo compiles once:
#
#   lean       — node:24-trixie     + Telo CLI                     (default base)
#   lean-slim  — node:24-trixie-slim + Telo CLI                    (smaller footprint)
#   rust       — lean      + rustup-pinned Rust toolchain           (native deps)
#   rust-slim  — lean-slim + rustup-pinned Rust toolchain           (native deps, smaller)
#
# RUST_VERSION is the single source of truth for the toolchain pin; CI reads
# it from this ARG and injects it into the tag matrix.
#
# Bump RUST_VERSION when a controller dependency requires it.

ARG RUST_VERSION=1.95.0

FROM node:24-trixie-slim AS build

WORKDIR /build
ENV CI=true
COPY package.json pnpm-* tsconfig.base.json /build/
RUN corepack enable
RUN --mount=type=cache,target=/pnpm pnpm fetch

COPY . /build
RUN --mount=type=cache,target=/pnpm pnpm install --frozen-lockfile
RUN pnpm --filter=@telorun/cli... run build
RUN pnpm --filter=@telorun/cli --prod deploy --legacy /deploy
# `pnpm deploy` (unlike `pnpm publish`) leaves the `@telorun/debug-ui` devDep
# pinned at `workspace:*`, so the runtime CLI can't derive a version to fetch the
# on-demand inspect UI. Rewrite it to the concrete built version (what publish
# does) so `resolveUiBundle` fetches + caches the bundle from the CDN on first use.
RUN node -e "const fs=require('fs');const v=JSON.parse(fs.readFileSync('/build/packages/debug-ui/package.json','utf8')).version;const p='/deploy/package.json';const pkg=JSON.parse(fs.readFileSync(p,'utf8'));(pkg.devDependencies||(pkg.devDependencies={}))['@telorun/debug-ui']=v;fs.writeFileSync(p,JSON.stringify(pkg,null,2)+'\n');"

FROM node:24-trixie AS lean

COPY --from=build /deploy/ /opt/telo/
RUN ln -s /opt/telo/bin/telo.mjs /usr/local/bin/telo
WORKDIR /workspace
ENTRYPOINT ["telo"]

FROM node:24-trixie-slim AS lean-slim

COPY --from=build /deploy/ /opt/telo/
RUN ln -s /opt/telo/bin/telo.mjs /usr/local/bin/telo
WORKDIR /workspace
ENTRYPOINT ["telo"]

# Rust toolchain layered on top of the lean variants. Pinned via Debian's
# `rustup` package (no `curl | sh` from a third-party host), then
# `rustup default ${RUST_VERSION}` for an exact compiler.
#
# CARGO_TARGET_DIR points at /tmp so cargo build outputs stay container-internal
# instead of landing in a bind-mounted host path under the rust project dir.

FROM lean AS rust
ARG RUST_VERSION
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    CARGO_TARGET_DIR=/tmp/cargo-target \
    PATH=/usr/local/cargo/bin:$PATH

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gcc libc6-dev rustup \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p ${RUSTUP_HOME} ${CARGO_HOME} \
  && rustup default ${RUST_VERSION} \
  && chmod -R 0777 ${RUSTUP_HOME} ${CARGO_HOME}

FROM lean-slim AS rust-slim
ARG RUST_VERSION
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    CARGO_TARGET_DIR=/tmp/cargo-target \
    PATH=/usr/local/cargo/bin:$PATH

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gcc libc6-dev rustup \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p ${RUSTUP_HOME} ${CARGO_HOME} \
  && rustup default ${RUST_VERSION} \
  && chmod -R 0777 ${RUSTUP_HOME} ${CARGO_HOME}
