#!/bin/sh
# Usage: sh tree-snapshot.sh save <id-file>
#        sh tree-snapshot.sh diff <id-file> [git diff options]
# save records the working tree — tracked changes and untracked files — as a git tree object and
# writes its id to <id-file>. diff prints what changed in the working tree since that snapshot,
# leaving out .claude/loops. Neither touches the index, HEAD or any ref, and neither creates a
# commit: the tree is built in a throwaway index.
set -eu
[ "$#" -ge 2 ] || { echo "usage: tree-snapshot.sh save|diff <id-file> [git diff options]" >&2; exit 1; }
mode=$1
file=$2
shift 2

index=$(mktemp)
trap 'rm -f "$index"' EXIT
cp "$(git rev-parse --git-path index)" "$index"
GIT_INDEX_FILE=$index git add -A
tree=$(GIT_INDEX_FILE=$index git write-tree)

case $mode in
  save)
    mkdir -p "$(dirname "$file")"
    echo "$tree" >"$file"
    echo "snapshot $tree written to $file"
    ;;
  diff)
    git diff "$(cat "$file")" "$tree" "$@" -- ':(top)' ':(top,exclude).claude/loops'
    ;;
  *)
    echo "tree-snapshot.sh: unknown mode '$mode'" >&2
    exit 1
    ;;
esac
