# syntax=docker/dockerfile:1.7
#
# Multi-target Dockerfile for `telorun/node`. Three release variants share one
# builder stage so the monorepo compiles once:
#
#   lean       — node:24-trixie     + Telo CLI                     (default base)
#   lean-slim  — node:24-trixie-slim + Telo CLI                    (smaller footprint)
#   rust-slim  — lean-slim + rustup-pinned Rust toolchain           (native deps)
#
# There is no non-slim rust variant. The toolchain exists only so `pkg:cargo`
# controllers build at load, and that needs nothing from the fat base — which
# costs ~990 MB over the slim one. Both the `-rust-<ver>` and `-rust-<ver>-slim`
# tag sets are published from `rust-slim`.
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
COPY cli/nodejs/docker-entrypoint.sh /usr/local/bin/telo-entrypoint.sh
RUN ln -s /opt/telo/bin/telo.mjs /usr/local/bin/telo \
 && chmod +x /usr/local/bin/telo-entrypoint.sh
WORKDIR /workspace
# Smart entrypoint (mirrors node's docker-entrypoint.sh): a bare manifest path or
# flag is routed to `telo`, while `bash`/`node`/`telo …` run verbatim. A derived
# image can write `CMD ["telo", ".", "--watch"]` or the terse `CMD ["./telo.yaml"]`.
ENTRYPOINT ["telo-entrypoint.sh"]
CMD ["telo"]

FROM node:24-trixie-slim AS lean-slim

COPY --from=build /deploy/ /opt/telo/
COPY cli/nodejs/docker-entrypoint.sh /usr/local/bin/telo-entrypoint.sh
RUN ln -s /opt/telo/bin/telo.mjs /usr/local/bin/telo \
 && chmod +x /usr/local/bin/telo-entrypoint.sh
WORKDIR /workspace
ENTRYPOINT ["telo-entrypoint.sh"]
CMD ["telo"]

# Rust toolchain layered on the slim variant. Pinned via Debian's `rustup`
# package (no `curl | sh` from a third-party host), then
# `rustup default ${RUST_VERSION}` for an exact compiler.
#
# `profile minimal` is not an optimization detail — the default profile installs
# rust-docs, which is 796 MB of HTML the image can never serve, plus clippy and
# rustfmt, which nothing here invokes. Minimal is rustc + cargo + rust-std, which
# is all a `pkg:cargo` controller build needs (1.16 GB -> 580 MB).
#
# What is deleted afterwards is only what rustup itself treats as disposable:
# `share/` (15 MB of doc/man/completions, which nothing in a container reads) and
# rustup's own `downloads`/`tmp` caches, which `rustup update` cleans anyway. The
# `rustdoc` BINARY is deliberately kept — it belongs to the `rustc` component
# rustup tracks, and 13 MB is not worth making `cargo doc` fail.
#
# The C build environment is gcc + libc6-dev + make + pkg-config: a controller
# dependency using the `cc` crate needs a real C compiler (rust-lld cannot stand
# in), and a `-sys` crate's build.rs routinely shells out to make or pkg-config.
# make and pkg-config cost ~1 MB together. NOT included: git, python3, cmake — a
# dependency whose build needs one of those must vendor it or ship prebuilt.
#
# CARGO_TARGET_DIR points at /tmp so cargo build outputs stay container-internal
# instead of landing in a bind-mounted host path under the rust project dir.

FROM lean-slim AS rust-slim
ARG RUST_VERSION
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    CARGO_TARGET_DIR=/tmp/cargo-target \
    PATH=/usr/local/cargo/bin:$PATH

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates gcc libc6-dev make pkg-config rustup \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p ${RUSTUP_HOME} ${CARGO_HOME} \
  && rustup set profile minimal \
  && rustup default ${RUST_VERSION} \
  && rm -rf ${RUSTUP_HOME}/toolchains/*/share \
            ${RUSTUP_HOME}/downloads ${RUSTUP_HOME}/tmp \
  && chmod -R 0777 ${RUSTUP_HOME} ${CARGO_HOME}
