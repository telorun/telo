# The two container runners for the multi-runner integration test: the same
# workspace CLI on glibc and on musl.
#
# The CLI is not rebuilt here — `BUILDER` names the `build` stage of the shipped
# `cli/nodejs/Dockerfile`, already built by the test. Re-stating that recipe
# would give the test a second build to keep in step with the product one, and
# what this test needs is precisely the CLI that ships.
#
# One deploy artifact serves both bases because the CLI's production
# dependencies are pure JavaScript (esbuild is optional and loaded only when a
# controller is built from source, which a published module never needs). If
# that stops being true, each base needs its own build stage rather than a copy.
ARG BUILDER=telo-integration-build

FROM ${BUILDER} AS builder

FROM node:24-trixie-slim AS slim
COPY --from=builder /deploy/ /opt/telo/
RUN ln -s /opt/telo/bin/telo.mjs /usr/local/bin/telo
# HOME is writable by any --user the test runs as: npm insists on a home for its
# cache, and a container told to run as the host's uid has no entry in /etc/passwd.
ENV HOME=/tmp
WORKDIR /workspace
ENTRYPOINT ["telo"]

FROM node:24-alpine AS alpine
COPY --from=builder /deploy/ /opt/telo/
RUN ln -s /opt/telo/bin/telo.mjs /usr/local/bin/telo
ENV HOME=/tmp
WORKDIR /workspace
ENTRYPOINT ["telo"]
