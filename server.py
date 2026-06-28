#!/usr/bin/env python3
"""
SlidySim Chat Server
====================
Pure-stdlib Python WebSocket chat server.

  - Runs plain WS on localhost (127.0.0.1). Caddy fronts it with WSS+TLS.
  - Password-protected (no Origin lock — password is the security boundary).
  - Admin panel served at /admin (separate admin password).
  - Password authentication (user + admin passwords set separately).
  - Public chat + chat groups + activity feed + presence.
  - Admin can delete messages and send messages with admin badge.
  - Last 1000 messages retained; rate-limited; heartbeat.

Run:
    python3 server.py --password "user-secret"
                      [--admin-password "admin-secret"]
                      [--port 8080] [--host 127.0.0.1]
"""

import argparse
import base64
import hashlib
import json
import os
import re
import secrets
import signal
import socket
import struct
import sys
import threading
import time
from collections import deque

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
ORIGIN = "https://play.slidysim.com"  # Expected origin (display only, not enforced)
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8080

MAX_MESSAGES = 1000
MAX_ACTIVITY = 500
MAX_GROUP_MESSAGES = 1000
MAX_MESSAGE_LEN = 2000
MAX_NAME_LEN = 32
MAX_CLIENTS = 200
RATE_WINDOW = 10
RATE_MAX = 25
SERVER_NAME = "SlidySim Chat"
SERVER_VERSION = "3.0.0"

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------
PASSWORD = ""
ADMIN_PASSWORD = ""
HOST = DEFAULT_HOST
PORT = DEFAULT_PORT

state_lock = threading.RLock()
clients = {}
_messages = deque(maxlen=MAX_MESSAGES)
_activity = deque(maxlen=MAX_ACTIVITY)
groups = {}
server_start = time.time()
_shutdown = threading.Event()
_admin_html_cache = None


def log(msg):
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class Client:
    __slots__ = (
        "conn", "addr", "id", "name", "color", "authed", "is_admin",
        "share_status", "share_activity", "status_state", "status_detail",
        "groups", "write_lock", "recent", "connected_at", "alive",
    )

    def __init__(self, conn, addr):
        self.conn = conn
        self.addr = addr
        self.id = secrets.token_hex(8)
        self.name = "Anonymous"
        self.color = "#00f1ff"
        self.authed = False
        self.is_admin = False
        self.share_status = True
        self.share_activity = True
        self.status_state = "connecting"
        self.status_detail = ""
        self.groups = set()
        self.write_lock = threading.Lock()
        self.recent = []
        self.connected_at = time.time()
        self.alive = True

    def send(self, msg):
        if not self.alive:
            return
        data = json.dumps(msg, separators=(",", ":"))
        try:
            with self.write_lock:
                _write_frame(self.conn, data, opcode=0x1)
        except Exception:
            self.alive = False

    def public_info(self):
        return {
            "id": self.id,
            "name": self.name,
            "color": self.color,
            "status": self.status_state if self.share_status else "hidden",
            "statusDetail": self.status_detail if self.share_status else "",
            "sharingStatus": self.share_status,
            "sharingActivity": self.share_activity,
            "isAdmin": self.is_admin,
        }


class Group:
    __slots__ = ("id", "name", "owner_id", "members", "messages", "created_at")

    def __init__(self, gid, name, owner):
        self.id = gid
        self.name = name
        self.owner_id = owner.id
        self.members = {owner.id}
        self.messages = deque(maxlen=MAX_GROUP_MESSAGES)
        self.created_at = time.time()


# ---------------------------------------------------------------------------
# WebSocket frame I/O (RFC 6455)
# ---------------------------------------------------------------------------
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def _recv_exact(sock, n):
    if n == 0:
        return b""
    data = bytearray()
    while len(data) < n:
        chunk = sock.recv(n - len(data))
        if not chunk:
            raise ConnectionError("peer closed")
        data.extend(chunk)
    return bytes(data)


def _read_frame(sock):
    header = _recv_exact(sock, 2)
    b1, b2 = header[0], header[1]
    fin = bool(b1 & 0x80)
    opcode = b1 & 0x0F
    masked = bool(b2 & 0x80)
    plen = b2 & 0x7F
    if plen == 126:
        plen = struct.unpack("!H", _recv_exact(sock, 2))[0]
    elif plen == 127:
        plen = struct.unpack("!Q", _recv_exact(sock, 8))[0]
    if plen > 1024 * 1024:
        raise ValueError("frame too large")
    mask = _recv_exact(sock, 4) if masked else None
    payload = _recv_exact(sock, plen) if plen else b""
    if masked and payload:
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    return fin, opcode, payload


