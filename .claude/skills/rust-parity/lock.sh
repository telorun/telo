#!/usr/bin/env bash
# The tick lock: `lock.sh acquire` | `lock.sh release`. One tick at a time, however it was started.
# acquire exits 0 when this Claude process holds the lock, 3 when a live tick holds it.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
main="$(dirname "$(git -C "$here" rev-parse --path-format=absolute --git-common-dir)")"
state="$main/.claude/loops/rust-parity"
lock="$state/tick.lock"
mkdir -p "$state"

# The lock belongs to the Claude process running the tick, the nearest `claude` ancestor.
claude_pid() {
  local pid=$$
  while [ "$pid" -gt 1 ]; do
    if [ "$(ps -o comm= -p "$pid")" = "claude" ]; then
      echo "$pid"
      return
    fi
    pid="$(ps -o ppid= -p "$pid" | tr -d ' ')"
  done
  echo "lock.sh: no claude process among this shell's ancestors" >&2
  exit 1
}

alive() {
  [ "$(ps -o comm= -p "$1" 2>/dev/null)" = "claude" ]
}

me="$(claude_pid)"

case "${1:-}" in
  acquire)
    if mkdir "$lock" 2>/dev/null; then
      echo "$me $(date -Is)" >"$lock/owner"
      echo "acquired by $me"
      exit 0
    fi
    read -r pid started <"$lock/owner"
    if [ "$pid" = "$me" ]; then
      echo "already held by $me since $started"
      exit 0
    fi
    if alive "$pid"; then
      echo "busy: tick $pid running since $started"
      exit 3
    fi
    # Stale: only one contender's rename succeeds, so two ticks never both take it over.
    if ! mv "$lock" "$lock.stale.$me" 2>/dev/null || ! mkdir "$lock" 2>/dev/null; then
      echo "busy: another tick took over the stale lock of $pid"
      exit 3
    fi
    rm -rf "$lock.stale.$me"
    echo "$me $(date -Is)" >"$lock/owner"
    echo "took over the stale lock of $pid (started $started)"
    ;;
  release)
    if [ ! -f "$lock/owner" ]; then
      echo "lock.sh: release without a held lock" >&2
      exit 1
    fi
    read -r pid started <"$lock/owner"
    if [ "$pid" != "$me" ]; then
      echo "lock.sh: the lock is held by $pid, not $me" >&2
      exit 1
    fi
    rm -rf "$lock"
    echo "released by $me"
    ;;
  *)
    echo "usage: lock.sh acquire|release" >&2
    exit 2
    ;;
esac
