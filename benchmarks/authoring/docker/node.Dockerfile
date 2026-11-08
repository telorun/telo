# The Node side: Node, npm and Claude Code, nothing else. Built from a context holding only this
# file as Dockerfile.
FROM node:24-bookworm
ARG CLAUDE_CODE_VERSION=2.1.319
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" && npm cache clean --force
RUN mkdir -p -m 777 /opt/claude-config /tmp/agent-home /work
ENV CLAUDE_CONFIG_DIR=/opt/claude-config HOME=/tmp/agent-home DISABLE_AUTOUPDATER=1
WORKDIR /work