def _write_frame(sock, payload, opcode=0x1, fin=True):
    if isinstance(payload, str):
        payload = payload.encode("utf-8")
    b1 = (0x80 if fin else 0) | opcode
    frame = bytearray([b1])
    n = len(payload)
    if n < 126:
        frame.append(n)
    elif n < 65536:
        frame.append(126)
        frame.extend(struct.pack("!H", n))
    else:
        frame.append(127)
        frame.extend(struct.pack("!Q", n))
    frame.extend(payload)
    sock.sendall(bytes(frame))


def _write_close(sock, code=1000, reason=""):
    try:
        _write_frame(sock, struct.pack("!H", code) + reason.encode("utf-8"), opcode=0x8)
    except Exception:
        pass


def _read_message(sock):
    fragments = []
    orig_op = None
    while True:
        result = _read_frame(sock)
        if result is None:
            return None
        fin, opcode, payload = result
        if opcode == 0x8:
            return ("close", None)
        if opcode == 0x9:
            try:
                _write_frame(sock, payload, opcode=0xA)
            except Exception:
                return None
            continue
        if opcode == 0xA:
            return ("pong", None)
        if opcode in (0x1, 0x2):
            orig_op = opcode
            fragments.append(payload)
        elif opcode == 0x0:
            fragments.append(payload)
        if fin:
            data = b"".join(fragments)
            if orig_op == 0x1:
                return ("text", data.decode("utf-8", errors="replace"))
            return ("binary", data)


