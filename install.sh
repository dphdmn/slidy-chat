#!/usr/bin/env bash
#
# install.sh — One-time installer for SlidySim Chat.
#
# Clones the repo and installs Caddy. Does NOT start the server.
# After install, run: sudo ./start.sh --password "SECRET"
#
set -euo pipefail

INSTALL_DIR="${SLIDY_CHAT_DIR:-$HOME/slidy-chat}"
REPO_URL="${SLIDY_CHAT_REPO:-https://github.com/dphdmn/slidy-chat.git}"

echo "=== SlidySim Chat Installer ==="
echo ""

if ! command -v python3 &>/dev/null; then
  echo "Error: python3 is not installed."
  echo ""
  echo "Install Python 3.8+ first:"
  echo "  Ubuntu/Debian:  sudo apt update && sudo apt install -y python3"
  echo "  CentOS/RHEL:    sudo dnf install -y python3"
  echo "  Alpine:         sudo apk add python3"
  echo "  macOS:          brew install python3"
  exit 1
fi

PY_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
echo "Python $PY_VERSION found."

# ---- clone or update ----
if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "Updating existing install at $INSTALL_DIR ..."
  cd "$INSTALL_DIR"
  git pull --rebase --quiet || echo "Warning: git pull failed, using existing files."
else
  echo "Cloning to $INSTALL_DIR ..."
  if git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" 2>/dev/null; then
    :
  else
    echo "git clone failed, trying direct download..."
    mkdir -p "$INSTALL_DIR"
    BASE="$(echo "$REPO_URL" | sed 's|\.git$||' | sed 's|github.com|raw.githubusercontent.com|')"
    for f in server.py userscript.user.js admin.html start.sh status.sh stop.sh install.sh Caddyfile.template README.md; do
      curl -sSL -o "$INSTALL_DIR/$f" "$BASE/main/$f" 2>/dev/null || true
    done
  fi
  cd "$INSTALL_DIR"
fi

chmod +x start.sh status.sh stop.sh install.sh 2>/dev/null || true

# ---- install Caddy ----
if ! command -v caddy &>/dev/null; then
  echo ""
  echo "Caddy not found. Installing…"
  if command -v apt &>/dev/null; then
    sudo apt update -y
    sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
    sudo apt update -y
    sudo apt install -y caddy
  elif command -v dnf &>/dev/null; then
    sudo dnf install -y 'dnf-command(copr)'
    sudo dnf copr enable -y @caddy/caddy
    sudo dnf install -y caddy
  elif command -v brew &>/dev/null; then
    brew install caddy
  else
    echo "Cannot auto-install Caddy. Install manually: https://caddyserver.com/docs/install"
    exit 1
  fi
fi

if command -v caddy &>/dev/null; then
  echo "Caddy $(caddy version 2>&1 | head -1) found."
fi

echo ""
echo "========================================"
echo "  Installation complete!"
echo "========================================"
echo ""
echo "  Next steps:"
echo "    cd $INSTALL_DIR"
echo "    sudo ./start.sh --password \"YOUR_SECRET\" [--admin-password \"ADMIN_SECRET\"]"
echo ""
echo "  Then:"
echo "    ./status.sh  — check if running"
echo "    ./stop.sh    — stop the server"
echo "    tail -f chat.log  — view logs"
echo ""
echo "  The server prints a WSS URL on start. Put that in the userscript."
echo ""
