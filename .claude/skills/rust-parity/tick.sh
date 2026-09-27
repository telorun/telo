#!/usr/bin/env bash
# One rust-parity tick, for cron: `0 */2 * * * <main-checkout>/.claude/skills/rust-parity/tick.sh`
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
main="$(dirname "$(git -C "$here" rev-parse --path-format=absolute --git-common-dir)")"
worktree="$main/.claude/worktrees/rust-parity"
state="$main/.claude/loops/rust-parity"
mkdir -p "$state/ticks"

export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  set +u
  . "$NVM_DIR/nvm.sh" >/dev/null
  set -u
fi
# A print-mode run otherwise abandons a subagent after 10 minutes of waiting on it.
export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0
export RUST_PARITY_STATE="$state" RUST_PARITY_MAIN="$main"

exec 9>"$state/tick.flock"
if ! flock -n 9; then
  echo "$(date -Is) skipped: the previous tick is still running" >>"$state/ticks/skipped.log"
  exit 0
fi

if [ ! -d "$worktree" ]; then
  git -C "$main" fetch origin main
  git -C "$main" worktree add --detach "$worktree" origin/main
fi

cd "$worktree"
claude -p "/rust-parity ${1:-}" --permission-mode auto \
  >"$state/ticks/$(date +%Y%m%dT%H%M%S).log" 2>&1
