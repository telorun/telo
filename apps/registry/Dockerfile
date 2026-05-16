FROM node:24 as development

WORKDIR /app

RUN corepack enable

CMD ["pnpm", "run", "telo", "./apps/registry/telo.yaml"]

FROM telorun/telo:nodejs as build

WORKDIR /srv

# Entry manifest
COPY apps/registry/telo.yaml apps/registry/telo.yaml

# Pre-fetch every controller declared in the manifest graph so boot does
# no network I/O. Cache writes to $TELO_CACHE_DIR (/srv/.telo-cache).
RUN telo install apps/registry/telo.yaml

CMD ["apps/registry/telo.yaml"]

FROM telorun/telo:nodejs as production

WORKDIR /srv
COPY --from=build /srv /srv

CMD ["apps/registry/telo.yaml"]
