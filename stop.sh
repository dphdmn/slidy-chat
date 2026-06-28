#!/usr/bin/env bash
#
# stop.sh — Stop the SlidySim Chat server.
#
# Usage:
#   ./stop.sh              — stop our tracked processes
#   ./stop.sh --kill-all   — kill ALL our chat processes (server.py + caddy
#                            running our Caddyfile). Does NOT kill foreign
#                            processes like OpenVPN or nginx.
#
# SAFETY: This script only kills processes it can identify as ours:
#   - python3 running OUR server.py
#   - caddy running OUR Caddyfile
# It NEVER kills processes just because they're on a port.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/.chat-pids"

# ---- helpers ----
find_our_python() {
  pgrep -f "python3.*${SCRIPT_DIR}/server.py" 2>/dev/null || true
}
find_our_caddy() {
  pgrep -f "caddy run.*${SCRIPT_DIR}/Caddyfile" 2>/dev/null || true
}

kill_pids() {
  local pids="$1"
  local label="$2"
  if [[ -z "$pids" ]]; then return; fi
  echo "  Stopping $label (PID: $pids)…"
  for p in $pids; do
    kill "$p" 2>/dev/null || true
  done
  sleep 2
  for p in $pids; do
    if kill -0 "$p" 2>/dev/null; then
      echo "  Force-killing $p…"
      kill -9 "$p" 2>/dev/null || true
    fi
  done
}

KILL_ALL=0
if [[ "${1:-}" == "--kill-all" ]]; then
  KILL_ALL=1
fi

echo "Stopping SlidySim Chat…"

if [[ "$KILL_ALL" -eq 1 ]]; then
  # Kill ALL our processes (by command-line pattern, not by port)
  echo " (--kill-all: killing all our chat processes)"
  kill_pids "$(find_our_python)" "Python chat servers"
  kill_pids "$(find_our_caddy)" "Caddy instances (ours)"
  rm -f "$PID_FILE"
  echo "Done."
  exit 0
fi

# Normal mode: kill tracked PIDs
if [[ ! -f "$PID_FILE" ]]; then
  echo "  No PID file found."
  # Check if our processes are running anyway
  FOUND_PY=$(find_our_python)
  FOUND_CADDY=$(find_our_caddy)
  if [[ -n "$FOUND_PY" ]] || [[ -n "$FOUND_CADDY" ]]; then
    echo "  But found our processes still running:"
    [[ -n "$FOUND_PY" ]]    && echo "    Python: $FOUND_PY"
    [[ -n "$FOUND_CADDY" ]] && echo "    Caddy: $FOUND_CADDY"
    echo "  Run './stop.sh --kill-all' to stop them."
  fi
  exit 0
fi

read -r CADDY_PID WS_PID < "$PID_FILE" 2>/dev/null || {
  echo "  PID file corrupted. Cleaning up."
  rm -f "$PID_FILE"
  exit 0
}

KILLED_ANY=false
if [[ -n "${CADDY_PID:-}" ]] && kill -0 "$CADDY_PID" 2>/dev/null; then
  kill_pids "$CADDY_PID" "Caddy"
  KILLED_ANY=true
fi
if [[ -n "${WS_PID:-}" ]] && kill -0 "$WS_PID" 2>/dev/null; then
  kill_pids "$WS_PID" "Python server"
  KILLED_ANY=true
fi

rm -f "$PID_FILE"

if [[ "$KILLED_ANY" != "true" ]]; then
  echo "  Tracked processes not found. Checking for orphans…"
  FOUND_PY=$(find_our_python)
  FOUND_CADDY=$(find_our_caddy)
  if [[ -n "$FOUND_PY" ]] || [[ -n "$FOUND_CADDY" ]]; then
    echo "  Found orphaned processes:"
    [[ -n "$FOUND_PY" ]]    && echo "    Python: $FOUND_PY"
    [[ -n "$FOUND_CADDY" ]] && echo "    Caddy: $FOUND_CADDY"
    echo "  Run './stop.sh --kill-all' to stop them."
  fi
fi

echo "Done."
