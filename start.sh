#!/usr/bin/env bash
#
# start.sh — Start SlidySim Chat in the BACKGROUND (survives terminal close).
#
# Usage:
#   sudo ./start.sh --password "USER_SECRET" [--admin-password "ADMIN_SECRET"]
#                   [--domain my.example.com] [--port 443] [--ws-port 8080]
#
# SAFETY: This script only kills processes it can identify as ours
# (caddy running OUR Caddyfile, or python3 running OUR server.py).
# It NEVER kills processes just because they're on a port — that would
# risk killing OpenVPN, nginx, or other services on your VPS.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PID_FILE="$SCRIPT_DIR/.chat-pids"
URL_FILE="$SCRIPT_DIR/.chat-url"
LOG_FILE="$SCRIPT_DIR/chat.log"

# ---- helper: find PIDs of OUR processes only ----
# Matches: python3 .../server.py (with our path)
find_our_python() {
  pgrep -f "python3.*${SCRIPT_DIR}/server.py" 2>/dev/null || true
}
# Matches: caddy run --config .../Caddyfile (with our path)
find_our_caddy() {
  pgrep -f "caddy run.*${SCRIPT_DIR}/Caddyfile" 2>/dev/null || true
}

# ---- helper: check if a port is in use (and by whom) ----
port_owner() {
  local port="$1"
  # Try ss first (more common)
  local info
  info=$(ss -tlnp 2>/dev/null | grep ":${port} " | head -1 || true)
  if [[ -n "$info" ]]; then
    echo "$info"
    return
  fi
  # Fallback to lsof
  info=$(lsof -i :"$port" -sTCP:LISTEN 2>/dev/null | tail -n +2 | head -1 || true)
  if [[ -n "$info" ]]; then
    echo "$info"
    return
  fi
  return 1
}

# ---- parse args ----
PASSWORD="${CHAT_PASSWORD:-}"
ADMIN_PASSWORD="${CHAT_ADMIN_PASSWORD:-}"
DOMAIN=""
CADDY_PORT="443"
WS_PORT="8080"
FORCE_CLEAN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --password)        PASSWORD="$2"; shift 2 ;;
    --admin-password)  ADMIN_PASSWORD="$2"; shift 2 ;;
    --domain)          DOMAIN="$2"; shift 2 ;;
    --port)            CADDY_PORT="$2"; shift 2 ;;
    --ws-port)         WS_PORT="$2"; shift 2 ;;
    --force)           FORCE_CLEAN=1; shift ;;
    -h|--help)
      cat <<'EOF'
SlidySim Chat — start in background

Usage:
  sudo ./start.sh --password "SECRET" [options]

Options:
  --password PW       User chat password (required)
  --admin-password PW Admin panel password (optional, enables /admin)
  --domain DOMAIN     Your domain (e.g. chat.example.com). If omitted,
                      auto-generates <ip>.nip.io (free wildcard DNS)
  --port N            Caddy HTTPS port (default 443; use 8443 if not root)
  --ws-port N         Internal Python server port (default 8080)
  --force             Kill OUR previous processes if found, then start

SAFETY: Only kills processes identified as ours (our server.py / our
Caddyfile). Never kills processes just because they're on a port.

The server runs in the background via nohup. Close your terminal freely.
  ./status.sh  — check if running
  ./stop.sh    — stop the server
  chat.log     — view logs
EOF
      exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -z "$PASSWORD" ]]; then
  echo "Error: --password is required."
  echo 'Use: sudo ./start.sh --password "YOUR_SECRET"'
  exit 1
fi

if ! command -v python3 &>/dev/null; then
  echo "Error: python3 is not installed. Run ./install.sh first."
  exit 1
fi

if ! command -v caddy &>/dev/null; then
  echo "Error: caddy is not installed. Run ./install.sh first."
  exit 1
fi

if [[ "$CADDY_PORT" -lt 1024 ]] && [[ "$(id -u)" -ne 0 ]]; then
  echo "Error: Caddy port $CADDY_PORT requires root."
  echo "  Use sudo, or: --port 8443"
  exit 1
fi

# ---- check for OUR previous processes (from a crashed/aborted run) ----
OUR_PY=$(find_our_python)
OUR_CADDY=$(find_our_caddy)

if [[ -n "$OUR_PY" ]] || [[ -n "$OUR_CADDY" ]]; then
  echo "Found our previous processes still running:"
  [[ -n "$OUR_PY" ]]     && echo "  Python server PID(s): $OUR_PY"
  [[ -n "$OUR_CADDY" ]]  && echo "  Caddy PID(s): $OUR_CADDY"
  echo ""
  if [[ "$FORCE_CLEAN" -eq 1 ]]; then
    echo "--force given, stopping them…"
    for p in $OUR_PY $OUR_CADDY; do
      kill "$p" 2>/dev/null || true
    done
    sleep 2
    for p in $OUR_PY $OUR_CADDY; do
      kill -9 "$p" 2>/dev/null || true
    done
    sleep 1
  else
    echo "Options:"
    echo "  1. Run ./stop.sh first (stops them cleanly)"
    echo "  2. Run with --force (stops them, then starts)"
    echo "  3. Run ./stop.sh --kill-all (kills all our chat processes)"
    echo ""
    echo "Aborting."
    exit 1
  fi
fi

# Also clean up stale PID file
if [[ -f "$PID_FILE" ]]; then
  rm -f "$PID_FILE"
fi

# ---- check if our target ports are free (but DON'T kill unknown processes) ----
WS_BUSY=$(port_owner "$WS_PORT" || true)
CADDY_BUSY=$(port_owner "$CADDY_PORT" || true)

