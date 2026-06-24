#!/bin/sh
set -e

# Smart entrypoint, mirroring the official node image's docker-entrypoint.sh.
# Prepend `telo` when the first arg is a flag (`-…`), an unknown command, or a
# non-executable file — so a bare manifest path or flag reaches the CLI, while a
# real command (`telo`, `bash`, `sh`, `node`) runs verbatim as an escape hatch.
if [ "${1#-}" != "${1}" ] || [ -z "$(command -v "${1}")" ] || { [ -f "${1}" ] && ! [ -x "${1}" ]; }; then
  set -- telo "$@"
fi

exec "$@"
