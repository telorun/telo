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

# Rust toolchain for controllers that compile native deps at install time.
# Pinned via Debian's `rustup` package (no `curl | sh` from a third-party host),
# then `rustup default ${RUST_VERSION}` for an exact compiler. Bump
# RUST_VERSION when a controller dependency requires it.
#
# CARGO_TARGET_DIR points at /tmp so cargo build outputs stay container-internal
# instead of landing in a bind-mounted host path under the rust project dir.
ARG RUST_VERSION=1.95.0
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    CARGO_TARGET_DIR=/tmp/cargo-target \
    PATH=/usr/local/cargo/bin:$PATH

COPY --from=build /deploy/ /opt/telo/

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gcc libc6-dev rustup \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p ${RUSTUP_HOME} ${CARGO_HOME} \
  && rustup default ${RUST_VERSION} \
  && ln -s /opt/telo/bin/telo.mjs /usr/local/bin/telo
WORKDIR /workspace

ENTRYPOINT ["telo"]
