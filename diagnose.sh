#!/usr/bin/env bash
#
# diagnose.sh — Diagnose why SlidySim Chat isn't working.
#
# Checks:
#   1. Is the Python server running?
#   2. Is Caddy running?
#   3. Do ports 80 and 443 accept connections?
#   4. Does the nip.io/sslip.io domain resolve to this VPS?
#   5. Did Caddy obtain a TLS certificate?
#   6. Can we reach the server from outside?
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

URL_FILE="$SCRIPT_DIR/.chat-url"
PID_FILE="$SCRIPT_DIR/.chat-pids"
LOG_FILE="$SCRIPT_DIR/chat.log"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }

echo "=== SlidySim Chat Diagnostics ==="
echo ""

# ---- 1. Python server ----
echo "1. Python chat server"
OUR_PY=$(pgrep -f "python3.*${SCRIPT_DIR}/server.py" 2>/dev/null || true)
if [[ -n "$OUR_PY" ]]; then
  ok "Running (PID $OUR_PY)"
  # Check if it's listening on 8080
  if ss -tln 2>/dev/null | grep -q ":8080 "; then
    ok "Listening on port 8080"
  else
    fail "Not listening on port 8080 (check $LOG_FILE)"
  fi
else
  fail "Not running"
  echo "     Start with: sudo ./start.sh --password 'SECRET'"
fi
echo ""

# ---- 2. Caddy ----
echo "2. Caddy (TLS proxy)"
OUR_CADDY=$(pgrep -f "caddy run.*${SCRIPT_DIR}/Caddyfile" 2>/dev/null || true)
if [[ -n "$OUR_CADDY" ]]; then
  ok "Running (PID $OUR_CADDY)"
else
  fail "Not running"
  if [[ -n "$OUR_PY" ]]; then
    echo "     Caddy failed to start. Check $LOG_FILE for errors."
  fi
fi
echo ""

# ---- 3. Domain + DNS ----
echo "3. Domain + DNS"
DOMAIN=""
if [[ -f "$URL_FILE" ]]; then
  WSS_URL=$(cat "$URL_FILE")
  DOMAIN="${WSS_URL#wss://}"
  DOMAIN="${DOMAIN%%:*}"
fi
if [[ -z "$DOMAIN" ]]; then
  warn "No domain configured (server not started, or no URL file)"
  DOMAIN_HINT="<not set>"
else
  DOMAIN_HINT="$DOMAIN"
fi
echo "   Domain: $DOMAIN_HINT"

