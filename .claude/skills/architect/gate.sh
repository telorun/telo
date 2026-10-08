#!/bin/sh
# Usage: sh gate.sh <gate.md> <heading> <command>...
# Runs each command through `sh -c`, appends it with its full output and exit status to <gate.md>
# under "# <heading>", then prints one line per command. Exits 1 when any command failed, after
# running all of them.
set -u
[ "$#" -ge 3 ] || { echo "usage: gate.sh <gate.md> <heading> <command>..." >&2; exit 1; }
out=$1
heading=$2
shift 2
mkdir -p "$(dirname "$out")"
summary=""
failed=0
printf '\n# %s — %s\n' "$heading" "$(date -Is)" >>"$out"
for command in "$@"; do
  {
    printf '\n## `%s`\n\n```\n' "$command"
    sh -c "$command" 2>&1
    status=$?
    printf 'exit: %s\n```\n' "$status"
    echo "$status" >"$out.status"
  } >>"$out"
  status=$(cat "$out.status")
  rm -f "$out.status"
  [ "$status" = 0 ] || failed=1
  summary="$summary
exit $status  $command"
done
{
  printf '\n## `git diff HEAD --shortstat` and new files\n\n```\n'
  git diff HEAD --shortstat
  printf 'new files: %s\n```\n' "$(git ls-files --others --exclude-standard | wc -l)"
} >>"$out"
echo "$summary" | sed 1d
exit "$failed"
