# Build context: the repository root (`docker build -f apps/hub-web/Dockerfile .`).

# Local development: the REPOSITORY is bind-mounted at /telo, with its
# dependencies already installed, and `server.mjs` runs Vite in middleware mode
# so edits apply without a restart.
FROM node:24-slim AS development

WORKDIR /telo/apps/hub-web

ENV NODE_ENV=development

USER node

CMD ["node", "server.mjs"]

FROM node:24-slim AS build

WORKDIR /telo

RUN corepack enable

COPY . .

RUN pnpm install --frozen-lockfile --filter @telorun/hub-web...
RUN pnpm --filter @telorun/hub-web run build
# A self-contained, hoisted node_modules for this one package, production
# dependencies only — so the image carries no Vite.
RUN pnpm deploy --legacy --filter=@telorun/hub-web --prod /out

FROM node:24-slim AS production

WORKDIR /app

COPY --from=build --chown=node:node /out ./
# Ignored by git, so `pnpm deploy` leaves it behind.
COPY --from=build --chown=node:node /telo/apps/hub-web/build ./build

ENV NODE_ENV=production PORT=8050

USER node

EXPOSE 8050
CMD ["node", "server.mjs"]