# ---------------------------------------------------------------------------
# HTTP handshake + page serving
# ---------------------------------------------------------------------------
def _websocket_handshake(conn):
    data = bytearray()
    while b"\r\n\r\n" not in data:
        try:
            chunk = conn.recv(4096)
        except Exception:
            return False, False
        if not chunk:
            return False, False
        data.extend(chunk)
        if len(data) > 65536:
            log("! handshake: request too large (>64KB)")
            return False, False

    request = data.decode("utf-8", errors="replace")
    lines = request.split("\r\n")

    # Parse request line: "GET /path HTTP/1.1"
    request_line = lines[0] if lines else ""
    parts = request_line.split()
    path = parts[1] if len(parts) >= 2 else "/"
    is_admin_path = path.startswith("/admin")

    headers = {}
    for line in lines[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()

    is_websocket = headers.get("upgrade", "").lower() == "websocket"

    if not is_websocket:
        log(f"  HTTP {request_line.strip()} (not WebSocket)")
        if is_admin_path:
            _serve_admin_page(conn)
        elif path == "/bridge":
            _serve_bridge_page(conn)
        else:
            _send_health_page(conn)
        return False, False

    key = headers.get("sec-websocket-key")
    if not key:
        log("! handshake: missing Sec-WebSocket-Key header")
        conn.sendall(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        return False, False

    # No Origin check — password authentication is the security boundary.
    # The admin path is additionally protected by a separate admin password.
    # (Origin checks are unreliable for WebSocket from userscripts — some
    # browsers/managers don't send the header, causing silent failures.)

    accept = base64.b64encode(
        hashlib.sha1((key + WS_GUID).encode("ascii")).digest()
    ).decode("ascii")
    response = (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {accept}\r\n"
        "\r\n"
    )
    conn.sendall(response.encode("ascii"))
    return True, is_admin_path


def _send_health_page(conn):
    uptime = int(time.time() - server_start)
    with state_lock:
        n_clients = len(clients)
        n_msgs = len(_messages)
        n_activity = len(_activity)
        n_groups = len(groups)
    h, m, s = uptime // 3600, (uptime % 3600) // 60, uptime % 60
    admin_status = "enabled" if ADMIN_PASSWORD else "disabled"
    body = (
        '<!doctype html><html><head><meta charset="utf-8">'
        f"<title>{SERVER_NAME}</title>"
        "<style>"
        "body{font-family:monospace;background:#0e0e0e;color:#e8e8e8;margin:0;padding:40px;}"
        "h1{color:#00f1ff;text-shadow:0 0 8px rgba(0,188,212,.3);}"
        "td{padding:4px 16px;border-bottom:1px solid #2a2a2a;}"
        "td:first-child{color:#888;}"
        "code{color:#00bcd4;}"
        "a{color:#00bcd4;}"
        "</style></head><body>"
        "<script>"
        "(function(){"
        "var p=location.protocol==='https:'?'wss:':'ws:';"
        "var u=p+'//'+location.host+'/ws';"
        "var w=null;"
        "function c(){"
        "w=new WebSocket(u);"
        "w.onopen=function(){parent.postMessage('__BRIDGE_OPEN__','*')};"
        "w.onclose=function(e){parent.postMessage('__BRIDGE_CLOSE__,'+e.code+','+(e.reason||'')+','+e.wasClean,'*');w=null};"
        "w.onerror=function(){parent.postMessage('__BRIDGE_ERROR__','*')};"
        "w.onmessage=function(ev){parent.postMessage(ev.data,'*')};"
        "}"
        "window.addEventListener('message',function(ev){"
        "var d=ev.data;"
        "if(typeof d!=='string')return;"
        "if(d==='__BRIDGE_DISCONNECT__'){if(w){w.onclose=null;w.close();w=null}return}"
        "if(w&&w.readyState===1)w.send(d)"
        "});"
        "c();"
        "})();"
        "</script>"
        f"<h1>{SERVER_NAME}</h1>"
        f"<p>Security: password-protected (no Origin lock)</p>"
        "<table>"
        f"<tr><td>Version</td><td>{SERVER_VERSION}</td></tr>"
        f"<tr><td>Uptime</td><td>{h:02d}:{m:02d}:{s:02d}</td></tr>"
        f"<tr><td>Connected clients</td><td>{n_clients}</td></tr>"
        f"<tr><td>Stored messages</td><td>{n_msgs} / {MAX_MESSAGES}</td></tr>"
        f"<tr><td>Activity events</td><td>{n_activity} / {MAX_ACTIVITY}</td></tr>"
        f"<tr><td>Active groups</td><td>{n_groups}</td></tr>"
        f"<tr><td>Admin panel</td><td>{admin_status}</td></tr>"
        "</table>"
        f'<p style="color:#555;margin-top:30px">Connect via WSS — any origin accepted (password required).</p>'
    )
    if ADMIN_PASSWORD:
        body += f'<p>Admin panel: <a href="/admin"><code>/admin</code></a></p>'
    body += "</body></html>"
    body_bytes = body.encode("utf-8")
    resp = (
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: text/html; charset=utf-8\r\n"
        f"Content-Length: {len(body_bytes)}\r\n"
        "Connection: close\r\n"
        "\r\n"
    )
    try:
        conn.sendall(resp.encode("ascii") + body_bytes)
    except Exception:
        pass


def _serve_bridge_page(conn):
    body = """<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>bridge</title></head>
<body>
<script>
(function(){
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var url = proto + '//' + location.host + '/ws';
  var ws = null;
  function connect(){
    ws = new WebSocket(url);
    ws.onopen = function(){ parent.postMessage('__BRIDGE_OPEN__', '*'); };
    ws.onclose = function(e){
      parent.postMessage('__BRIDGE_CLOSE__,' + e.code + ',' + (e.reason || '') + ',' + e.wasClean, '*');
      ws = null;
    };
    ws.onerror = function(){ parent.postMessage('__BRIDGE_ERROR__', '*'); };
    ws.onmessage = function(ev){ parent.postMessage(ev.data, '*'); };
  }
  window.addEventListener('message', function(ev){
    var d = ev.data;
    if (typeof d !== 'string') return;
    if (d === '__BRIDGE_DISCONNECT__'){
      if (ws) { ws.onclose = null; ws.close(); ws = null; }
      return;
    }
    if (ws && ws.readyState === 1) ws.send(d);
  });
  connect();
})();
</script>
</body>
</html>"""
    body_bytes = body.encode("utf-8")
    resp = (
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: text/html; charset=utf-8\r\n"
        f"Content-Length: {len(body_bytes)}\r\n"
        "Connection: close\r\n"
        "\r\n"
    )
    try:
        conn.sendall(resp.encode("ascii") + body_bytes)
    except Exception:
        pass


def _serve_admin_page(conn):
    global _admin_html_cache
    if not ADMIN_PASSWORD:
        body = b"<h1>Admin panel disabled</h1><p>Start the server with --admin-password to enable.</p>"
        resp = (
            "HTTP/1.1 404 Not Found\r\n"
            "Content-Type: text/html; charset=utf-8\r\n"
            f"Content-Length: {len(body)}\r\n"
            "Connection: close\r\n"
            "\r\n"
        )
        try:
            conn.sendall(resp.encode() + body)
        except Exception:
            pass
        return

    if _admin_html_cache is None:
        admin_html_path = os.path.join(_SCRIPT_DIR, "admin.html")
        if not os.path.exists(admin_html_path):
            body = b"<h1>admin.html not found</h1>"
            resp = (
                "HTTP/1.1 500 Internal Server Error\r\n"
                "Content-Type: text/html\r\n"
                f"Content-Length: {len(body)}\r\n"
                "Connection: close\r\n"
                "\r\n"
            )
            try:
                conn.sendall(resp.encode() + body)
            except Exception:
                pass
            return
        with open(admin_html_path, "r", encoding="utf-8") as f:
            _admin_html_cache = f.read()

    body_bytes = _admin_html_cache.encode("utf-8")
    resp = (
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: text/html; charset=utf-8\r\n"
        f"Content-Length: {len(body_bytes)}\r\n"
        "Connection: close\r\n"
        "\r\n"
    )
    try:
        conn.sendall(resp.encode("ascii") + body_bytes)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Broadcast helpers
# ---------------------------------------------------------------------------
def _broadcast(msg, group_id=None, exclude=None):
    with state_lock:
        if group_id is None:
            recipients = [c for c in clients.values() if c.authed]
        else:
            g = groups.get(group_id)
            if not g:
                return
            recipients = [clients[cid] for cid in g.members if cid in clients]
    for c in recipients:
        if exclude and c.id == exclude.id:
            continue
        c.send(msg)


def _presence_snapshot():
    with state_lock:
        return [c.public_info() for c in clients.values() if c.authed]


def _message_history(group_id=None, limit=None):
    with state_lock:
        if group_id is None:
            src = _messages
        else:
            g = groups.get(group_id)
            return list(g.messages) if g else []
        return list(src)[-limit:] if limit else list(src)


def _activity_history(limit=100):
    with state_lock:
        return list(_activity)[-limit:]


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------
_HEX_RE = re.compile(r"^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


def _is_valid_hex(c):
    return isinstance(c, str) and bool(_HEX_RE.match(c))


def _rate_limited(client):
    now = time.time()
    client.recent = [t for t in client.recent if now - t < RATE_WINDOW]
    if len(client.recent) >= RATE_MAX:
        return True
    client.recent.append(now)
    return False


# ---------------------------------------------------------------------------
# Message handlers
# ---------------------------------------------------------------------------
def handle_auth(client, data):
    is_admin = bool(data.get("admin", False))

    if is_admin:
        admin_pw = data.get("adminPassword", "")
        if not ADMIN_PASSWORD or admin_pw != ADMIN_PASSWORD:
            client.send({"type": "auth_fail", "reason": "Invalid admin password"})
            return False
        client.is_admin = True
        name = str(data.get("name") or "Admin").strip()[:MAX_NAME_LEN] or "Admin"
        color = str(data.get("color") or "#ff2262").strip()[:32]
        if not _is_valid_hex(color):
            color = "#ff2262"
        client.share_status = False  # admin doesn't share slidysim status
        client.share_activity = False
        client.status_state = "admin"
        client.status_detail = "Admin panel"
    else:
        pw = data.get("password", "")
        if pw != PASSWORD:
            client.send({"type": "auth_fail", "reason": "Invalid password"})
            return False
        client.is_admin = False
        name = str(data.get("name") or "").strip()[:MAX_NAME_LEN]
        color = str(data.get("color") or "#00f1ff").strip()[:32]
        feats = data.get("features") or {}
        if not name:
            name = "Egg#" + str(1000 + secrets.randbelow(9000))
        if not _is_valid_hex(color):
            color = "#00f1ff"
        client.share_status = bool(feats.get("shareStatus", True))
        client.share_activity = bool(feats.get("shareActivity", True))
        client.status_state = "menu"
        client.status_detail = ""

    client.name = name
    client.color = color
    client.authed = True

    with state_lock:
        if len(clients) >= MAX_CLIENTS:
            client.authed = False
            client.send({"type": "auth_fail", "reason": "Server full, try again later"})
            return False
        clients[client.id] = client

    client.send({
        "type": "auth_ok", "userId": client.id, "isAdmin": client.is_admin,
        "serverTime": time.time(), "maxMessages": MAX_MESSAGES,
        "serverName": SERVER_NAME, "version": SERVER_VERSION,
    })
    client.send({"type": "presence", "users": _presence_snapshot()})
    client.send({"type": "history", "messages": _message_history(), "groupId": None})
    client.send({"type": "activity_history", "events": _activity_history()})
    _broadcast({"type": "user_join", "user": client.public_info()}, exclude=client)
    log(f"+ {'admin ' if client.is_admin else ''}'{name}' connected ({client.addr[0]}:{client.addr[1]})")
    return True


def handle_chat(client, data):
    if not client.authed:
        return
    text = str(data.get("text") or "")[:MAX_MESSAGE_LEN]
    if not text.strip():
        return
    if _rate_limited(client):
        client.send({"type": "error", "code": "rate_limited",
                     "message": "You are sending messages too fast."})
        return

    group_id = data.get("groupId")

    if group_id is not None:
        with state_lock:
            g = groups.get(group_id)
            if not g or client.id not in g.members:
                client.send({"type": "error", "code": "not_in_group",
                             "message": "You are not a member of that group."})
                return

    msg = {
        "type": "chat", "id": secrets.token_hex(8),
        "userId": client.id, "name": client.name, "color": client.color,
        "text": text, "timestamp": time.time(),
        "groupId": group_id, "isAdmin": client.is_admin,
    }
    with state_lock:
        if group_id is None:
            _messages.append(msg)
        else:
            groups[group_id].messages.append(msg)
    _broadcast(msg, group_id=group_id, exclude=client)


def handle_delete_message(client, data):
    if not client.authed or not client.is_admin:
        client.send({"type": "error", "code": "forbidden",
                     "message": "Admin privileges required."})
        return
    msg_id = data.get("id")
    group_id = data.get("groupId")
    if not msg_id:
        return
    with state_lock:
        if group_id is None:
            target = _messages
        else:
            g = groups.get(group_id)
            target = g.messages if g else None
        if target:
            for i, m in enumerate(target):
                if m["id"] == msg_id:
                    del target[i]
                    break
    _broadcast({"type": "message_deleted", "id": msg_id, "groupId": group_id})


def handle_status(client, data):
    if not client.authed or client.is_admin:
        return  # admin status is fixed
    state = str(data.get("state") or "menu")[:32]
    detail = str(data.get("detail") or "")[:120]
    share = bool(data.get("share", client.share_status))
    client.share_status = share
    if share:
        client.status_state = state
        client.status_detail = detail
    else:
        client.status_state = "hidden"
        client.status_detail = ""
    _broadcast({
        "type": "status_update", "userId": client.id,
        "status": client.status_state, "statusDetail": client.status_detail,
        "sharingStatus": client.share_status,
    }, exclude=client)


def handle_activity(client, data):
    if not client.authed or not client.share_activity or client.is_admin:
        return
    event = {
        "type": "activity", "id": secrets.token_hex(8),
        "userId": client.id, "name": client.name, "color": client.color,
        "eventType": str(data.get("eventType") or "solve")[:32],
        "session": str(data.get("session") or "")[:80],
        "solveNumber": data.get("solveNumber"),
        "time": str(data.get("time") or "")[:32],
        "moves": str(data.get("moves") or "")[:32],
        "tps": str(data.get("tps") or "")[:32],
        "isDNF": bool(data.get("isDNF", False)),
        "timestamp": time.time(),
    }
    with state_lock:
        _activity.append(event)
    _broadcast(event, exclude=client)


def handle_group_create(client, data):
    if not client.authed or client.is_admin:
        return
    name = str(data.get("name") or "").strip()[:64]
    if not name:
        client.send({"type": "error", "code": "bad_name", "message": "Group name required."})
        return
    gid = secrets.token_hex(8)
    with state_lock:
        if len(groups) > 500:
            client.send({"type": "error", "code": "too_many_groups", "message": "Too many groups."})
            return
        g = Group(gid, name, client)
        groups[gid] = g
        client.groups.add(gid)
    client.send({"type": "group_created", "groupId": gid, "name": name, "ownerId": client.id})
    client.send({"type": "group_state", "groupId": gid, "name": name,
                 "members": [client.public_info()], "messages": []})


def handle_group_invite(client, data):
    if not client.authed or client.is_admin:
        return
    gid = data.get("groupId")
    target_id = data.get("userId")
    target_name = data.get("name")
    with state_lock:
        g = groups.get(gid)
        if not g:
            client.send({"type": "error", "code": "no_group", "message": "Group not found."})
            return
        if client.id not in g.members:
            client.send({"type": "error", "code": "not_in_group",
                         "message": "You are not in that group."})
            return
        target = clients.get(target_id) if target_id else None
        if not target and target_name:
            for c in clients.values():
                if c.authed and c.name == target_name:
                    target = c
                    break
        if not target or not target.authed:
            client.send({"type": "error", "code": "user_not_found",
                         "message": "User is not online."})
            return
        if target.id in g.members:
            client.send({"type": "error", "code": "already_in_group",
                         "message": "User is already in the group."})
            return
        target.send({"type": "group_invite", "groupId": gid, "name": g.name,
                     "inviterId": client.id, "inviterName": client.name})


def handle_group_join(client, data):
    if not client.authed or client.is_admin:
        return
    gid = data.get("groupId")
    with state_lock:
        g = groups.get(gid)
        if not g:
            client.send({"type": "error", "code": "no_group", "message": "Group not found."})
            return
        if client.id in g.members:
            return
        g.members.add(client.id)
        client.groups.add(gid)
        members_info = [clients[cid].public_info() for cid in g.members if cid in clients]
    client.send({"type": "group_state", "groupId": gid, "name": g.name,
                 "members": members_info, "messages": list(g.messages)})
    _broadcast({"type": "group_user_joined", "groupId": gid,
                "user": client.public_info()}, group_id=gid, exclude=client)


def handle_group_leave(client, data):
    if not client.authed or client.is_admin:
        return
    gid = data.get("groupId")
    with state_lock:
        g = groups.get(gid)
        if not g or client.id not in g.members:
            return
        g.members.discard(client.id)
        client.groups.discard(gid)
        if not g.members:
            del groups[gid]
    _broadcast({"type": "group_user_left", "groupId": gid, "userId": client.id},
               group_id=gid)


def handle_typing(client, data):
    if not client.authed:
        return
    group_id = data.get("groupId")
    is_typing = bool(data.get("isTyping", True))
    _broadcast({"type": "typing", "userId": client.id, "name": client.name,
                "color": client.color, "groupId": group_id, "isTyping": is_typing},
               group_id=group_id, exclude=client)


def handle_recolor(client, data):
    if not client.authed:
        return
    color = str(data.get("color") or "#00f1ff").strip()[:32]
    if not _is_valid_hex(color):
        return
    client.color = color
    _broadcast({"type": "user_recolored", "userId": client.id,
                "name": client.name, "color": color}, exclude=client)


_DISPATCH = {
    "auth": handle_auth,
    "chat": handle_chat,
    "delete_message": handle_delete_message,
    "status": handle_status,
    "activity": handle_activity,
    "group_create": handle_group_create,
    "group_invite": handle_group_invite,
    "group_join": handle_group_join,
    "group_leave": handle_group_leave,
    "typing": handle_typing,
    "recolor": handle_recolor,
}


def _handle_message(client, raw):
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return
    t = data.get("type")
    handler = _DISPATCH.get(t)
    if not handler:
        if t == "ping":
            client.send({"type": "pong", "timestamp": time.time()})
        return
    try:
        handler(client, data)
    except Exception as e:
        log(f"! handler error ({t}): {e}")
        client.send({"type": "error", "code": "internal", "message": "Server error."})


# ---------------------------------------------------------------------------
# Client lifecycle
# ---------------------------------------------------------------------------
def _handle_client(conn, addr):
    client = Client(conn, addr)
    log(f"> TCP from {addr[0]}:{addr[1]}")
    try:
        try:
            conn.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
            if hasattr(socket, "TCP_KEEPIDLE"):
                conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPIDLE, 60)
                conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPINTVL, 30)
                conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPCNT, 3)
        except Exception:
            pass

        success, is_admin_path = _websocket_handshake(conn)
        if not success:
            return
        log(f"< WS upgrade ok ({'admin' if is_admin_path else 'user'} path) from {addr[0]}:{addr[1]}")
        client.send({"type": "hello", "serverName": SERVER_NAME,
                     "maxMessages": MAX_MESSAGES, "version": SERVER_VERSION})
        conn.settimeout(90)
        waiting_pong = False

        while client.alive and not _shutdown.is_set():
            try:
                result = _read_message(conn)
            except socket.timeout:
                if waiting_pong:
                    break
                try:
                    _write_frame(conn, b"hb", opcode=0x9)
                    waiting_pong = True
                    conn.settimeout(30)
                except Exception:
                    break
                continue
            except (ConnectionError, OSError, ValueError, struct.error):
                break

            if result is None:
                break
            kind, payload = result
            if kind == "close":
                break
            if kind == "pong":
                waiting_pong = False
                conn.settimeout(90)
                continue
            if kind == "text":
                conn.settimeout(90)
                _handle_message(client, payload)
    except Exception as e:
        log(f"! client {addr} error: {e}")
    finally:
        _cleanup_client(client)


