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

ok() { echo "  ✓ $1"; }

# ---- parse args ----
PASSWORD="${CHAT_PASSWORD:-}"
ADMIN_PASSWORD="${CHAT_ADMIN_PASSWORD:-}"
DOMAIN=""
CADDY_PORT="443"
WS_PORT="8080"
FORCE_CLEAN=0
DUCKDNS_TOKEN="${CHAT_DUCKDNS_TOKEN:-}"
DUCKDNS_SUB="${CHAT_DUCKDNS_SUBDOMAIN:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --password)        PASSWORD="$2"; shift 2 ;;
    --admin-password)  ADMIN_PASSWORD="$2"; shift 2 ;;
    --domain)          DOMAIN="$2"; shift 2 ;;
    --port)            CADDY_PORT="$2"; shift 2 ;;
    --ws-port)         WS_PORT="$2"; shift 2 ;;
    --duckdns-token)   DUCKDNS_TOKEN="$2"; shift 2 ;;
    --duckdns-subdomain) DUCKDNS_SUB="$2"; shift 2 ;;
    --force)           FORCE_CLEAN=1; shift ;;
    -h|--help)
      cat <<'EOF'
SlidySim Chat — start in background

Usage:
  sudo ./start.sh --password "SECRET" [options]

Options:
  --password PW       User chat password (required)
  --admin-password PW Admin panel password (optional, enables /admin)
  --domain DOMAIN     Your domain (e.g. chat.example.com)
  --port N            Caddy HTTPS port (default 443; use 8443 if not root)
  --ws-port N         Internal Python server port (default 8080)
  --force             Kill OUR previous processes if found, then start

DuckDNS (recommended — most reliable with Let's Encrypt):
  --duckdns-subdomain SUB   Your DuckDNS subdomain (e.g. slidychat)
  --duckdns-token TOKEN     Your DuckDNS token from duckdns.org

  Register at https://duckdns.org (free, GitHub/Google login).
  This auto-updates the DNS to point to your VPS IP.

  Example:
    sudo ./start.sh --password "SECRET" \
      --duckdns-subdomain slidychat --duckdns-token abc123-...

If no domain or DuckDNS is specified, auto-generates <ip>.nip.io
(may not work with all VPS providers due to port 80/firewall issues).

SAFETY: Only kills processes identified as ours. Never kills foreign
processes like OpenVPN or nginx.

  ./status.sh  — check status
  ./stop.sh    — stop server
  ./diagnose.sh — diagnose problems
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

# ---- detect public IP + set up domain ----
echo "Detecting public IP…"
IP=$(curl -s4 https://api.ipify.org 2>/dev/null || curl -s4 https://ifconfig.me/ip 2>/dev/null || true)
if [[ -z "$IP" ]]; then
  echo "Error: cannot detect public IP."
  echo "  Use --domain to specify your domain manually."
  exit 1
fi
echo "  IP: $IP"

# DuckDNS mode (recommended)
if [[ -n "$DUCKDNS_SUB" ]] && [[ -n "$DUCKDNS_TOKEN" ]]; then
  echo "Updating DuckDNS: $DUCKDNS_SUB.duckdns.org -> $IP"
  DUCK_RESULT=$(curl -s4 "https://www.duckdns.org/update?domains=${DUCKDNS_SUB}&token=${DUCKDNS_TOKEN}&ip=${IP}" 2>/dev/null || true)
  if [[ "$DUCK_RESULT" == "OK" ]]; then
    ok "DuckDNS updated: ${DUCKDNS_SUB}.duckdns.org -> ${IP}"
    DOMAIN="${DUCKDNS_SUB}.duckdns.org"
  elif [[ "$DUCK_RESULT" == "bad token" ]]; then
    echo "Error: DuckDNS says 'bad token'. Check your token at duckdns.org"
    exit 1
  else
    echo "Warning: DuckDNS update returned: '$DUCK_RESULT'"
    echo "  Continuing anyway (DNS may already be correct)…"
    DOMAIN="${DUCKDNS_SUB}.duckdns.org"
  fi
  echo "  Domain: $DOMAIN"
# Manual domain mode
elif [[ -n "$DOMAIN" ]]; then
  echo "  Using provided domain: $DOMAIN"
# Auto nip.io fallback
else
  DOMAIN="${IP}.nip.io"
  echo "  Domain: $DOMAIN (nip.io)"
  echo "  WARNING: nip.io may not work with all VPS providers."
  echo "    If cert provisioning fails, use DuckDNS instead:"
  echo "    --duckdns-subdomain SUB --duckdns-token TOKEN"
  echo "    (register at https://duckdns.org — free, 30 seconds)"
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
echo "  Waiting 15s for cert provisioning…"
sleep 15

# Check if cert was obtained
CERT_OK=$(grep -c "certificate obtained successfully\|obtained certificate" "$LOG_FILE" 2>/dev/null || true)
CERT_OK=${CERT_OK:-0}
CERT_ERR=$(grep -iE "error.*obtain|ACME.*error|challenge.*failed" "$LOG_FILE" 2>/dev/null | tail -3 || true)

if [[ "$CERT_OK" -gt 0 ]]; then
  echo "  ✓ TLS certificate obtained!"
elif [[ -n "$CERT_ERR" ]]; then
  echo "  ✗ Cert provisioning FAILED. Errors from log:"
  echo "$CERT_ERR" | while IFS= read -r line; do echo "    $line"; done
  echo ""
  echo "  Common fixes:"
  echo "    1. Ensure ports 80 AND 443 are open on your VPS firewall:"
  echo "       sudo ufw allow 80/tcp && sudo ufw allow 443/tcp"
  echo "    2. Use DuckDNS (more reliable than nip.io):"
  echo "       a. Register at https://duckdns.org (free)"
  echo "       b. sudo ./stop.sh --kill-all"
  echo "       c. sudo ./start.sh --password 'SECRET' \\"
  echo "            --duckdns-subdomain YOURSUB --duckdns-token YOURTOKEN"
  echo "    3. Run ./diagnose.sh for full diagnostics"
else
  echo "  ! Cert may still be provisioning. Check ./diagnose.sh"
fi
echo ""
echo "  ./status.sh    — check status"
echo "  ./stop.sh      — stop server"
echo "  ./diagnose.sh  — diagnose problems"
echo "  tail -f $LOG_FILE  — view live logs"
echo ""
echo "  You can close this terminal. The server keeps running."
