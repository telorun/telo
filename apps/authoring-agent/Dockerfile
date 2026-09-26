# Global build arg available in FROM lines below. Defaults to `latest` for
# local builds; CI overrides with the exact CLI release to pin reproducibly.
ARG TELO_NODE_VERSION=latest

# telorun/authoring-agent — the AI manifest-authoring agent as one self-contained
# image, built on the standard Telo CLI image. Every controller resolves
# from the registry, baked into the image by `telo install`. The runner launches
# this image PER SESSION; each container holds a private ./workspace, with the
# agent's SQLite DB under ./workspace/.telo-agent, and journal — that
# per-instance isolation is what makes it multi-user.
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

# WORKSPACE_DIR (default ./workspace) resolves against the process cwd, so run
# from the app dir where the manifest lives. The agent's state directory
# (AGENT_STATE_DIR, default ./workspace/.telo-agent) is created on first use.
WORKDIR /srv/telo-authoring-agent
RUN mkdir -p workspace

ENV PORT=8080
EXPOSE 8080

CMD ["telo", "telo.yaml"]
