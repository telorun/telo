# The image a rust-parity tick runs in: the repo's toolchains, gh and claude, as a non-root user
# whose uid matches the host's, so files written to the mounted checkout keep their owner.
FROM node:24-bookworm

ARG UID=1000
ARG GID=1000
ARG PNPM_VERSION=10.28.2

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential ca-certificates curl git jq pkg-config python3 \
  && install -d -m 0755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g "pnpm@${PNPM_VERSION}" @anthropic-ai/claude-code \
  && git config --system credential.https://github.com.helper '!gh auth git-credential'

# node:24 ships a `node` user at uid 1000; the agent takes its place.
RUN userdel -r node \
  && groupadd -g "${GID}" agent \
  && useradd -m -u "${UID}" -g "${GID}" -s /bin/bash agent

USER agent
ENV CARGO_HOME=/home/agent/.cargo \
    RUSTUP_HOME=/home/agent/.rustup \
    CLAUDE_CONFIG_DIR=/home/agent/.claude \
    PATH=/home/agent/.cargo/bin:$PATH
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable \
  && mkdir -p /home/agent/.cargo/registry /home/agent/.cargo/git /home/agent/.local/share/pnpm /home/agent/.claude

COPY --chown=agent:agent entrypoint.sh /usr/local/bin/rust-parity-entrypoint
ENTRYPOINT ["/usr/local/bin/rust-parity-entrypoint"]
