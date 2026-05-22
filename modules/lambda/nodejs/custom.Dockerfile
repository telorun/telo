# syntax=docker/dockerfile:1.7
#
# Base image for AWS Lambda **custom** runtime.
# Published as `telorun/lambda-node-custom:<lambda-version>`.
#
# Used when the managed runtime's invocation envelope is too restrictive —
# e.g. response streaming, long poll loops, custom Function bootstrapping.
# The Lambda.Function controller observes $AWS_LAMBDA_RUNTIME_API at run()
# and drives the AWS Runtime API poll loop itself.
#
# Pre-installs @telorun/lambda at /var/task and wires `custom.mjs` as the
# entrypoint. Node is copied from AWS's own managed nodejs image to keep
# the runtime version in lock-step with the managed variant.
#
# User images derive:
#   FROM telorun/lambda-node-custom:<lambda-version>
#   COPY telo.yaml ${LAMBDA_TASK_ROOT}/
#   COPY .telo/   ${LAMBDA_TASK_ROOT}/.telo/
#
# Build context: repo root. Build:
#   docker buildx build -f modules/lambda/nodejs/custom.Dockerfile .

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

# Source node from AWS's own managed nodejs image so glibc/dynamic-linker
# layout matches the al2023 base byte-for-byte.
FROM public.ecr.aws/lambda/nodejs:${NODE_MAJOR} AS node-source

FROM public.ecr.aws/lambda/provided:al2023

COPY --from=node-source /var/lang /var/lang
ENV PATH="/var/lang/bin:${PATH}"

COPY --from=build /deploy/ /var/task/
COPY modules/lambda/nodejs/custom.mjs /var/task/bootstrap
RUN chmod +x /var/task/bootstrap

WORKDIR /var/task
ENTRYPOINT ["/var/task/bootstrap"]
