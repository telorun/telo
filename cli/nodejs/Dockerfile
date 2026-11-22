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
#
# Every target runs as the base image's `node` user (uid/gid 1000, HOME
# /home/node) and owns /workspace, so a manifest, its `.telo` cache and a
# `TELO_HOST_STATE_DIR` volume need no root. A derived image that must install
# packages switches with `USER root` and back with `USER node`. There is no
# HEALTHCHECK: the image cannot know an application's route.

ARG RUST_VERSION=1.95.0

FROM node:24-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0 AS build

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
RUN set -eu; \
    set -- /deploy/node_modules/.pnpm/esbuild@*/node_modules/esbuild/package.json; \
    test "$#" -eq 1 && test -f "$1"; \
    node -p "require(process.argv[1]).version" "$1" > /build/esbuild-version

# esbuild's published binary is built with a Go release older than the standard library's security
# fixes. The same esbuild release, fetched through the checksum-verified module proxy and built with a
# current Go, replaces it in the deployed tree, so the bundles it writes are unchanged.
FROM --platform=$BUILDPLATFORM golang:1.27-trixie@sha256:f18c3d73a184fb0582828510722e723b63a93f7188d11dd223d9be6f6880e65d AS esbuild
ARG TARGETOS
ARG TARGETARCH
COPY --from=build /build/esbuild-version /esbuild-version
WORKDIR /module
RUN version="$(cat /esbuild-version)" \
 && go mod init esbuild-binary \
 && go get "github.com/evanw/esbuild/cmd/esbuild@v${version}" \
 && CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" \
    go build -trimpath -ldflags=-s -o /out/esbuild github.com/evanw/esbuild/cmd/esbuild

FROM node:24-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0 AS deploy
COPY --from=build /deploy/ /opt/telo/
COPY --from=esbuild /out/esbuild /tmp/esbuild
COPY --from=build /build/esbuild-version /tmp/esbuild-version
RUN set -eu; \
    expected="$(cat /tmp/esbuild-version)"; \
    replaced=0; \
    for binary in /opt/telo/node_modules/.pnpm/@esbuild+*/node_modules/@esbuild/*/bin/esbuild; do \
      install -m 0755 /tmp/esbuild "$binary"; \
      test "$("$binary" --version)" = "$expected"; \
      replaced=$((replaced + 1)); \
    done; \
    test "$replaced" -eq 1; \
    for copy in /opt/telo/node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild; do \
      if [ "$(head -c 4 "$copy" | od -An -c | tr -d ' ')" = '177ELF' ]; then \
        install -m 0755 /tmp/esbuild "$copy"; \
      fi; \
    done; \
    rm /tmp/esbuild /tmp/esbuild-version

FROM node:24-trixie@sha256:6e5d4c38403930b420404f190be8563396dca2bd156a6cb4722707b0efcf6fc1 AS lean

# The bases are rebuilt upstream less often than Debian publishes fixes, so the release
# scan would refuse them between rebuilds.
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && rm -rf /var/lib/apt/lists/*
# The base image's npm bundles dependencies fixed only in a later npm 11 release.
RUN npm install -g npm@^11.21.3 && npm cache clean --force
COPY --from=deploy /opt/telo/ /opt/telo/
COPY cli/LICENSE /opt/telo/LICENSE
COPY cli/nodejs/docker-entrypoint.sh /usr/local/bin/telo-entrypoint.sh
RUN ln -s /opt/telo/bin/telo.mjs /usr/local/bin/telo \
 && chmod +x /usr/local/bin/telo-entrypoint.sh
# Created and chowned before USER so a volume mounted here inherits the owner.
RUN mkdir -p /workspace && chown node:node /workspace
WORKDIR /workspace
USER node
# Smart entrypoint (mirrors node's docker-entrypoint.sh): a bare manifest path or
# flag is routed to `telo`, while `bash`/`node`/`telo …` run verbatim. A derived
# image can write `CMD ["telo", "--watch", "."]` or the terse `CMD ["./telo.yaml"]`.
ENTRYPOINT ["telo-entrypoint.sh"]
CMD ["telo"]

FROM node:24-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0 AS lean-slim

RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g npm@^11.21.3 && npm cache clean --force
COPY --from=deploy /opt/telo/ /opt/telo/
COPY cli/LICENSE /opt/telo/LICENSE
COPY cli/nodejs/docker-entrypoint.sh /usr/local/bin/telo-entrypoint.sh
RUN ln -s /opt/telo/bin/telo.mjs /usr/local/bin/telo \
 && chmod +x /usr/local/bin/telo-entrypoint.sh
# Created and chowned before USER so a volume mounted here inherits the owner.
RUN mkdir -p /workspace && chown node:node /workspace
WORKDIR /workspace
USER node
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
USER root
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

# Back to the unprivileged user; the toolchain stays world-writable so a
# `pkg:cargo` build works under any uid a runtime assigns.
USER node
