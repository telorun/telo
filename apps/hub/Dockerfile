# Global build arg available in FROM lines below. Defaults to `latest` for
# local builds; CI overrides with the exact CLI release to pin reproducibly.
ARG TELO_NODE_VERSION=latest

# Local development: the REPOSITORY is bind-mounted at /telo and the manifest is
# run through the WORKSPACE CLI, not the one baked into this image.
#
# The image ships the last RELEASED telo, so a manifest whose `requires: telo:`
# floor names the release currently in flight cannot boot in it — the load gate
# refusing it is correct, and a dev stack that could only run released code
# would be testing the registry rather than the tree. `hub-web` and `pages`
# already mount the repo for the same reason.
#
# The image's own CLI stays on PATH and is what `TELO_BIN` points at: the origin
# reads shell out to it for `telo module versions|digest|manifest` against
# THIRD-PARTY modules, which is a released-CLI job and much cheaper to spawn.
FROM telorun/node:${TELO_NODE_VERSION}-slim as development

WORKDIR /telo

RUN corepack enable

# The module cache, OUTSIDE the bind-mounted repo — `TELO_CACHE_DIR` points
# here, outranking the `telo-workspace.yaml` marker at the mount root, which
# would otherwise anchor it in the checkout. Created and chowned in the IMAGE so
# the volume compose mounts here inherits that ownership; a volume over a path
# the image does not have comes up root-owned, which a non-root container cannot
# write.
RUN mkdir -p /telo-cache && chown node:node /telo-cache

# Non-root, as the image's OWN user rather than the host's.
#
# Pinning the container to the host uid is the tempting version and it does not
# work: `UID`/`GID` are shell variables, not environment ones, so a compose
# `${UID:-1000}` is 1000 for everyone who does not explicitly export them — which
# reads as correct on a workstation whose checkout happens to be uid 1000 and
# fails anywhere it is not. `node` is a fixed identity this image defines, with a
# home corepack can write, and it needs nothing from the host: the repo is only
# READ through the mount, because everything written goes to the cache above.
USER node

CMD ["pnpm", "run", "--silent", "telo", "apps/hub/telo.yaml", "--watch"]

FROM telorun/node:${TELO_NODE_VERSION}-slim as build

WORKDIR /srv

# The entry manifest AND the six libraries it imports by relative path. The
# glob rather than `telo.yaml` alone: `telo install` walks the import graph, so
# a missing library is a build failure here rather than a runtime one — but only
# because the entry imports them, which is exactly the property a hand-listed
# set would lose the next time one is added.
COPY ./*.yaml ./

# Pre-fetch every controller declared in the manifest graph so boot does
# no network I/O. Cache writes to $TELO_CACHE_DIR (/srv/.telo-cache).
# NOTE: requires every import to resolve from the registry. Until
# vector-store-pgvector is published, its import in telo.yaml is a relative path
# (`../../modules/...`) that only resolves in the repo-mounted `development`
# target; flip it to `std/vector-store-pgvector@0.1.0` before building this
# stage. See README.md.
RUN telo install telo.yaml

FROM telorun/node:${TELO_NODE_VERSION}-slim as production

WORKDIR /srv
COPY --from=build /srv /srv

# The tracker fetches registered (eventually attacker-suppliable) refs through
# the telo CLI — refuse egress to private / loopback / link-local hosts. A
# guardrail only (redirects and DNS rebinding can slip past a check-then-fetch
# guard): the deployment's network-level egress policy is the actual boundary.
ENV TELO_EGRESS=public-only

CMD ["telo", "."]