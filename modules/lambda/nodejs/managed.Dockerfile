# syntax=docker/dockerfile:1.7
#
# Base image for AWS Lambda **managed** Node.js runtime.
# Published as `telorun/lambda-node-managed:<lambda-version>`.
#
# Pre-installs @telorun/lambda (and its workspace-pinned kernel/sdk deps) at
# /var/task. User images derive:
#
#   FROM telorun/lambda-node-managed:<lambda-version>
#   COPY telo.yaml ${LAMBDA_TASK_ROOT}/
#   COPY .telo/   ${LAMBDA_TASK_ROOT}/.telo/
#
# Build context: repo root. Build:
#   docker buildx build -f modules/lambda/nodejs/managed.Dockerfile .

ARG NODE_MAJOR=24

FROM node:${NODE_MAJOR}-trixie-slim AS build

WORKDIR /build
ENV CI=true
COPY package.json pnpm-* tsconfig.base.json /build/
RUN corepack enable
RUN --mount=type=cache,target=/pnpm pnpm fetch

COPY . /build
RUN --mount=type=cache,target=/pnpm pnpm install --frozen-lockfile
RUN pnpm --filter=@telorun/lambda... run build
RUN pnpm --filter=@telorun/lambda --prod deploy --legacy /deploy

FROM public.ecr.aws/lambda/nodejs:${NODE_MAJOR}

# /var/task is ${LAMBDA_TASK_ROOT}; AWS resolves `index.handler` here.
COPY --from=build /deploy/ /var/task/
COPY modules/lambda/nodejs/managed.mjs /var/task/index.mjs

CMD ["index.handler"]
