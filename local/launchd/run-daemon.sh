#!/usr/bin/env bash
# Maestro daemon supervisor. Sources secrets, rotates logs, execs daemon.js.
# Called by com.maestro.daemon.plist; LaunchAgent keeps it respawning.
set -eu

SUITE_LOG_DIR="$HOME/Library/Logs/suite"
mkdir -p "$SUITE_LOG_DIR"

# Rotate big logs (>50MB, keep 3) so the laptop disk doesn't fill from a
# stuck daemon.
rotate() {
  local f="$1"
  [ -f "$f" ] || return 0
  local size
  size=$(stat -f%z "$f" 2>/dev/null || echo 0)
  if [ "$size" -gt $((50*1024*1024)) ]; then
    for i in 2 1; do [ -f "${f}.${i}" ] && mv "${f}.${i}" "${f}.$((i+1))"; done
    mv "$f" "${f}.1"
  fi
}
rotate "$SUITE_LOG_DIR/maestro-daemon.log"
rotate "$SUITE_LOG_DIR/maestro-daemon.err.log"

# Secrets live outside the repo. Never check this file in.
ENV_FILE="$HOME/Library/Application Support/maestro/env"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
fi

cd "$(dirname "$0")/.."
exec /usr/bin/env node daemon.js
