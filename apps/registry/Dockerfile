# Global build arg available in FROM lines below. Defaults to `latest` for
# local builds; CI overrides with the exact CLI release to pin reproducibly.
ARG TELO_NODE_VERSION=latest

FROM node:24 as development

WORKDIR /app

RUN corepack enable

CMD ["pnpm", "run", "telo", "./apps/registry/telo.yaml"]

FROM telorun/node:${TELO_NODE_VERSION}-slim as build

WORKDIR /srv

# Entry manifest
COPY apps/registry/telo.yaml apps/registry/telo.yaml

# Pre-fetch every controller declared in the manifest graph so boot does
# no network I/O. Cache writes to $TELO_CACHE_DIR (/srv/.telo-cache).
RUN telo install apps/registry/telo.yaml

CMD ["telo", "apps/registry/telo.yaml"]

FROM telorun/node:${TELO_NODE_VERSION}-slim as production

WORKDIR /srv
COPY --from=build /srv /srv

CMD ["telo", "apps/registry/telo.yaml"]
