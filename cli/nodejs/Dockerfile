FROM node:24-slim as build

WORKDIR /build
ENV CI=true
COPY package.json pnpm-* tsconfig.base.json /build/
RUN corepack enable
RUN --mount=type=cache,target=/pnpm pnpm fetch

COPY . /build
RUN --mount=type=cache,target=/pnpm pnpm install --frozen-lockfile
RUN pnpm --filter=@telorun/cli... run build
RUN pnpm --filter=cli --prod deploy --legacy /deploy

FROM node:24-slim

WORKDIR /telo
COPY --from=build /deploy/ /telo/
ENV PATH="/telo/bin:$PATH"
RUN chmod +x /telo/bin/telo.mjs

ENTRYPOINT ["/telo/bin/telo.mjs"]