def _cleanup_client(client):
    if client.authed:
        with state_lock:
            clients.pop(client.id, None)
            for gid in list(client.groups):
                g = groups.get(gid)
                if g:
                    g.members.discard(client.id)
                    if not g.members:
                        del groups[gid]
                    else:
                        for cid in g.members:
                            c = clients.get(cid)
                            if c:
                                c.send({"type": "group_user_left",
                                        "groupId": gid, "userId": client.id})
        _broadcast({"type": "user_leave", "userId": client.id})
        log(f"- {'admin ' if client.is_admin else ''}'{client.name}' disconnected")
    client.alive = False
    _write_close(client.conn, 1001, "bye")
    try:
        client.conn.close()
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Server entry
# ---------------------------------------------------------------------------
def _start_server():
    log("")
    log("=" * 60)
    log(f"  {SERVER_NAME} v{SERVER_VERSION}")
    log("=" * 60)
    log(f"  Bind        : {HOST}:{PORT}")
    log(f"  Origin      : any (password-protected)")
    log(f"  Admin panel : {'enabled at /admin' if ADMIN_PASSWORD else 'disabled'}")
    log(f"  Max clients : {MAX_CLIENTS}")
    log(f"  Max msgs    : {MAX_MESSAGES}")
    log("=" * 60)
    if HOST == "127.0.0.1":
        log("  Localhost-only. Caddy proxies WSS -> this.")
    log("")

    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        srv.bind((HOST, PORT))
    except OSError as e:
        log(f"FATAL: cannot bind {HOST}:{PORT} -> {e}")
        sys.exit(1)
    srv.listen(128)

    def shutdown(sig, frame):
        log("Shutting down…")
        _shutdown.set()
        with state_lock:
            for c in list(clients.values()):
                c.alive = False
                _write_close(c.conn, 1001, "server shutdown")
                try:
                    c.conn.close()
                except Exception:
                    pass
        try:
            srv.close()
        except Exception:
            pass
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    log("Waiting for connections…")
    while not _shutdown.is_set():
        try:
            conn, addr = srv.accept()
        except OSError:
            continue
        except Exception:
            if _shutdown.is_set():
                break
            continue
        try:
            conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except Exception:
            pass
        t = threading.Thread(target=_handle_client, args=(conn, addr), daemon=True)
        t.start()


