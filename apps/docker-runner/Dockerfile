FROM node:24 AS development

WORKDIR /app

RUN corepack enable

CMD ["pnpm", "run", "--filter", "@telorun/docker-runner", "dev"]

FROM development AS build

COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm run --filter @telorun/docker-runner build
# pnpm deploy produces a self-contained, hoisted node_modules for a single
# workspace package at /out, rewriting workspace:* deps and pruning devDeps.
# Sidesteps the isolated-node-linker / symlinked-store issue in a
# single-stage copy.
RUN pnpm deploy --legacy --filter=@telorun/docker-runner --prod /out

FROM node:24-slim AS production

WORKDIR /app
COPY --from=build /out ./

ENV PORT=8061 BUNDLE_ROOT=/bundles
# Deliberately NO `VOLUME ["/bundles"]`:
# A VOLUME directive makes Docker auto-create an anonymous volume at /bundles
# if the operator runs the image without -v <named>:/bundles. That anonymous
# volume is invisible to spawned sibling containers, which then see an empty
# /srv. The runner's boot-time BUNDLE_VOLUME check is the sole enforcement
# point.
# Deliberately NO default BUNDLE_VOLUME / RUNNER_CHILD_NETWORK in ENV:
# There is no safe default. Every deployment mode (compose / standalone) must
# make a deliberate choice and pass it in; the runner refuses to start when
# unset.

EXPOSE 8061
CMD ["node", "dist/server.js"]
