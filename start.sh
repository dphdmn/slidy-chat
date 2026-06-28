#!/usr/bin/env bash
#
# start.sh — Start SlidySim Chat in the BACKGROUND (survives terminal close).
#
# Usage:
#   sudo ./start.sh --password "USER_SECRET" [--admin-password "ADMIN_SECRET"]
#                   [--domain my.example.com] [--port 443] [--ws-port 8080]
#
# After starting, close your terminal freely. Use ./status.sh to check,
# ./stop.sh to stop.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PID_FILE="$SCRIPT_DIR/.chat-pids"
URL_FILE="$SCRIPT_DIR/.chat-url"
LOG_FILE="$SCRIPT_DIR/chat.log"

# ---- check if already running ----
if [[ -f "$PID_FILE" ]]; then
    read -r CADDY_PID WS_PID < "$PID_FILE" 2>/dev/null || true
    if [[ -n "${CADDY_PID:-}" ]] && kill -0 "$CADDY_PID" 2>/dev/null; then
        echo "Chat is already running (Caddy PID $CADDY_PID)."
        echo "Use ./status.sh for info, ./stop.sh to stop."
        exit 1
    fi
    if [[ -n "${WS_PID:-}" ]] && kill -0 "$WS_PID" 2>/dev/null; then
        echo "Chat is already running (Server PID $WS_PID)."
        echo "Use ./status.sh for info, ./stop.sh to stop."
        exit 1
    fi
    rm -f "$PID_FILE"
fi

# ---- parse args ----
PASSWORD="${CHAT_PASSWORD:-}"
ADMIN_PASSWORD="${CHAT_ADMIN_PASSWORD:-}"
DOMAIN=""
CADDY_PORT="443"
WS_PORT="8080"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --password)        PASSWORD="$2"; shift 2 ;;
    --admin-password)  ADMIN_PASSWORD="$2"; shift 2 ;;
    --domain)          DOMAIN="$2"; shift 2 ;;
    --port)            CADDY_PORT="$2"; shift 2 ;;
    --ws-port)         WS_PORT="$2"; shift 2 ;;
    -h|--help)
      cat <<'EOF'
SlidySim Chat — start in background

Usage:
  sudo ./start.sh --password "SECRET" [options]

Options:
  --password PW       User chat password (required)
  --admin-password PW Admin panel password (optional, enables /admin)
  --domain DOMAIN     Your domain (e.g. chat.example.com). If omitted,
                      auto-generates <ip>.nip.io (free wildcard DNS + Let's Encrypt)
  --port N            Caddy HTTPS port (default 443; use 8443 if not root)
  --ws-port N         Internal Python server port (default 8080)

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

# ---- check privileges for port 443 ----
if [[ "$CADDY_PORT" -lt 1024 ]] && [[ "$(id -u)" -ne 0 ]]; then
  echo "Error: Caddy port $CADDY_PORT requires root."
  echo "  Use sudo, or: --port 8443"
  exit 1
fi

# ---- kill any leftover Caddy processes (port 2019 / 443 conflicts) ----
# The system Caddy service (from apt install) may be running. Stop it.
if systemctl is-active --quiet caddy 2>/dev/null; then
  echo "Stopping system Caddy service…"
  systemctl stop caddy 2>/dev/null || true
  systemctl disable caddy 2>/dev/null || true
fi
# Kill any stray caddy processes not managed by us
if pgrep -x caddy >/dev/null 2>&1; then
  echo "Killing existing Caddy process(es)…"
  pkill -x caddy 2>/dev/null || true
  sleep 1
fi

# ---- detect public IP + generate domain ----
if [[ -z "$DOMAIN" ]]; then
  echo "Detecting public IP…"
  IP=$(curl -s4 https://api.ipify.org 2>/dev/null || curl -s4 https://ifconfig.me/ip 2>/dev/null || true)
  if [[ -z "$IP" ]]; then
    echo "Error: cannot detect public IP."
    echo "  Use --domain to specify your domain manually."
    echo "  Example: --domain chat.yourdomain.com"
    exit 1
  fi
  # Use nip.io — sslip.io has Yahoo consent redirect issues for some IPs
  DOMAIN="${IP}.nip.io"
  echo "  IP: $IP"
  echo "  Domain: $DOMAIN (nip.io — free wildcard DNS)"
fi

# ---- write Caddyfile ----
# `admin off` disables Caddy's admin API on port 2019 (prevents conflicts)
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

# Format the Caddyfile (suppresses the "not formatted" warning)
caddy fmt --overwrite "$SCRIPT_DIR/Caddyfile" 2>/dev/null || true

# ---- build admin arg ----
ADMIN_ARG=()
if [[ -n "$ADMIN_PASSWORD" ]]; then
  ADMIN_ARG=(--admin-password "$ADMIN_PASSWORD")
fi

# ---- start Python server (background) ----
echo "Starting Python chat server on 127.0.0.1:$WS_PORT…"
nohup python3 "$SCRIPT_DIR/server.py" \
  --password "$PASSWORD" "${ADMIN_ARG[@]}" \
  --host 127.0.0.1 --port "$WS_PORT" \
  >> "$LOG_FILE" 2>&1 &
WS_PID=$!
echo "  PID: $WS_PID"

# Wait for Python server to be ready
sleep 1
if ! kill -0 "$WS_PID" 2>/dev/null; then
  echo "Error: Python server failed to start. Check $LOG_FILE"
  exit 1
fi

# ---- start Caddy (background) ----
echo "Starting Caddy (auto TLS) on port $CADDY_PORT…"
nohup caddy run --config "$SCRIPT_DIR/Caddyfile" --adapter caddyfile \
  >> "$LOG_FILE" 2>&1 &
CADDY_PID=$!
echo "  PID: $CADDY_PID"

# Wait for Caddy to start
sleep 2
if ! kill -0 "$CADDY_PID" 2>/dev/null; then
  echo "Error: Caddy failed to start. Check $LOG_FILE"
  echo "  Common causes:"
  echo "    - Port 443 already in use (check: lsof -i :443)"
  echo "    - Another web server running (nginx, apache)"
  echo ""
  echo "  Last 10 log lines:"
  tail -10 "$LOG_FILE" 2>/dev/null || true
  # Clean up the Python server
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
