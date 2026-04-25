FROM node:24-trixie-slim as build

WORKDIR /build
ENV CI=true
COPY package.json pnpm-* tsconfig.base.json /build/
RUN corepack enable
RUN --mount=type=cache,target=/pnpm pnpm fetch

COPY . /build
RUN --mount=type=cache,target=/pnpm pnpm install --frozen-lockfile
RUN pnpm --filter=@telorun/cli... run build
RUN pnpm --filter=@telorun/cli --prod deploy --legacy /deploy

FROM node:24-trixie-slim as production

# Pin the Rust toolchain to a specific version for reproducible image builds.
# We install via Debian's `rustup` package (no `curl | sh` from a third-party
# host) and then ask rustup for the exact version we want — this avoids both
# the moving `stable` target and the supply-chain risk of piping a remote
# install script. Bump RUST_VERSION when a controller dependency requires it.
#
# RUSTUP_HOME / CARGO_HOME live under /usr/local so the toolchain is reachable
# from any UID at runtime — containers running as a non-root user (e.g.
# `--user 1000`) can't traverse /root, so the toolchain must not live there.
#
# Permissions: chowned to the documented runtime UID/GID (1000:1000, matching
# `pnpm run test:docker`'s `--user 1000`) with `g+rwX` so anyone in that group
# can use cargo. We deliberately do NOT add world-write — that's a footgun in
# any container that runs untrusted code, since it lets any process tamper
# with the toolchain. Other UIDs can still READ the toolchain (umask-default
# `o+rX` is preserved), so they can run `cargo`/`rustc`; only the cargo
# registry cache is locked to the 1000 group. Run as root or `--user 1000`
# for full functionality.
#
# CARGO_TARGET_DIR is a container-internal path so cargo never writes into the
# host-mounted `/srv/target` — that mount may carry files owned by other UIDs
# from earlier non-docker runs (e.g. CI's `pnpm run test` step), which would
# `EACCES` once the container runs as `--user 1000`. Trade-off: each
# container start rebuilds from scratch instead of sharing the host build
# cache. Chmod 1777 (sticky) on the parent so any UID can write its own files.
ARG RUST_VERSION=1.95.0
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    CARGO_TARGET_DIR=/tmp/cargo-target \
    PATH=/usr/local/cargo/bin:$PATH
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gcc libc6-dev rustup \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p ${RUSTUP_HOME} ${CARGO_HOME} \
  && rustup default ${RUST_VERSION} \
  && chown -R 1000:1000 ${RUSTUP_HOME} ${CARGO_HOME} \
  && chmod -R u+rwX,g+rwX ${RUSTUP_HOME} ${CARGO_HOME}

COPY --from=build /deploy/ /opt/telo/
RUN ln -s /opt/telo/bin/telo.mjs /usr/local/bin/telo

WORKDIR /srv

ENTRYPOINT ["telo"]