if [[ -n "$DOMAIN" ]]; then
  # Check DNS resolution
  RESOLVED_IP=$(dig +short "$DOMAIN" 2>/dev/null || host "$DOMAIN" 2>/dev/null | grep "has address" | awk '{print $NF}' || true)
  if [[ -z "$RESOLVED_IP" ]]; then
    fail "Domain does not resolve (DNS issue)"
    echo "     The domain $DOMAIN doesn't resolve to any IP."
    echo "     If using nip.io, make sure the format is <ip>.nip.io"
  else
    echo "   Resolves to: $RESOLVED_IP"

    # Get our public IP
    OUR_IP=$(curl -s4 https://api.ipify.org 2>/dev/null || true)
    if [[ -n "$OUR_IP" ]]; then
      echo "   This VPS IP: $OUR_IP"
      if [[ "$RESOLVED_IP" == "$OUR_IP" ]]; then
        ok "DNS points to this VPS"
      else
        fail "DNS points to $RESOLVED_IP, but this VPS is $OUR_IP"
        echo "     The domain doesn't point to your VPS."
        echo "     If using DuckDNS, update it: curl 'https://www.duckdns.org/update?domains=YOURSUB&token=YOURTOKEN&ip='"
      fi
    fi
  fi
fi
echo ""

# ---- 4. Ports ----
echo "4. Port availability (local)"
for port in 80 443 8080; do
  if ss -tln 2>/dev/null | grep -q ":${port} "; then
    PROC=$(ss -tlnp 2>/dev/null | grep ":${port} " | grep -oP 'users:\(\("\K[^"]+' | head -1 || echo "unknown")
    if [[ "$PROC" == "caddy" ]] || [[ "$PROC" == "python3" ]]; then
      ok "Port $port: listening ($PROC)"
    else
      warn "Port $port: in use by '$PROC' (not ours)"
    fi
  else
    if [[ -n "$OUR_CADDY" ]] && [[ "$port" == "80" || "$port" == "443" ]]; then
      fail "Port $port: NOT listening (Caddy should be here)"
    elif [[ -n "$OUR_PY" ]] && [[ "$port" == "8080" ]]; then
      fail "Port $port: NOT listening (Python server should be here)"
    else
      echo "   Port $port: free"
    fi
  fi
done
echo ""

# ---- 5. Firewall ----
echo "5. Firewall check"
if command -v ufw &>/dev/null; then
  UFW_STATUS=$(ufw status 2>/dev/null || true)
  if echo "$UFW_STATUS" | grep -q "inactive"; then
    ok "UFW is inactive (all ports open)"
  else
    for port in 80 443; do
      if echo "$UFW_STATUS" | grep -qE "^${port}/.*(ALLOW|DENY)"; then
        if echo "$UFW_STATUS" | grep -E "^${port}/" | grep -q ALLOW; then
          ok "Port $port: ALLOWED in UFW"
        else
          fail "Port $port: BLOCKED in UFW"
          echo "     Fix: sudo ufw allow ${port}/tcp"
        fi
      else
        warn "Port $port: not in UFW rules (may be blocked)"
        echo "     Fix: sudo ufw allow ${port}/tcp"
      fi
    done
  fi
elif command -v iptables &>/dev/null; then
  IPTABLES_80=$(iptables -L INPUT -n 2>/dev/null | grep -E "dpt:80\b" || true)
  IPTABLES_443=$(iptables -L INPUT -n 2>/dev/null | grep -E "dpt:443\b" || true)
  if [[ -z "$IPTABLES_80" ]] && [[ -z "$IPTABLES_443" ]]; then
    ok "No iptables rules blocking 80/443"
  else
    warn "iptables rules exist for ports 80/443 — verify they allow traffic"
    echo "     Check: sudo iptables -L INPUT -n"
  fi
else
  warn "No firewall tool found (ufw/iptables). Can't check."
fi
echo ""

# ---- 6. TLS certificate ----
echo "6. TLS certificate"
if [[ -n "$DOMAIN" ]] && [[ -n "$OUR_CADDY" ]]; then
  echo "   Checking cert for $DOMAIN…"
  CERT_INFO=$(echo | timeout 5 openssl s_client -connect "$DOMAIN:443" -servername "$DOMAIN" 2>/dev/null | openssl x509 -noout -subject -issuer -dates 2>/dev/null || true)
  if [[ -n "$CERT_INFO" ]]; then
    SUBJECT=$(echo "$CERT_INFO" | grep subject | head -1)
    ISSUER=$(echo "$CERT_INFO" | grep issuer | head -1)
    echo "   Subject: $SUBJECT"
    echo "   Issuer:  $ISSUER"
    if echo "$ISSUER" | grep -qi "let's encrypt\|letsencrypt"; then
      ok "Valid Let's Encrypt certificate!"
    elif echo "$SUBJECT" | grep -qi "$DOMAIN"; then
      warn "Cert matches domain but isn't from Let's Encrypt"
    else
      fail "Cert doesn't match domain (got: $SUBJECT)"
      echo "     Caddy may still be provisioning, or provisioning failed."
      echo "     Check ACME errors in $LOG_FILE:"
      grep -i "acme\|error\|cert" "$LOG_FILE" 2>/dev/null | tail -5 || true
    fi
  else
    fail "Cannot connect to $DOMAIN:443 (TLS handshake failed)"
    echo "     Port 443 may be blocked, or Caddy isn't serving yet."
    echo "     If Caddy just started, wait 30s for cert provisioning."
  fi
else
  warn "Can't check cert (domain or Caddy not available)"
fi
echo ""

# ---- 7. Caddy ACME log ----
echo "7. Caddy ACME log (last 10 relevant lines)"
if [[ -f "$LOG_FILE" ]]; then
  ACME_LINES=$(grep -iE "acme|certificate|obtain|challenge|error|failed" "$LOG_FILE" 2>/dev/null | tail -10 || true)
  if [[ -n "$ACME_LINES" ]]; then
    echo "$ACME_LINES" | while IFS= read -r line; do
      echo "   $line"
    done
  else
    warn "No ACME-related lines in log"
    echo "   Caddy may not have attempted cert provisioning yet."
  fi
else
  warn "No log file found ($LOG_FILE)"
fi
echo ""

# ---- Summary + suggestions ----
echo "=== Summary ==="
if [[ -n "$OUR_PY" ]] && [[ -n "$OUR_CADDY" ]] && [[ -n "$DOMAIN" ]]; then
  echo "  Server is running. If cert isn't ready:"
  echo "    1. Wait 30s for first cert provisioning"
  echo "    2. Ensure ports 80 AND 443 are open on your VPS firewall"
  echo "    3. Check ACME errors above"
  echo "    4. If nip.io doesn't work, try DuckDNS:"
  echo "       a. Register at https://duckdns.org (free, GitHub login)"
  echo "       b. Create a subdomain (e.g. slidychat)"
  echo "       c. Update IP: curl 'https://www.duckdns.org/update?domains=slidychat&token=YOURTOKEN&ip='"
  echo "       d. Restart: sudo ./stop.sh --kill-all && sudo ./start.sh --password X --domain slidychat.duckdns.org"
else
  echo "  Server is NOT fully running."
  echo "  Start it with: sudo ./start.sh --password 'YOUR_SECRET'"
fi
