# SlidySim Chat

A floating public chat for [play.slidysim.com](https://play.slidysim.com/) with a dark neon UI, live user status, solve-activity feed, chat groups, and an admin panel.

**Server**: one Python file, zero pip dependencies. **TLS is mandatory** — handled by [Caddy](https://caddyserver.com/) (auto Let's Encrypt via nip.io).

**Client**: one userscript file for users, one admin HTML page for admins.

---

## Features

### For users (userscript)
- **Floating chat window** — dark neon aesthetic. Draggable, minimizable, never blocks gameplay.
- **Username auto-detection** — reads your slidysim username. Falls back to `Egg#1234`.
- **Custom username color** — pick any hex color in settings.
- **User status sharing** — others see if you're *solving*, *browsing stats*, *browsing sessions*, or *in menu*. **Toggleable for privacy.**
- **Activity feed** — separate tab shows everyone's solves (time, moves, TPS, session name, solve number). DNF solves are NOT shared. **Toggleable for privacy.**
- **Chat groups** — create ad-hoc group channels, invite any online user.
- **Egg + silly emojis only** — 🥚🍳🐣🤪💤🤡 etc.
- **Clickabe links** — URLs in messages become clickable.
- **Virtualized rendering** — only ~200 DOM nodes max, never slows gameplay.

### For admins (web panel)
- **Admin panel** at `https://your-domain/admin` — separate admin password.
- **Delete any message** — hover over a message and click ×.
- **Send messages as admin** — admin messages get a pink `ADMIN` badge.
- **Admin status** — shows as "admin" in the user list with a pink badge.
- **No slidysim integration** — admin panel is a standalone chat, no status/activity sharing.

### Security
- **Mandatory TLS** — Caddy auto-provisions Let's Encrypt cert. No plaintext.
- **Origin-locked** — server hard-rejects regular connections not from `https://play.slidysim.com`.
- **Admin path exempt from Origin** — admin panel protected by admin password instead.
- **Password auth** — separate user and admin passwords.
- **XSS-safe** — all user input rendered via DOM APIs (`createTextNode`), never `innerHTML` with user text.
- **Rate limiting** — 25 messages per 10 seconds per user.

---

## Quick start

### 1. Install (one-time)

On your VPS:

```bash
curl -sSL https://raw.githubusercontent.com/dphdmn/slidy-chat/main/install.sh | bash
```

This clones the repo and installs Caddy. It does NOT start the server.

### 2. Set up DuckDNS (recommended — takes 30 seconds)

TLS requires a domain name. DuckDNS is free and works perfectly with Let's Encrypt:

1. Go to [duckdns.org](https://duckdns.org)
2. Log in with GitHub, Google, or Reddit
3. Create a subdomain (e.g. `slidychat`)
4. Copy your **token** (the UUID shown on the page)

The subdomain + token are all you need. The start script auto-updates the DNS to point to your VPS.

### 3. Open firewall ports

Caddy needs ports 80 + 443 for Let's Encrypt + HTTPS:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

### 4. Start (background)

```bash
cd ~/slidy-chat
sudo ./start.sh --password "USER_SECRET" \
  --admin-password "ADMIN_SECRET" \
  --duckdns-subdomain "slidychat" \
  --duckdns-token "your-duckdns-token-here"
```

The server starts in the **background** (via `nohup`). You can close your terminal — the server keeps running.

Output:
```
========================================
  SlidySim Chat started (background)
========================================
  WSS URL    : wss://slidychat.duckdns.org
  Admin panel: https://slidychat.duckdns.org/admin
  Log file   : /root/slidy-chat/chat.log
========================================

  Waiting 15s for cert provisioning…
  ✓ TLS certificate obtained!

  ./status.sh    — check status
  ./stop.sh      — stop server
  ./diagnose.sh  — diagnose problems

  You can close this terminal. The server keeps running.
```

**If you don't want DuckDNS**, you can use nip.io (auto-generated from your IP):

```bash
sudo ./start.sh --password "USER_SECRET" --admin-password "ADMIN_SECRET"
# → uses <your-ip>.nip.io automatically
```

Or use your own domain:

```bash
sudo ./start.sh --password "USER_SECRET" --domain "chat.yourdomain.com"
```

### 5. Check status

```bash
./status.sh
```

Output:
```
=== SlidySim Chat Status ===

  State: RUNNING

  Caddy  : yes (PID 12345)
  Server : yes (PID 12346)
  URL    : wss://203.0.113.42.nip.io

  Server started: Sun Jun 28 10:58:52 2026

  Health check…
    Uptime  : 01:23:45
    Clients : 5
    Messages: 142

  Log file: /root/slidy-chat/chat.log
  Stop with: ./stop.sh
```

### 6. Stop

```bash
./stop.sh
```

Output:
```
Stopping SlidySim Chat…
  Caddy stopped (PID 12345)
  Server stopped (PID 12346)
Done.
```

---

## How it works

### Architecture

```
Browser (slidysim.com)                           Admin browser (any)
    ↓ WSS :443                                       ↓ HTTPS :443
Caddy (auto Let's Encrypt TLS for <ip>.nip.io)
    ↓ WS (plain, localhost:8080)
Python server
  ├── /         → regular chat (Origin locked to play.slidysim.com)
  └── /admin    → admin chat (admin password required)
```

**Why localhost?** The Python server binds to `127.0.0.1` only — it's never directly accessible from the internet. Caddy is the public-facing proxy on port 443. This is a security measure: even if someone bypasses Caddy, they can't reach the Python server directly. **It works online** because Caddy forwards external connections to localhost.

### TLS via Caddy + nip.io

1. `start.sh` detects your VPS's public IP (via `api.ipify.org`)
2. Generates domain: `<ip>.nip.io` (e.g. `203.0.113.42.nip.io`)
3. Writes a Caddyfile for that domain
4. Caddy auto-provisions a Let's Encrypt certificate on first run (~10-30s)
5. Caddy auto-renews before expiry

No manual cert management. nip.io is a free DNS service that resolves `<ip>.nip.io` to the embedded IP.

### Status detection (userscript)

The userscript uses a `MutationObserver` on `document.body` — the **exact same technique and code** as [slidywebscripts](https://github.com/dphdmn/slidywebscripts):

| State | Detection |
|-------|-----------|
| Solving | `.focus-area` element exists |
| Browsing stats | `.session-statistics-table` exists |
| Browsing sessions | `.sessions` exists |
| Main menu | None of the above |

The `parsePuzzleToNumberMatrix()` and `puzzleIsSolved()` functions are **direct ports** from slidywebscripts v4.2.0 — no custom logic.

### Solve detection

When you complete a solve, slidysim adds a row to the stats grid. The observer detects this (childList mutation on `<td>` where added text contains "Session") and reads the **single solve row** (`tr[avg="1"]`) from `.stats-grid-container`:

- **Time** (e.g. `12.34`)
- **Moves** (e.g. `60`)
- **TPS** (e.g. `4.86`)
- **Session name** (from `.session-name`)
- **Solve number** (from header text)

**DNF solves are NOT sent** — filtered client-side. No averages, only single solves.

A `scrambled` flag prevents false detections (set true on scramble, only emit on finish while scrambled). A dedup signature prevents duplicates on session switches.

---

## Userscript installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/)
2. Open [userscript.user.js](https://raw.githubusercontent.com/dphdmn/slidy-chat/main/userscript.user.js) and click "Install"
3. Edit the server URL at the top of the userscript:
   ```js
   const SERVER_URL = 'wss://YOUR-VPS-IP.nip.io'; // <-- CHANGE THIS
   ```
4. Visit [play.slidysim.com](https://play.slidysim.com/). A floating chat window appears.
5. Enter the **user password** when prompted.

## Admin panel

1. Start the server with `--admin-password "SECRET"`
2. Visit `https://your-domain/admin` in any browser
3. Enter the **admin password**
4. You see the chat with delete buttons on every message and an ADMIN badge on your messages

The admin panel is a standalone HTML page — no userscript manager needed.

---

## Command reference

### `install.sh` — one-time setup
```bash
./install.sh
```
Clones repo, installs Caddy. Does NOT start the server.

### `start.sh` — start in background
```bash
sudo ./start.sh --password "USER_PW" [--admin-password "ADMIN_PW"] [options]
```
Options:
- `--password PW` — user chat password (required)
- `--admin-password PW` — admin panel password (optional, enables `/admin`)
- `--domain DOMAIN` — override nip.io domain
- `--port N` — Caddy HTTPS port (default 443; use 8443 if not root)
- `--ws-port N` — internal Python server port (default 8080)

### `status.sh` — check status
```bash
./status.sh
```
Shows: running state, PIDs, WSS URL, uptime, connected clients, message count.

### `stop.sh` — stop server
```bash
./stop.sh
```
Gracefully stops both Caddy and the Python server.

### `chat.log` — view logs
```bash
tail -f chat.log
```

---

## File structure

```
slidy-chat/
├── server.py             # Python WebSocket server (pure stdlib)
├── userscript.user.js    # Userscript for play.slidysim.com
├── admin.html            # Admin panel (standalone web page)
├── start.sh              # Start in background
├── status.sh             # Check status
├── stop.sh               # Stop server
├── install.sh            # One-time installer
├── Caddyfile.template    # Caddy config template (start.sh generates real one)
└── README.md             # This file
```

---

## Troubleshooting

### First step: run diagnostics

```bash
./diagnose.sh
```

This checks everything: Python server, Caddy, ports, DNS, firewall, TLS certificate, ACME logs. It tells you exactly what's wrong and how to fix it.

### "Caddy is not installed"
Run `./install.sh` first. Or install Caddy manually: [caddyserver.com/docs/install](https://caddyserver.com/docs/install)

### Certificate provisioning fails (Yahoo redirect, "cert for wrong domain", etc.)

This means Caddy couldn't get a Let's Encrypt certificate. Common causes:

1. **Ports 80 or 443 are blocked.** Open them:
   ```bash
   sudo ufw allow 80/tcp
   sudo ufw allow 443/tcp
   ```
   Let's Encrypt needs port 80 for the HTTP-01 challenge (or 443 for TLS-ALPN-01).

2. **Using nip.io and it doesn't work with your VPS provider.** Switch to DuckDNS:
   - Register at [duckdns.org](https://duckdns.org) (free, 30 seconds)
   - Create a subdomain, copy your token
   - `sudo ./stop.sh --kill-all`
   - `sudo ./start.sh --password "X" --duckdns-subdomain "yoursub" --duckdns-token "yourtoken"`

3. **Caddy never started.** Check `./diagnose.sh` — is Caddy running? If not, check `chat.log` for errors.

4. **System Caddy service is running.** `start.sh` stops it automatically, but if it persists:
   ```bash
   sudo systemctl stop caddy
   sudo systemctl disable caddy
   ```

### "Port 443 requires root"
Use `sudo`, or: `./start.sh --password "SECRET" --port 8443`

### "Port 8080 is already in use"
Another process (maybe OpenVPN, nginx) is on port 8080. Use a different port:
```bash
sudo ./start.sh --password "SECRET" --ws-port 8081
```

### Health check shows "unreachable"
Caddy may still be provisioning the certificate on first run. Wait 30 seconds and run `./status.sh` again. If still failing, run `./diagnose.sh`.

### Admin panel returns 404
You didn't pass `--admin-password` to `start.sh`. Stop the server, restart with the admin password.

### Chat says "connecting…" forever
1. Check `./status.sh` — is the server running?
2. Check the WSS URL in the userscript matches what `status.sh` shows
3. Check browser console (F12) for `[slidy-chat]` logs
4. Run `./diagnose.sh`

---

## License

MIT.

## Credits
- CSS: [slidyhistory](https://github.com/dphdmn/slidyhistory)
- Observer patterns: [slidywebscripts](https://github.com/dphdmn/slidywebscripts)
- TLS: [Caddy](https://caddyserver.com/) + [Let's Encrypt](https://letsencrypt.org/) + [DuckDNS](https://duckdns.org/)
