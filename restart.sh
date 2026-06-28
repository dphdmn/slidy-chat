#!/usr/bin/env bash
#
# restart.sh — Stop and restart SlidySim Chat.
#
# Usage:
#   sudo ./restart.sh --password "SECRET" [options]
#
# All args are forwarded to start.sh.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Stopping existing server ==="
./stop.sh --kill-all 2>/dev/null || ./stop.sh 2>/dev/null || true
sleep 2

echo ""
echo "=== Starting server ==="
./start.sh --force "$@"
