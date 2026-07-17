# Global build arg available in FROM lines below. Defaults to `latest` for
# local builds; CI overrides with the exact CLI release to pin reproducibly.
ARG TELO_NODE_VERSION=latest

FROM node:24 as development

WORKDIR /app

RUN corepack enable

CMD ["pnpm", "run", "telo", "./apps/hub/telo.yaml"]

FROM telorun/node:${TELO_NODE_VERSION}-slim as build

WORKDIR /srv

# Entry manifest
COPY apps/hub/telo.yaml apps/hub/telo.yaml

# Pre-fetch every controller declared in the manifest graph so boot does
# no network I/O. Cache writes to $TELO_CACHE_DIR (/srv/.telo-cache).
RUN telo install apps/hub/telo.yaml

CMD ["telo", "apps/hub/telo.yaml"]

FROM telorun/node:${TELO_NODE_VERSION}-slim as production

WORKDIR /srv
COPY --from=build /srv /srv

# The tracker fetches registered (eventually attacker-suppliable) refs through
# the telo CLI — refuse egress to private / loopback / link-local hosts. A
# guardrail only (redirects and DNS rebinding can slip past a check-then-fetch
# guard): the deployment's network-level egress policy is the actual boundary.
ENV TELO_EGRESS=public-only

CMD ["telo", "apps/hub/telo.yaml"]