if [[ -n "$WS_BUSY" ]]; then
  echo "ERROR: Port $WS_PORT (Python server) is already in use by another process:"
  echo "  $WS_BUSY"
  echo ""
  echo "This is NOT our chat server. I will NOT kill it (it might be OpenVPN,"
  echo "nginx, or another service you need)."
  echo ""
  echo "Solutions:"
  echo "  - Use a different port: --ws-port 8081"
  echo "  - Stop the other process manually if you know what it is"
  exit 1
fi

if [[ -n "$CADDY_BUSY" ]]; then
  echo "ERROR: Port $CADDY_PORT (Caddy) is already in use by another process:"
  echo "  $CADDY_BUSY"
  echo ""
  echo "This is NOT our Caddy. I will NOT kill it."
  echo ""
  echo "Solutions:"
  echo "  - Use a different port: --port 8443"
  echo "  - Stop the other web server (nginx/apache) if you don't need it"
  exit 1
fi

# ---- stop system Caddy service if running (it would conflict on 80/443) ----
# This only stops the systemd service, doesn't kill foreign processes.
if systemctl is-active --quiet caddy 2>/dev/null; then
  echo "Stopping system Caddy service (conflicts with ours)…"
  systemctl stop caddy 2>/dev/null || true
  systemctl disable caddy 2>/dev/null || true
fi

# ---- detect public IP + generate domain ----
if [[ -z "$DOMAIN" ]]; then
  echo "Detecting public IP…"
  IP=$(curl -s4 https://api.ipify.org 2>/dev/null || curl -s4 https://ifconfig.me/ip 2>/dev/null || true)
  if [[ -z "$IP" ]]; then
    echo "Error: cannot detect public IP."
    echo "  Use --domain to specify your domain manually."
    exit 1
  fi
  DOMAIN="${IP}.nip.io"
  echo "  IP: $IP"
  echo "  Domain: $DOMAIN (nip.io — free wildcard DNS)"
fi

# ---- write Caddyfile ----
if [[ "$CADDY_PORT" -eq 443 ]]; then
  DOMAIN_LINE="$DOMAIN"
else
  DOMAIN_LINE=":$CADDY_PORT"
fi
cat > "$SCRIPT_DIR/Caddyfile" <<EOF
{
    admin off
}

$DOMAIN_LINE {
    reverse_proxy 127.0.0.1:$WS_PORT
}
EOF
caddy fmt --overwrite "$SCRIPT_DIR/Caddyfile" 2>/dev/null || true

# ---- build admin arg ----
ADMIN_ARG=()
if [[ -n "$ADMIN_PASSWORD" ]]; then
  ADMIN_ARG=(--admin-password "$ADMIN_PASSWORD")
fi

# ---- truncate log if huge ----
if [[ -f "$LOG_FILE" ]] && [[ $(wc -c < "$LOG_FILE") -gt 1048576 ]]; then
  echo "(log truncated)" > "$LOG_FILE"
fi

# ---- start Python server (background) ----
echo "Starting Python chat server on 127.0.0.1:$WS_PORT…"
nohup python3 "$SCRIPT_DIR/server.py" \
  --password "$PASSWORD" "${ADMIN_ARG[@]}" \
  --host 127.0.0.1 --port "$WS_PORT" \
  >> "$LOG_FILE" 2>&1 &
WS_PID=$!
echo "  PID: $WS_PID"

sleep 1.5
if ! kill -0 "$WS_PID" 2>/dev/null; then
  echo "Error: Python server failed to start."
  echo ""
  echo "Last 10 log lines:"
  tail -10 "$LOG_FILE" 2>/dev/null || true
  exit 1
fi

# ---- start Caddy (background) ----
echo "Starting Caddy (auto TLS) on port $CADDY_PORT…"
nohup caddy run --config "$SCRIPT_DIR/Caddyfile" --adapter caddyfile \
  >> "$LOG_FILE" 2>&1 &
CADDY_PID=$!
echo "  PID: $CADDY_PID"

sleep 2
if ! kill -0 "$CADDY_PID" 2>/dev/null; then
  echo "Error: Caddy failed to start."
  echo ""
  echo "Last 15 log lines:"
  tail -15 "$LOG_FILE" 2>/dev/null || true
  echo ""
  echo "Cleaning up Python server…"
  kill "$WS_PID" 2>/dev/null || true
  exit 1
fi

# ---- save state ----
echo "$CADDY_PID $WS_PID" > "$PID_FILE"
WSS_URL="wss://$DOMAIN"
if [[ "$CADDY_PORT" -ne 443 ]]; then
  WSS_URL="wss://$DOMAIN:$CADDY_PORT"
fi
echo "$WSS_URL" > "$URL_FILE"

echo ""
echo "========================================"
echo "  SlidySim Chat started (background)"
echo "========================================"
echo "  WSS URL    : $WSS_URL"
if [[ -n "$ADMIN_PASSWORD" ]]; then
  echo "  Admin panel: https://$DOMAIN/admin"
fi
echo "  Log file   : $LOG_FILE"
echo "========================================"
echo ""
echo "  NOTE: First run takes 10-30s for Caddy to provision"
echo "  the Let's Encrypt certificate. Check ./status.sh"
echo "  after a bit — if health check fails, wait and retry."
echo ""
echo "  ./status.sh  — check status"
echo "  ./stop.sh    — stop server"
echo "  tail -f $LOG_FILE  — view live logs"
echo ""
echo "  You can close this terminal. The server keeps running."
