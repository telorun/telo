# Global build arg available in FROM lines below. Defaults to `latest` for
# local builds; CI overrides with the exact CLI release to pin reproducibly.
ARG TELO_NODE_VERSION=latest

# telorun/authoring-agent — the AI manifest-authoring agent as one self-contained
# image, built on the standard Telo CLI image. Every controller resolves
# from the registry, baked into the image by `telo install`. The runner launches
# this image PER SESSION; each container holds a private ./workspace and the
# agent's own state directory (its SQLite DB and journal) — that per-instance
# isolation is what makes it multi-user.
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
# Owned by `node` (uid 1000, the user a runner runs the image as): the kernel
# writes into the baked .telo cache at start (controller shims, parse and CEL
# caches), and a root-owned copy fails every kind with EACCES.
COPY --from=build --chown=node:node /build /srv

# WORKSPACE_DIR (default ./workspace) resolves against the process cwd, so run
# from the app dir where the manifest lives.
WORKDIR /srv/telo-authoring-agent
RUN mkdir -p workspace

# The agent's state is a durable directory need. A container run on its own
# gets it under this host state directory (`needs/agentState`, created at
# load); a runner sets TELO_HOST_STATE_DIR to session storage of its own, and
# AGENT_STATE_DIR names the directory outright. Owned by `node` (uid 1000),
# the user the runners run the agent as.
RUN mkdir -p /var/lib/telo-agent && chown node:node /var/lib/telo-agent
ENV TELO_HOST_STATE_DIR=/var/lib/telo-agent

ENV PORT=8080
EXPOSE 8080

CMD ["telo", "telo.yaml"]
