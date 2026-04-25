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
ARG RUST_VERSION=1.95.0
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gcc libc6-dev rustup \
  && rm -rf /var/lib/apt/lists/* \
  && rustup default ${RUST_VERSION} \
  && ln -s /root/.cargo/bin/cargo /usr/local/bin/cargo \
  && ln -s /root/.cargo/bin/rustc /usr/local/bin/rustc

COPY --from=build /deploy/ /opt/telo/
RUN ln -s /opt/telo/bin/telo.mjs /usr/local/bin/telo

WORKDIR /srv

ENTRYPOINT ["telo"]
