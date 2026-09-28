#!/usr/bin/env bash
# Container entrypoint: commits carry the user's identity from the env file, then the command runs.
set -euo pipefail

: "${GIT_USER_NAME:?GIT_USER_NAME must be set in the env file}"
: "${GIT_USER_EMAIL:?GIT_USER_EMAIL must be set in the env file}"
git config --global user.name "$GIT_USER_NAME"
git config --global user.email "$GIT_USER_EMAIL"

exec "$@"
