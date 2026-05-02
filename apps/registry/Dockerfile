FROM node:24 as development

WORKDIR /app

RUN corepack enable

CMD ["pnpm", "run", "telo", "./apps/registry/telo.yaml"]

FROM telorun/telo:nodejs as build

WORKDIR /srv
ENV TELO_CACHE_DIR=/srv/.telo-cache

# Entry manifest
COPY apps/registry/telo.yaml apps/registry/telo.yaml

# Module definitions
COPY modules/type/telo.yaml modules/type/telo.yaml
COPY modules/http-server/telo.yaml modules/http-server/telo.yaml
COPY modules/http-client/telo.yaml modules/http-client/telo.yaml
COPY modules/config/telo.yaml modules/config/telo.yaml
COPY modules/s3/telo.yaml modules/s3/telo.yaml
COPY modules/sql/telo.yaml modules/sql/telo.yaml
COPY modules/run/telo.yaml modules/run/telo.yaml
COPY modules/codec/telo.yaml modules/codec/telo.yaml
COPY modules/octet-codec/telo.yaml modules/octet-codec/telo.yaml

# Pre-fetch every controller declared in the manifest graph so boot does
# no network I/O. Cache writes to $TELO_CACHE_DIR (/srv/.telo-cache).
RUN telo install apps/registry/telo.yaml

CMD ["apps/registry/telo.yaml"]

FROM telorun/telo:nodejs as production

WORKDIR /srv
ENV TELO_CACHE_DIR=/srv/.telo-cache
COPY --from=build /srv /srv

CMD ["apps/registry/telo.yaml"]
