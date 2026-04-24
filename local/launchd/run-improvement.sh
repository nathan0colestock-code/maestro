#!/usr/bin/env bash
# Nightly improvement agent. Runs once at 23:00 via LaunchAgent.
set -eu

SUITE_LOG_DIR="$HOME/Library/Logs/suite"
mkdir -p "$SUITE_LOG_DIR"

ENV_FILE="$HOME/Library/Application Support/maestro/env"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
fi

cd "$(dirname "$0")/../.."
exec /usr/bin/env node local/improvement-agent.js
