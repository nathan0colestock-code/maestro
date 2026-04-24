#!/usr/bin/env bash
# Self-improvement auto-PR runner — fires at 23:45 local, after reflection.
# MAESTRO_SELF_IMPROVE_DRY=true by default in the plist so the first live
# run is observable without opening PRs.
set -eu

SUITE_LOG_DIR="$HOME/Library/Logs/suite"
mkdir -p "$SUITE_LOG_DIR"

ENV_FILE="$HOME/Library/Application Support/maestro/env"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
fi

cd "$(dirname "$0")/../.."
exec /usr/bin/env node local/auto-pr.js
