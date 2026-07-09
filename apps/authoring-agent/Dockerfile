# Global build arg available in FROM lines below. Defaults to `latest` for
# local builds; CI overrides with the exact CLI release to pin reproducibly.
ARG TELO_NODE_VERSION=latest

# telorun/authoring-agent — the AI manifest-authoring agent as one self-contained
# image, built on the standard Telo CLI image. Every controller resolves
# from the registry, baked into the image by `telo install`. The runner launches
# this image PER SESSION; each container holds a private ./workspace, SQLite DB,
# and journal — that per-instance isolation is what makes it multi-user.
#
# Runtime: inject OPENAI_API_KEY (BUDGET_LIMIT optional), listen on $PORT
# (default 8080).

FROM telorun/node:${TELO_NODE_VERSION}-slim as build

WORKDIR /build

COPY . ./telo-authoring-agent

# Pre-fetch every controller declared in the manifest graph so boot does
# no network I/O. Cache is baked under telo-authoring-agent/.telo.
RUN telo install ./telo-authoring-agent

FROM telorun/node:${TELO_NODE_VERSION}-slim as production

WORKDIR /srv
COPY --from=build /build /srv

# The fs tools root at ./workspace and the SQLite DB under ./tmp resolve against
# the process cwd, so run from the app dir where the manifest lives.
WORKDIR /srv/telo-authoring-agent
RUN mkdir -p workspace tmp

ENV PORT=8080
EXPOSE 8080

CMD ["telo", "telo.yaml"]
