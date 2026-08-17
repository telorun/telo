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

# The kernel image spawned for each session, baked at build time so a runner's
# tested kernel and its runtime kernel are the same artifact. The default was a
# mutable `telorun/node:latest-slim`, which made the session kernel whatever was
# last released — that is how a 0.74.0 kernel ended up running a module published
# against 0.76.0, failing with four unresolvable-$ref schema errors. CI passes the
# CLI version this image was built against; an operator can still override with
# RUNNER_IMAGE (Helm: `session.image`).
ARG TELO_SESSION_IMAGE=telorun/node:latest-slim
ENV RUNNER_IMAGE=${TELO_SESSION_IMAGE}

ENV PORT=8062
# No safe default for RUNNER_SELF_URL — every deployment must pass its own
# in-cluster service URL so session initContainers can fetch the bundle. The
# runner refuses to start when unset.

EXPOSE 8062
CMD ["node", "dist/server.js"]
