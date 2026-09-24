#!/bin/sh
# Starts the Lody daemon with the CLI token, then drops the token from the environment before
# the HTTP bridge starts. The token and the daemon's output are never echoed.
set -eu

if [ -n "${LODY_CLI_TOKEN:-}" ]; then
  if lody daemon start --auth "$LODY_CLI_TOKEN" --machine-name "${LODY_MACHINE_NAME:-cos-tool-bot-server}" >/dev/null 2>&1; then
    echo "lody-bridge: daemon started"
  else
    echo "lody-bridge: daemon start failed; inspect with 'lody daemon logs' in this container" >&2
  fi
else
  echo "lody-bridge: LODY_CLI_TOKEN is empty; daemon not started" >&2
fi
unset LODY_CLI_TOKEN

exec node /opt/lody-bridge/server.mjs
