#!/usr/bin/env bash
#
# status.sh — Show SlidySim Chat server status.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/.chat-pids"
URL_FILE="$SCRIPT_DIR/.chat-url"
LOG_FILE="$SCRIPT_DIR/chat.log"

echo "=== SlidySim Chat Status ==="
echo ""

if [[ ! -f "$PID_FILE" ]]; then
  echo "  State: NOT RUNNING"
  echo ""
  echo "  Start with: sudo ./start.sh --password \"SECRET\""
  exit 0
fi

read -r CADDY_PID WS_PID < "$PID_FILE" 2>/dev/null || {
  echo "  State: PID file corrupted. Run ./stop.sh to clean up."
  exit 1
}

URL=""
if [[ -f "$URL_FILE" ]]; then
  URL=$(cat "$URL_FILE")
fi

# Check processes
CADDY_ALIVE="no"
WS_ALIVE="no"
if [[ -n "${CADDY_PID:-}" ]] && kill -0 "$CADDY_PID" 2>/dev/null; then
  CADDY_ALIVE="yes"
fi
if [[ -n "${WS_PID:-}" ]] && kill -0 "$WS_PID" 2>/dev/null; then
  WS_ALIVE="yes"
fi

if [[ "$CADDY_ALIVE" == "yes" && "$WS_ALIVE" == "yes" ]]; then
  echo "  State: RUNNING"
else
  echo "  State: PARTIALLY RUNNING (one process died — run ./stop.sh then ./start.sh)"
fi
echo ""
echo "  Caddy  : $CADDY_ALIVE (PID $CADDY_PID)"
echo "  Server : $WS_ALIVE (PID $WS_PID)"
echo "  URL    : ${URL:-unknown}"
echo ""

# Show uptime for the Python server
if [[ "$WS_ALIVE" == "yes" ]]; then
  # Try to get process start time via ps
  START_TIME=$(ps -o lstart= -p "$WS_PID" 2>/dev/null || echo "unknown")
  if [[ "$START_TIME" != "unknown" ]]; then
    echo "  Server started: $START_TIME"
  fi
  echo ""

  # Health check (curl the health page)
  if [[ -n "$URL" ]]; then
    HOST="${URL#wss://}"
    HOST="${HOST%%/*}"
    echo "  Health check…"
    HEALTH=$(curl -sk --max-time 5 "https://$HOST/" 2>/dev/null || echo "FAILED")
    if [[ "$HEALTH" == "FAILED" ]]; then
      echo "    Result: unreachable (Caddy may still be provisioning certificate)"
      echo "    Wait 10-30s for first certificate, then try again."
    else
      CLIENTS=$(echo "$HEALTH" | grep -oE 'Connected clients</td><td>[0-9]+' | grep -oE '[0-9]+$' || echo "?")
      MSGS=$(echo "$HEALTH" | grep -oE 'Stored messages</td><td>[0-9]+' | grep -oE '[0-9]+' | head -1 || echo "?")
      UPTIME=$(echo "$HEALTH" | grep -oE 'Uptime</td><td>[0-9:]+' | grep -oE '[0-9:]+$' || echo "?")
      echo "    Uptime  : $UPTIME"
      echo "    Clients : $CLIENTS"
      echo "    Messages: $MSGS"
    fi
  fi
fi

echo ""
echo "  Log file: $LOG_FILE"
echo "  Stop with: ./stop.sh"
