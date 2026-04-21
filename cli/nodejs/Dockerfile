FROM node:24-slim as build

WORKDIR /build
ENV CI=true
COPY package.json pnpm-* tsconfig.base.json /build/
RUN corepack enable
RUN --mount=type=cache,target=/pnpm pnpm fetch

COPY . /build
RUN --mount=type=cache,target=/pnpm pnpm install --frozen-lockfile
RUN pnpm --filter=@telorun/cli... run build
RUN pnpm --filter=@telorun/cli --prod deploy --legacy /deploy

FROM node:24-slim as production

COPY --from=build /deploy/ /opt/telo/
RUN ln -s /opt/telo/bin/telo.mjs /usr/local/bin/telo

WORKDIR /srv

ENTRYPOINT ["telo"]