def main():
    global PASSWORD, ADMIN_PASSWORD, HOST, PORT

    parser = argparse.ArgumentParser(
        description=f"{SERVER_NAME} server",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "This server runs plain WebSocket on localhost. Use start.sh to\n"
            "automatically start Caddy (auto Let's Encrypt TLS) in front of it.\n\n"
            "Origin: any (password-protected, no Origin lock).\n"
            "Admin panel at /admin uses a separate admin password.\n\n"
            "Example:\n"
            "  python3 server.py --password 's3cret' --admin-password 'adm1n'\n"
        ),
    )
    parser.add_argument("--password", default=os.environ.get("CHAT_PASSWORD", ""),
                        help="User chat password (required).")
    parser.add_argument("--admin-password", default=os.environ.get("CHAT_ADMIN_PASSWORD", ""),
                        help="Admin panel password (optional).")
    parser.add_argument("--host", default=DEFAULT_HOST,
                        help=f"Bind host (default: {DEFAULT_HOST}).")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT,
                        help=f"Port (default: {DEFAULT_PORT}).")
    args = parser.parse_args()

    if not args.password:
        parser.error("--password is required (or set CHAT_PASSWORD env var)")

    PASSWORD = args.password
    ADMIN_PASSWORD = args.admin_password
    HOST = args.host
    PORT = args.port

    _start_server()


if __name__ == "__main__":
    main()
