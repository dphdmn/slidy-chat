#!/usr/bin/env bash
#
# start.sh — Start SlidySim Chat in the BACKGROUND (survives terminal close).
#
# Usage:
#   sudo ./start.sh --password "USER_SECRET" [--admin-password "ADMIN_SECRET"]
#                   [--domain my.sslip.io] [--port 443] [--ws-port 8080]
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
  --domain DOMAIN     Override sslip.io domain (e.g. my-host.sslip.io)
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

# ---- detect public IP + generate domain ----
if [[ -z "$DOMAIN" ]]; then
  echo "Detecting public IP…"
  IP=$(curl -s4 https://api.ipify.org 2>/dev/null || curl -s4 https://ifconfig.me/ip 2>/dev/null || true)
  if [[ -z "$IP" ]]; then
    echo "Error: cannot detect public IP. Use --domain to specify manually."
    exit 1
  fi
  DOMAIN="${IP}.sslip.io"
fi

# ---- write Caddyfile ----
if [[ "$CADDY_PORT" -eq 443 ]]; then
  DOMAIN_LINE="$DOMAIN"
else
  DOMAIN_LINE=":$CADDY_PORT"
fi
cat > "$SCRIPT_DIR/Caddyfile" <<EOF
$DOMAIN_LINE {
    reverse_proxy 127.0.0.1:$WS_PORT
}
EOF

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

# ---- start Caddy (background) ----
echo "Starting Caddy (auto TLS) on port $CADDY_PORT…"
nohup caddy run --config "$SCRIPT_DIR/Caddyfile" --adapter caddyfile \
  >> "$LOG_FILE" 2>&1 &
CADDY_PID=$!
echo "  PID: $CADDY_PID"

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
echo "  ./status.sh  — check status"
echo "  ./stop.sh    — stop server"
echo "  tail -f $LOG_FILE  — view live logs"
echo ""
echo "  You can close this terminal. The server keeps running."
