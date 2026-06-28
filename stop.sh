#!/usr/bin/env bash
#
# stop.sh — Stop the SlidySim Chat server.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/.chat-pids"

if [[ ! -f "$PID_FILE" ]]; then
  echo "SlidySim Chat is not running (no PID file found)."
  exit 0
fi

read -r CADDY_PID WS_PID < "$PID_FILE" 2>/dev/null || {
  echo "PID file corrupted. Cleaning up."
  rm -f "$PID_FILE"
  exit 0
}

echo "Stopping SlidySim Chat…"

KILLED_ANY=false
if [[ -n "${CADDY_PID:-}" ]] && kill -0 "$CADDY_PID" 2>/dev/null; then
  kill "$CADDY_PID" 2>/dev/null || true
  echo "  Caddy stopped (PID $CADDY_PID)"
  KILLED_ANY=true
fi
if [[ -n "${WS_PID:-}" ]] && kill -0 "$WS_PID" 2>/dev/null; then
  kill "$WS_PID" 2>/dev/null || true
  echo "  Server stopped (PID $WS_PID)"
  KILLED_ANY=true
fi

if [[ "$KILLED_ANY" == "true" ]]; then
  # Wait for graceful shutdown
  sleep 2
  # Force kill if still alive
  kill -9 "$CADDY_PID" 2>/dev/null || true
  kill -9 "$WS_PID" 2>/dev/null || true
fi

rm -f "$PID_FILE"
echo "Done."
