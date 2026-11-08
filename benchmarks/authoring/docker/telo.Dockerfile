# The Telo side: Node, the published telo CLI at the release under test, Claude Code, the
# authoring primer (the agent's user memory) and an MCP config for the hub. Built from a context
# the harness assembles: this file as Dockerfile, primer.md and mcp.json beside it.
FROM node:24-bookworm
ARG CLAUDE_CODE_VERSION=2.1.319
ARG TELO_VERSION
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@telorun/cli@${TELO_VERSION}" \
 && npm cache clean --force
RUN mkdir -p -m 777 /opt/claude-config /tmp/agent-home /work
COPY primer.md /opt/claude-config/CLAUDE.md
COPY mcp.json /opt/agent/mcp.json
ENV CLAUDE_CONFIG_DIR=/opt/claude-config HOME=/tmp/agent-home DISABLE_AUTOUPDATER=1
WORKDIR /work
