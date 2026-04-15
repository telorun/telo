FROM node:24 as development

WORKDIR /app

RUN corepack enable

CMD ["pnpm", "run", "telo", "./apps/registry/telo.yaml"]

FROM development as build

WORKDIR /build

# Registry manifest
COPY apps/registry/telo.yaml apps/registry/telo.yaml

# Module definitions (controllers resolve from npm at boot)
COPY modules/type/telo.yaml modules/type/telo.yaml
COPY modules/http-server/telo.yaml modules/http-server/telo.yaml
COPY modules/http-client/telo.yaml modules/http-client/telo.yaml
COPY modules/config/telo.yaml modules/config/telo.yaml
COPY modules/s3/telo.yaml modules/s3/telo.yaml
COPY modules/sql/telo.yaml modules/sql/telo.yaml
COPY modules/run/telo.yaml modules/run/telo.yaml

CMD ["apps/registry/telo.yaml"]

FROM telorun/telo:nodejs as production

COPY --from=build /build /srv

CMD ["apps/registry/telo.yaml"]
