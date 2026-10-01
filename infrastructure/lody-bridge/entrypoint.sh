#!/bin/sh
# Starts the Lody daemon, then drops the CLI token from the environment before the HTTP bridge
# starts. The login saved in ~/.lody (a volume) is tried first so the token only reaches argv on
# the first boot or after it was rotated. The token and the daemon's output are never echoed.
set -eu
export PATH="$HOME/.lody/cli/current/node_modules/.bin:$PATH"

machine="${LODY_MACHINE_NAME:-cos-tool-bot-server}"
if timeout 120 lody daemon start --machine-name "$machine" </dev/null >/dev/null 2>&1; then
  echo "lody-bridge: daemon started with the saved login"
elif [ -n "${LODY_CLI_TOKEN:-}" ]; then
  if timeout 120 lody daemon start --auth "$LODY_CLI_TOKEN" --machine-name "$machine" </dev/null >/dev/null 2>&1; then
    echo "lody-bridge: daemon started"
  else
    echo "lody-bridge: daemon start failed; inspect with 'lody daemon logs' in this container" >&2
  fi
else
  echo "lody-bridge: no saved login and LODY_CLI_TOKEN is empty; daemon not started" >&2
fi
unset LODY_CLI_TOKEN

exec node /opt/lody-bridge/server.mjs
