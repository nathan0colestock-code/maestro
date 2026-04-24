#!/usr/bin/env bash
# Nightly reflection agent — runs at 23:30 local, after the improvement
# agent has finished at 23:00. Uses `claude -p` (local macOS auth).
set -eu

SUITE_LOG_DIR="$HOME/Library/Logs/suite"
mkdir -p "$SUITE_LOG_DIR"

ENV_FILE="$HOME/Library/Application Support/maestro/env"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
fi

cd "$(dirname "$0")/../.."
exec /usr/bin/env node local/reflection-agent.js
