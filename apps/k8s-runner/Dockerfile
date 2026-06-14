FROM node:24 AS development

WORKDIR /app

RUN corepack enable

CMD ["pnpm", "run", "--filter", "@telorun/k8s-runner", "dev"]

FROM development AS build

COPY . .

RUN pnpm install --frozen-lockfile
# `...` builds the @telorun/runner-core + @telorun/debug-wire workspace
# dependencies first; without it tsc / the runtime can't resolve their dist.
RUN pnpm run --filter @telorun/k8s-runner... build
# pnpm deploy produces a self-contained, hoisted node_modules for a single
# workspace package at /out, rewriting workspace:* deps and pruning devDeps.
RUN pnpm deploy --legacy --filter=@telorun/k8s-runner --prod /out

FROM node:24-slim AS production

WORKDIR /app
COPY --from=build /out ./

ENV PORT=8062
# No safe default for RUNNER_SELF_URL — every deployment must pass its own
# in-cluster service URL so session initContainers can fetch the bundle. The
# runner refuses to start when unset.

EXPOSE 8062
CMD ["node", "dist/server.js"]
