// ==UserScript==
// @name         SlidySim Chat
// @namespace    dphdmn
// @version      0.0.23
// @description  Floating public chat for play.slidysim.com — status sharing, solve activity feed, chat groups. Dark neon UI.
// @author       dphdmn
// @match        https://play.slidysim.com/*
// @grant        GM_info
// @run-at       document-idle
// @license      MIT
// @icon         data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🥚</text></svg>
// ==/UserScript==

/* eslint-disable no-console */
(function SlidySimChat() {
  'use strict';

  // ===========================================================================
  // CONFIG — change SERVER_URL to your VPS's sslip.io domain (printed by server)
  // ===========================================================================
  const SERVER_URL = (typeof window !== 'undefined' && window.SLIDY_CHAT_SERVER_URL)
    || 'wss://slidychat.duckdns.org/ws'; // <-- CHANGE THIS to your server's WSS URL
  const SERVER_ORIGIN = new URL(SERVER_URL.replace(/^wss?:\/\//, 'https://')).origin;
  const VERSION = GM_info.script.version;
  const STORAGE_KEY = 'slidysim_chat_settings_v3';
  const PASSWORD_KEY = 'slidysim_chat_password_v3';
  const MAX_RENDERED = 200;
  const INITIAL_RENDER = 80;
  const LOAD_MORE = 40;
  const RECONNECT_MIN = 1000;
  const RECONNECT_MAX = 30000;
  const TYPING_TIMEOUT = 4000;
  const TYPING_THROTTLE = 1500;
  const STATUS_DEBOUNCE = 400;

  // Egg-themed + silly emoji whitelist (no arbitrary emoji)
  const ALLOWED_EMOJIS = [
    '🥚', '🍳', '🐣', '🐤', '🐥', '🪺',   // eggs
    '🤪', '💤', '🤡', '🫠', '🥴', '🤯',   // zany + zzz + silly
    '👀', '💀', '🔥', '💯', '🎉', '😂',   // silly
    '🫡', '🥸', '🤓', '🫨',              // more silly
  ];

  // ===========================================================================
  // STATE
  // ===========================================================================
  const S = {
    bridgeIframe: null,
    bridgeOpen: false,
    myId: null,
    myName: null,
    myColor: (() => {
      const colors = ['#ff00ff','#ff66ff','#8000ff','#a14dff','#0080ff','#47a1fb','#70b9ff','#00d269','#79e389','#ffd700','#ffe85f','#ff2262','#ec44ca','#b9f2ff','#2fcfc2','#85fa85','#ffaaf4','#ffff00'];
      return colors[Math.floor(Math.random() * colors.length)];
    })(),
    authed: false,
    connState: 'disconnected',
    reconnectDelay: RECONNECT_MIN,
    reconnectTimer: null,
    users: new Map(),
    recentJoins: [],
    messages: [],
    activity: [],
    groups: new Map(),
    pendingInvites: [],
    pendingGroupInvite: null,     // {userId, userName, groupName} — fire after group_created
    tab: 'chat',
    chatTarget: null,
    minimized: false,
    chatPos: { x: null, y: null },
    miniPos: { x: null, y: null },
    isAtBottom: true,
    renderedCount: INITIAL_RENDER,
    lastTypingSent: 0,
    typingUsers: new Map(),
    activityFilter: { user: 'all', hideDNF: false, hidden: new Set() },
    scrambled: false,
    lastSolveSignature: null,    // prevent duplicate solve events on session switch
    lastStatus: null,
    shareStatus: true,
    shareActivity: true,
    ui: {},
    observer: null,
    settings_serverUrl: null,
    unreadPerTab: { chat: 0, activity: 0, groups: 0, logs: 0 },
    newMsgsBadge: 0,
    debugLog: [],
  };

  function dlog(msg, level) {
    level = level || 'info';
    const entry = { ts: new Date().toISOString(), level: level, msg: String(msg) };
    S.debugLog.push(entry);
    if (S.debugLog.length > 200) S.debugLog.shift();
    if (level === 'error') console.error('[slidy-chat]', msg);
    else console.log('[slidy-chat]', msg);
    if (S.tab === 'logs') renderLogs();
  }

  // ===========================================================================
  // UTILITIES
  // ===========================================================================
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function formatTime(ts) {
    const d = new Date(ts * 1000);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function formatFullTime(ts) {
    return new Date(ts * 1000).toLocaleString();
  }

  function randomEggName() {
    return 'Egg#' + (1000 + Math.floor(Math.random() * 9000));
  }

  function debounce(fn, ms) {
    let t = null;
    return function (...args) {
      if (t) clearTimeout(t);
      t = setTimeout(() => { t = null; fn.apply(this, args); }, ms);
    };
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function isValidHexColor(c) {
    return typeof c === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(c);
  }

  // ===========================================================================
  // STORAGE
  // ===========================================================================
  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const s = raw ? JSON.parse(raw) : {};
      if (typeof s.shareStatus === 'boolean') S.shareStatus = s.shareStatus;
      if (typeof s.shareActivity === 'boolean') S.shareActivity = s.shareActivity;
      if (typeof s.chatPos === 'object' && s.chatPos) S.chatPos = s.chatPos;
      if (typeof s.miniPos === 'object' && s.miniPos) S.miniPos = s.miniPos;
      // migrate old single pos to chatPos
      if (typeof s.pos === 'object' && s.pos && !(s.chatPos && s.chatPos.x != null)) S.chatPos = s.pos;
      if (typeof s.minimized === 'boolean') S.minimized = s.minimized;
      if (typeof s.tab === 'string') S.tab = s.tab;
      if (typeof s.serverUrl === 'string' && s.serverUrl) S.settings_serverUrl = s.serverUrl;
    } catch (e) { /* ignore */ }
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        shareStatus: S.shareStatus,
        shareActivity: S.shareActivity,
        chatPos: S.chatPos,
        miniPos: S.miniPos,
        minimized: S.minimized,
        tab: S.tab,
        serverUrl: S.settings_serverUrl || null,
      }));
    } catch (e) { /* ignore */ }
  }

  function getPassword() {
    let pw = localStorage.getItem(PASSWORD_KEY);
    if (!pw) {
      pw = prompt('SlidySim Chat\n\nEnter the chat password:');
      if (pw) localStorage.setItem(PASSWORD_KEY, pw);
    }
    return pw;
  }

  function setPassword(pw) {
    if (pw) localStorage.setItem(PASSWORD_KEY, pw);
    else localStorage.removeItem(PASSWORD_KEY);
  }

  // ===========================================================================
  // USERNAME EXTRACTION
  // ===========================================================================
  function getUsername() {
    return new Promise((resolve) => {
      try {
        const el = document.querySelector('.user-menu .username');
        if (el && el.textContent && el.textContent.trim()) {
          resolve(el.textContent.trim().slice(0, 32));
          return;
        }
      } catch (e) { /* ignore */ }
      const obs = new MutationObserver(() => {
        try {
          const el = document.querySelector('.user-menu .username');
          if (el && el.textContent && el.textContent.trim()) {
            obs.disconnect();
            resolve(el.textContent.trim().slice(0, 32));
          }
        } catch (e) { /* ignore */ }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        obs.disconnect();
        try {
          const el = document.querySelector('.user-menu .username');
          if (el && el.textContent && el.textContent.trim()) {
            resolve(el.textContent.trim().slice(0, 32));
          } else {
            resolve(randomEggName());
          }
        } catch (e) { resolve(randomEggName()); }
      }, 5000);
    });
  }

  // ===========================================================================
  // WEBSOCKET CLIENT
  // ===========================================================================
  function connect() {
    if (S.bridgeOpen) return;
    const url = S.settings_serverUrl || SERVER_URL;
    setConnState('connecting');
    dlog('Connecting via bridge at ' + url);

    const httpsUrl = url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/$/, '') + '/';
    dlog('Testing HTTPS reachability: ' + httpsUrl);
    fetch(httpsUrl, { method: 'GET', mode: 'no-cors' })
      .then(() => dlog('HTTPS fetch OK'))
      .catch((e) => dlog('HTTPS fetch failed: ' + e.message, 'error'));

    if (S.bridgeIframe) {
      try { S.bridgeIframe.contentWindow.postMessage('__BRIDGE_DISCONNECT__', SERVER_ORIGIN); } catch (e) {}
      S.bridgeIframe.parentNode.removeChild(S.bridgeIframe);
      S.bridgeIframe = null;
    }
    S.bridgeOpen = false;
    S.authed = false;

    if (S.connTimer) { clearTimeout(S.connTimer); S.connTimer = null; }
    S.connTimer = setTimeout(() => {
      if (!S.bridgeOpen) {
        dlog('Bridge timeout: no __BRIDGE_OPEN__ after 10s. Iframe loaded? ' + (S.bridgeIframe && S.bridgeIframe.contentWindow ? 'yes' : 'no'), 'error');
        dlog('Iframe src: ' + (S.bridgeIframe ? S.bridgeIframe.src : '(none)'), 'error');
      }
    }, 10000);

    const iframe = document.createElement('iframe');
    iframe.src = SERVER_ORIGIN + '/?_=' + Date.now();
    iframe.style.cssText = 'display:none!important;width:1px;height:1px;border:0;position:absolute;left:-9999px';
    iframe.setAttribute('tabindex', '-1');
    iframe.setAttribute('aria-hidden', 'true');
    document.body.appendChild(iframe);
    S.bridgeIframe = iframe;
  }

  function scheduleReconnect() {
    if (S.reconnectTimer) return;
    S.reconnectTimer = setTimeout(() => {
      S.reconnectTimer = null;
      S.reconnectDelay = Math.min(S.reconnectDelay * 1.7, RECONNECT_MAX);
      connect();
    }, S.reconnectDelay);
  }

  function disconnect() {
    S.authed = false;
    S.bridgeOpen = false;
    if (S.bridgeIframe) {
      try { S.bridgeIframe.contentWindow.postMessage('__BRIDGE_DISCONNECT__', SERVER_ORIGIN); } catch (e) {}
      S.bridgeIframe.parentNode.removeChild(S.bridgeIframe);
      S.bridgeIframe = null;
    }
  }

  function send(obj) {
    if (S.bridgeIframe && S.bridgeIframe.contentWindow && S.bridgeOpen) {
      try { S.bridgeIframe.contentWindow.postMessage(JSON.stringify(obj), SERVER_ORIGIN); return true; }
      catch (e) { console.warn('[slidy-chat] send failed', e); }
    }
    return false;
  }

  function setConnState(state) {
    S.connState = state;
    if (!S.ui.statusDot) return;
    S.ui.statusDot.className = 'sc-status-dot ' + (
      state === 'authed' ? 'connected' :
      state === 'connected' ? 'connected' :
      state === 'connecting' ? 'connecting' :
      state === 'error' ? 'error' : ''
    );
    if (S.ui.connStatus) {
      const labels = { authed: '', connected: '', connecting: 'connecting…', error: 'error', disconnected: 'offline' };
      S.ui.connStatus.textContent = labels[state] || '';
      S.ui.connStatus.className = 'sc-conn-status' + (labels[state] ? ' ' + state : '');
    }
    // Disable input/send when not authed
    const enabled = state === 'authed';
    if (S.ui.input) S.ui.input.disabled = !enabled;
    if (S.ui.send) S.ui.send.disabled = !enabled;
    if (S.ui.emojiBtn) S.ui.emojiBtn.disabled = !enabled;
    if (S.ui.input) {
      S.ui.input.placeholder = enabled
        ? 'Message… /rs = latest solve in chat'
        : 'Connecting…';
    }
    // Add/remove disabled class on chat body
    if (S.ui.chat) {
      S.ui.chat.classList.toggle('sc-disabled', !enabled);
    }
  }

  // ===========================================================================
  // BRIDGE – iframe relay (bypasses CSP by loading from server's own origin)
  // ===========================================================================

  function setupBridgeListener() {
    window.addEventListener('message', function (ev) {
      if (ev.origin !== SERVER_ORIGIN) return;
      const data = ev.data;
      if (typeof data !== 'string') return;

      if (data === '__BRIDGE_OPEN__') {
        if (S.connTimer) { clearTimeout(S.connTimer); S.connTimer = null; }
        S.bridgeOpen = true;
        dlog('Bridge connected, waiting for hello\u2026');
        S.reconnectDelay = RECONNECT_MIN;
        setConnState('connected');
        return;
      }
      if (data.startsWith('__BRIDGE_LOG__,')) {
        dlog('[bridge] ' + data.slice(14));
        return;
      }
      if (data.startsWith('__BRIDGE_CLOSE__,')) {
        if (S.connTimer) { clearTimeout(S.connTimer); S.connTimer = null; }
        S.authed = false;
        S.bridgeOpen = false;
        const parts = data.split(',');
        const code = parseInt(parts[1]) || 0;
        const reason = parts[2] || '';
        const wasClean = parts[3] === 'true';
        dlog('Bridge closed: code=' + code + ' reason=' + (reason || '(empty)') + ' wasClean=' + wasClean, code !== 1000 ? 'error' : 'info');
        if (code === 1006) {
          dlog('Code 1006 = abnormal closure (no close frame received).', 'error');
          dlog('Check the HTTPS reachability test result above in this log:', 'error');
          dlog('  \u2022 No result yet \u2192 fetch may also be blocked', 'error');
          dlog('  \u2022 OK \u2192 server reachable; check server logs for handshake errors', 'error');
          dlog('  \u2022 Failed \u2192 network/TLS issue (DNS, firewall, cert, proxy)', 'error');
          toast('Connection rejected. Check Logs tab.');
        }
        setConnState('disconnected');
        scheduleReconnect();
        return;
      }
      if (data === '__BRIDGE_ERROR__') {
        S.bridgeOpen = false;
        dlog('Bridge WebSocket error', 'error');
        setConnState('error');
        return;
      }
      try { handleMessage(JSON.parse(data)); }
      catch (e) { dlog('Bad message: ' + e, 'error'); }
    });
  }

  // ===========================================================================
  // MESSAGE HANDLERS (server -> client)
  // ===========================================================================
  async function handleMessage(data) {
    switch (data.type) {
      case 'hello':            await onHello(data); break;
      case 'auth_ok':          onAuthOk(data); break;
      case 'auth_fail':        onAuthFail(data); break;
      case 'presence':         onPresence(data); break;
      case 'user_join':        onUserJoin(data); break;
      case 'user_leave':       onUserLeave(data); break;
      case 'user_renamed':     break; // removed — no rename feature
      case 'user_recolored':   onUserRecolored(data); break;
      case 'chat':             onChat(data); break;
      case 'history':          onHistory(data); break;
      case 'status_update':    onStatusUpdate(data); break;
      case 'activity':         onActivity(data); break;
      case 'activity_history': onActivityHistory(data); break;
      case 'group_created':    onGroupCreated(data); break;
      case 'group_invite':     onGroupInvite(data); break;
      case 'group_state':      onGroupState(data); break;
      case 'group_user_joined':onGroupUserJoined(data); break;
      case 'group_user_left':  onGroupUserLeft(data); break;
      case 'message_deleted': onMessageDeleted(data); break;
      case 'typing':           onTyping(data); break;
      case 'error':            onError(data); break;
      case 'pong':             break;
    }
  }

  async function onHello() {
    dlog('Received hello from server, sending auth\u2026');
    const pw = getPassword();
    if (!pw) {
      dlog('No password set, prompting user\u2026', 'warn');
      toast('No password set. Open settings (\u2699) to enter one.');
      setConnState('error');
      disconnect();
      return;
    }
    S.myName = await getUsername();
    dlog('Authenticating as: ' + S.myName);
    send({
      type: 'auth', password: pw, name: S.myName, color: S.myColor,
      features: { shareStatus: S.shareStatus, shareActivity: S.shareActivity },
    });
  }

  function onAuthOk(data) {
    dlog('Auth OK! userId=' + data.userId);
    S.myId = data.userId;
    S.authed = true;
    setConnState('authed');
    detectAndSendStatus(true);
    initScrambledState();
  }

  function onAuthFail(data) {
    setConnState('error');
    toast('Auth failed: ' + (data.reason || 'invalid password'));
    setPassword(null);
    disconnect();
    setTimeout(() => {
      const pw = prompt('SlidySim Chat\n\n' + (data.reason || 'Auth failed') + '\n\nEnter the chat password:');
      if (pw) { setPassword(pw); connect(); }
    }, 500);
  }

  function onPresence(data) {
    S.users.clear();
    S.recentJoins = [];
    for (const u of data.users) {
      S.users.set(u.id, u);
      if (u.id !== S.myId && !u.name.startsWith('Egg') && !u.isAdmin && S.recentJoins.length < 5) {
        S.recentJoins.push({ id: u.id, name: u.name, color: u.color });
      }
    }
    renderUsers();
    renderOnlineCount();
    renderRecentUsers();
  }

  function onUserJoin(data) {
    S.users.set(data.user.id, data.user);
    renderUsers();
    renderOnlineCount();
      S.recentJoins = S.recentJoins.filter(j => j.id !== data.user.id);
    if (data.user.name.startsWith('Egg') || data.user.isAdmin) return;
    S.recentJoins.unshift({ id: data.user.id, name: data.user.name, color: data.user.color });
    if (S.recentJoins.length > 10) S.recentJoins.length = 10;
    renderRecentUsers();
    if (data.user.id !== S.myId) addSystemMessage(data.user.name + ' joined');
  }

  function onUserLeave(data) {
    const u = S.users.get(data.userId);
    S.users.delete(data.userId);
    S.recentJoins = S.recentJoins.filter(j => j.id !== data.userId);
    for (const key of S.typingUsers.keys()) {
      if (key.startsWith(data.userId + '|')) S.typingUsers.delete(key);
    }
    renderUsers();
    renderOnlineCount();
    renderRecentUsers();
    renderTyping();
    if (u) addSystemMessage(u.name + ' left');
  }

  function onUserRenamed(data) {
    const u = S.users.get(data.userId);
    if (u) { u.name = data.name; renderUsers(); }
    const rj = S.recentJoins.find(j => j.id === data.userId);
    if (rj) { rj.name = data.name; renderRecentUsers(); }
    if (data.userId === S.myId) S.myName = data.name;
    renderChatMessages();
  }

  function onUserRecolored(data) {
    const u = S.users.get(data.userId);
    if (u) { u.color = data.color; renderUsers(); }
    const rj = S.recentJoins.find(j => j.id === data.userId);
    if (rj) { rj.color = data.color; renderRecentUsers(); }
    if (data.userId === S.myId) S.myColor = data.color;
    renderChatMessages();
  }

  function onChat(data) {
    appendMessage(data);
    const myName = S.myName;
    if (data.userId !== S.myId && myName && data.text && new RegExp('@' + myName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(data.text)) {
      toast('@mentioned by ' + (data.name || 'someone') + ': ' + data.text.slice(0, 80));
    }
    if (data.groupId) {
      if (S.tab !== 'chat' || S.chatTarget !== data.groupId) {
        S.unreadPerTab.groups++;
        renderTabBadges();
      }
    } else {
      if (S.tab !== 'chat' || S.chatTarget !== null || S.minimized) {
        S.unreadPerTab.chat++;
        renderTabBadges();
      }
    }
  }

  function onHistory(data) {
    if (data.groupId) {
      const g = S.groups.get(data.groupId);
      if (g) { g.messages = data.messages || []; if (S.chatTarget === data.groupId) renderChatMessages(); }
    } else {
      S.messages = data.messages || [];
      if (S.chatTarget === null) renderChatMessages();
    }
  }

  function onStatusUpdate(data) {
    const u = S.users.get(data.userId);
    if (u) {
      u.status = data.status;
      u.statusDetail = data.statusDetail;
      u.sharingStatus = data.sharingStatus;
      renderUsers();
    }
  }

  function onActivity(data) {
    S.activity.push(data);
    if (S.activity.length > 1000) S.activity.shift();
    if (S.tab !== 'activity') { S.unreadPerTab.activity++; renderTabBadges(); return; }
    const visible = S.activityFilter.user === 'all' && !S.activityFilter.hidden.has(data.name);
    if (visible) {
      const el = createActivityEl(data);
      el.classList.add('sc-act-new');
      S.ui.actList.prepend(el);
      const empty = S.ui.actList.querySelector('.sc-empty');
      if (empty) empty.remove();
      while (S.ui.actList.children.length > 300) S.ui.actList.lastChild.remove();
    } else {
      renderActivity(true);
    }
    updateUserFilter();
    renderHiddenUsers();
  }

  function onActivityHistory(data) {
    S.activity = data.events || [];
    renderActivity();
  }

  function onGroupCreated(data) {
    const g = { id: data.groupId, name: data.name, members: [{ id: S.myId, name: S.myName, color: S.myColor }], messages: [] };
    S.groups.set(data.groupId, g);
    renderGroups();
    S.chatTarget = data.groupId;
    updateChatTargetSelector();
    switchTab('chat');
    renderChatMessages();
    toast('Group "' + data.name + '" created');

    // Fire pending invite if any
    if (S.pendingGroupInvite && S.pendingGroupInvite.groupName === data.name) {
      sendGroupInvite(data.groupId, S.pendingGroupInvite.userId);
      toast('Invited ' + S.pendingGroupInvite.userName + ' to "' + data.name + '"');
      S.pendingGroupInvite = null;
    }
  }

  function onGroupInvite(data) {
    S.pendingInvites.push(data);
    renderGroups();
    if (S.tab !== 'groups') { S.unreadPerTab.groups++; renderTabBadges(); }
    toast(data.inviterName + ' invited you to "' + data.name + '"');
  }

  function onGroupState(data) {
    S.groups.set(data.groupId, {
      id: data.groupId, name: data.name,
      members: data.members, messages: data.messages || [],
    });
    renderGroups();
    if (S.chatTarget === data.groupId) renderChatMessages();
  }

  function onGroupUserJoined(data) {
    const g = S.groups.get(data.groupId);
    if (g) {
      if (!g.members.find(m => m.id === data.user.id)) g.members.push(data.user);
      renderGroups();
      if (S.chatTarget === data.groupId) addSystemMessage(data.user.name + ' joined the group', data.groupId);
    }
  }

  function onGroupUserLeft(data) {
    const g = S.groups.get(data.groupId);
    if (g) {
      g.members = g.members.filter(m => m.id !== data.userId);
      renderGroups();
      if (S.chatTarget === data.groupId) {
        const u = S.users.get(data.userId);
        addSystemMessage((u ? u.name : 'User') + ' left the group', data.groupId);
      }
    }
  }

  function onTyping(data) {
    if (data.userId === S.myId) return;
    if (data.groupId !== S.chatTarget) return;
    const key = data.userId + '|' + (data.groupId || 'main');
    if (data.isTyping) {
      S.typingUsers.set(key, { name: data.name, color: data.color, expires: Date.now() + TYPING_TIMEOUT });
    } else {
      S.typingUsers.delete(key);
    }
    renderTyping();
  }

  function onMessageDeleted(data) {
    if (data.groupId) {
      const g = S.groups.get(data.groupId);
      if (g) g.messages = g.messages.filter(m => m.id !== data.id);
    } else {
      S.messages = S.messages.filter(m => m.id !== data.id);
    }
    if (isCurrentTarget(data.groupId)) {
      const el = S.ui.msgs.querySelector('[data-msg-id="' + data.id + '"]');
      if (el) el.remove();
    }
  }

  function onError(data) {
    toast('Error: ' + (data.message || data.code || 'unknown'));
    console.warn('[slidy-chat] server error', data);
  }

  // ===========================================================================
  // SEND ACTIONS
  // ===========================================================================
  function sendChat(text) {
    text = String(text || '').slice(0, 2000);
    if (!text.trim() || !S.authed) return;
    const msg = buildLocalChat(text);
    appendMessage(msg, true);
    send({ type: 'chat', text: text, groupId: S.chatTarget });
  }

  function buildLocalChat(text) {
    return {
      type: 'chat',
      id: 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      userId: S.myId, name: S.myName, color: S.myColor,
      text: text, timestamp: Date.now() / 1000,
      groupId: S.chatTarget, isAdmin: false,
    };
  }

  function sendStatus(state, detail) {
    if (!S.authed) return;
    send({ type: 'status', state: state, detail: detail, share: S.shareStatus });
    const me = S.users.get(S.myId);
    if (me) {
      me.status = S.shareStatus ? state : 'hidden';
      me.statusDetail = S.shareStatus ? detail : '';
      me.sharingStatus = S.shareStatus;
      renderUsers();
    }
  }

  function sendActivity(event) {
    if (!S.authed || !S.shareActivity) return;
    // Deduplicate: prevent sending the same solve twice (session-switch edge case)
    const sig = [event.session, event.solveNumber, event.time, event.moves, event.tps].join('|');
    if (sig === S.lastSolveSignature) return;
    S.lastSolveSignature = sig;
    send(Object.assign({ type: 'activity' }, event));
    const localEvent = Object.assign({
      id: 'local-' + Date.now(), userId: S.myId, name: S.myName, color: S.myColor,
      timestamp: Date.now() / 1000,
    }, event);
    S.activity.push(localEvent);
    if (S.activity.length > 1000) S.activity.shift();
    renderActivity(true);
  }

  function sendGroupCreate(name) { send({ type: 'group_create', name: name }); }
  function sendGroupInvite(groupId, userId) { send({ type: 'group_invite', groupId: groupId, userId: userId }); }
  function sendGroupJoin(groupId) { send({ type: 'group_join', groupId: groupId }); }
  function sendGroupLeave(groupId) { send({ type: 'group_leave', groupId: groupId }); }

  function sendTyping(isTyping) {
    if (!S.authed) return;
    const now = Date.now();
    if (isTyping && now - S.lastTypingSent < TYPING_THROTTLE) return;
    S.lastTypingSent = now;
    send({ type: 'typing', groupId: S.chatTarget, isTyping: isTyping });
  }

  // ===========================================================================
  // STATUS DETECTION (MutationObserver — mirrors slidywebscripts)
  // ===========================================================================
  function detectState() {
    // Priority: .focus-area (puzzle) > stats page > sessions list > menu
    if (document.querySelector('.focus-area')) {
      const sn = document.querySelector('.session-name');
      const session = sn ? sn.textContent.trim() : '';
      return { state: 'puzzle', detail: session ? ('Solving: ' + session) : 'Solving' };
    }
    if (document.querySelector('.session-statistics-page-container') ||
        document.querySelector('.session-statistics-table')) {
      const sn = document.querySelector('.session-name');
      const session = sn ? sn.textContent.trim() : '';
      return { state: 'stats', detail: session ? ('Stats: ' + session) : 'Browsing stats' };
    }
    if (document.querySelector('.sessions') || document.querySelector('.session-background-inner')) {
      return { state: 'sessions', detail: 'Browsing sessions' };
    }
    return { state: 'menu', detail: 'Main menu' };
  }

  // EXACT port of slidywebscripts' parsePuzzleToNumberMatrix (v4.2.0, lines 7584-7606)
  function parsePuzzleToNumberMatrix() {
    const puzzle = document.querySelector('.puzzle');
    if (!puzzle) return null;

    const pieces = Array.from(puzzle.querySelectorAll('.piece')).map(p => ({
      left: parseInt(p.style.left) || 0,
      top: parseInt(p.style.top) || 0,
      value: parseInt(p.querySelector('.text')?.textContent?.trim()) || 0
    }));

    const leftValues = [...new Set(pieces.map(p => p.left))].sort((a, b) => a - b);
    const topValues = [...new Set(pieces.map(p => p.top))].sort((a, b) => a - b);

    const matrix = Array(topValues.length).fill().map(() => Array(leftValues.length).fill(0));

    pieces.forEach(piece => {
      const col = leftValues.indexOf(piece.left);
      const row = topValues.indexOf(piece.top);
      matrix[row][col] = piece.value;
    });

    return matrix;
  }

  // EXACT port of slidywebscripts' puzzleIsSolved (v4.2.0, lines 7607-7620)
  function puzzleIsSolved(matrix) {
    if (!matrix || matrix.length === 0) return false;

    const flatNumbers = matrix.flat();
    const nonZeroNumbers = flatNumbers.filter(num => num !== 0);

    for (let i = 1; i < nonZeroNumbers.length; i++) {
      if (nonZeroNumbers[i] <= nonZeroNumbers[i - 1]) {
        return false;
      }
    }

    return true;
  }

  function initScrambledState() {
    if (document.querySelector('.focus-area')) {
      const matrix = parsePuzzleToNumberMatrix();
      if (!puzzleIsSolved(matrix)) {
        S.scrambled = true;
      }
    }
  }

  // Solve detection — mirrors slidywebscripts' detectPuzzleState (v4.2.0, lines 4286-4322)
  function detectSolve(mutations) {
    if (!document.querySelector('.focus-area')) return;
    let sawStatsUpdate = false;
    let puzzleChanged = false;
    for (const m of mutations) {
      const target = m.target;
      if (m.type === 'childList' && target && target.nodeName &&
          target.nodeName.toLowerCase() === 'td') {
        for (const node of m.addedNodes) {
          const text = node.textContent || '';
          if (text.includes('Session')) sawStatsUpdate = true;
        }
      }
      if (m.type === 'childList' && target && target.classList &&
          target.classList.contains('puzzle')) {
        puzzleChanged = true;
      }
    }
    if (sawStatsUpdate && S.scrambled) {
      const solve = getSolveFromTable();
      if (solve) {
        S.scrambled = false;
        // Don't send DNF solves
        if (!solve.isDNF) {
          sendActivity({
            eventType: 'solve',
            session: solve.session,
            solveNumber: solve.solveNumber,
            time: solve.time,
            moves: solve.moves,
            tps: solve.tps,
            isDNF: false,
            sessionMean: solve.sessionMean,
          });
        }
      }
    } else if (puzzleChanged) {
      const puzzleMatrix = parsePuzzleToNumberMatrix();
      if (!puzzleIsSolved(puzzleMatrix)) {
        S.scrambled = true;
      }
    }
  }

  function getSolveFromTable() {
    const container = document.querySelector('.stats-grid-container');
    if (!container) return null;
    const singleRow = container.querySelector('tr[avg="1"]') || container.querySelector('tr');
    if (!singleRow) return null;
    const cells = singleRow.querySelectorAll('td');
    if (cells.length < 4) return null;
    const headerText = (cells[0] && cells[0].textContent || '').trim();
    const timeText = (cells[1] && cells[1].textContent || '').trim() || 'DNF';
    const movesText = (cells[2] && cells[2].textContent || '').trim();
    const tpsText = (cells[3] && cells[3].textContent || '').trim();
    const solveNumber = parseInt(headerText.replace(/\D/g, ''), 10) || null;
    const sn = document.querySelector('.session-name');
    const session = sn ? sn.textContent.trim() : 'Unknown';
    const sessionMean = getSessionMean(container);
    return {
      session: session, solveNumber: solveNumber,
      time: timeText, moves: movesText, tps: tpsText,
      isDNF: /dnf/i.test(timeText), sessionMean: sessionMean,
    };
  }

  function getSessionMean(container) {
    const rows = container.querySelectorAll('tr[avg]');
    for (const row of rows) {
      const avg = row.getAttribute('avg');
      if (avg && avg !== '1') {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 2) {
          const t = (cells[1] && cells[1].textContent || '').trim();
          if (t && !/^[A-Z/]+$/i.test(t)) return t;
        }
      }
    }
    return null;
  }

  const detectAndSendStatus = debounce((force) => {
    const newState = detectState();
    if (force || !S.lastStatus ||
        newState.state !== S.lastStatus.state ||
        newState.detail !== S.lastStatus.detail) {
      S.lastStatus = newState;
      sendStatus(newState.state, newState.detail);
    }
  }, STATUS_DEBOUNCE);

  function startObservers() {
    if (S.observer) S.observer.disconnect();
    S.observer = new MutationObserver((mutations) => {
      S.observer.disconnect();
      try {
        const isTimerUpdate = mutations.length === 3 && mutations[0].target &&
          mutations[0].target.closest && mutations[0].target.closest('tr[avg="1"]');
        if (S.authed && S.shareStatus) detectAndSendStatus(false);
        if (S.authed && S.shareActivity && !isTimerUpdate) detectSolve(mutations);
      } catch (e) {
        console.error('[slidy-chat] observer error', e);
      }
      S.observer.observe(document.body, { childList: true, subtree: true });
    });
    S.observer.observe(document.body, { childList: true, subtree: true });
  }

  // ===========================================================================
  // UI: CSS
  // ===========================================================================
  const CSS = `
  :host { all: initial; }
  *, *::before, *::after { box-sizing: border-box; }
  .sc-root {
    position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
    z-index: 2147483647; pointer-events: none;
    font-family: 'JetBrains Mono','Fira Code','Cascadia Code','SF Mono',Consolas,monospace,'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji';
    font-size: 13px; color: #e8e8e8;
  }
  .sc-chat {
    pointer-events: auto; position: absolute;
    width: 336px; height: 520px; min-height: 200px;
    background: rgba(22,22,22,0.8); border: 1px solid #3a3a3a; border-radius: 6px;
    box-shadow: 0 8px 40px rgba(0,0,0,0.7), 0 0 0 1px rgba(0,188,212,0.08);
    display: flex; flex-direction: column; overflow: hidden;
    animation: sc-fadein .2s ease-out;
  }
  .sc-header {
    display: flex; align-items: center; gap: 8px;
    padding: 7px 10px; background: rgba(14,14,14,0.92);
    backdrop-filter: blur(12px); border-bottom: 1px solid #2a2a2a;
    cursor: move; user-select: none; flex-shrink: 0;
  }
  .sc-version { font-size: 9px; font-weight: 500; color: #555; letter-spacing: .3px;
    white-space: nowrap; flex-shrink: 0; }
  .sc-conn-status { font-size: 9px; font-weight: 500; color: #888; white-space: nowrap; flex-shrink: 0; }
  .sc-conn-status.error { color: #ff2262; }
  .sc-conn-status.connecting { color: #ffff00; }
  .sc-status-dot { width: 8px; height: 8px; border-radius: 50%; background: #555; transition: all .2s; flex-shrink: 0; }
  .sc-status-dot.connected { background: #00f1ff; box-shadow: 0 0 6px #00f1ff, 0 0 12px rgba(0,188,212,0.4); }
  .sc-status-dot.connecting { background: #ffff00; box-shadow: 0 0 6px #ffff00; animation: sc-pulse 1s infinite; }
  .sc-status-dot.error { background: #ff2262; box-shadow: 0 0 6px #ff2262; }
  .sc-online-count { font-size: 10px; color: #00f1ff; background: rgba(0,188,212,0.08);
    border: 1px solid rgba(0,188,212,0.2); padding: 1px 6px; border-radius: 3px; font-weight: 600; }
  .sc-recent-users { display: inline-flex; align-items: center; gap: 2px; overflow: hidden; white-space: nowrap; flex-shrink: 1; min-width: 0; max-width: 55%; font-size: 10px; color: #777; }
  .sc-recent-user { font-weight: 600; margin: 0 1px; }
  .sc-recent-more { font-weight: 400; color: #555; margin-left: 2px; }
  .sc-header-spacer { flex: 1; }
  .sc-header-btn { background: transparent; border: 1px solid #2a2a2a; color: #888;
    width: 22px; height: 22px; border-radius: 4px; cursor: pointer;
    display: flex; align-items: center; justify-content: center; font-size: 14px;
    transition: all .15s; font-family: inherit; padding: 0; line-height: 1; }
  .sc-header-btn:hover { color: #e8e8e8; border-color: #3a3a3a; background: rgba(255,255,255,0.03); }
  .sc-header-btn.close:hover { color: #ff2262; border-color: #ff2262; }
  .sc-tabs { display: flex; border-bottom: 1px solid #2a2a2a; background: #0e0e0e; flex-shrink: 0; }
  .sc-tab { flex: 1; background: transparent; border: none; border-bottom: 2px solid transparent;
    color: #888; padding: 7px 2px; font-size: 10px; font-weight: 600; letter-spacing: .3px;
    text-transform: uppercase; cursor: pointer; transition: all .15s; font-family: inherit; position: relative; }
  .sc-tab:hover { color: #e8e8e8; }
  .sc-tab.active { color: #00f1ff; border-bottom-color: #00bcd4; text-shadow: 0 0 6px rgba(0,188,212,0.3); background: rgba(0,188,212,0.04); }
  .sc-tab-badge { position: absolute; top: 2px; right: 2px; background: #ff2262; color: #fff;
    font-size: 8px; padding: 0 4px; border-radius: 8px; min-width: 12px; text-align: center; font-weight: 700; }
  .sc-body { flex: 1; overflow: hidden; position: relative; min-height: 0; }
  .sc-panel { position: absolute; inset: 0; display: none; flex-direction: column; }
  .sc-panel.active { display: flex; }

  /* Chat */
  .sc-chat-target { display: flex; align-items: center; gap: 6px; padding: 5px 8px;
    border-bottom: 1px solid #2a2a2a; background: #161616; flex-shrink: 0; }
  .sc-chat-target select { background: #0e0e0e; border: 1px solid #2a2a2a; color: #e8e8e8;
    font-family: inherit; font-size: 11px; padding: 3px 6px; border-radius: 3px; flex: 1; min-width: 0; }
  .sc-chat-target select:focus { border-color: #00bcd4; box-shadow: 0 0 6px rgba(0,188,212,0.3); outline: none; }
  .sc-msgs { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 6px 8px; }
  .sc-msgs::-webkit-scrollbar { width: 6px; }
  .sc-msgs::-webkit-scrollbar-track { background: transparent; }
  .sc-msgs::-webkit-scrollbar-thumb { background: #3a3a3a; border-radius: 3px; }
  .sc-msgs::-webkit-scrollbar-thumb:hover { background: #555; }
  .sc-msg { position: relative; padding: 3px 6px 3px 11px; margin-bottom: 3px; border-radius: 4px;
    font-size: 12px; line-height: 1.5; animation: sc-fadein .12s ease-out; }
  .sc-msg::before { content: ''; position: absolute; left: 2px; top: 4px; bottom: 4px; width: 2px;
    background: currentColor; opacity: 0.6; border-radius: 1px; }
  .sc-msg-header { display: flex; align-items: baseline; gap: 5px; margin-bottom: 1px; }
  .sc-msg-name { font-weight: 700; font-size: 11px; text-shadow: 0 0 5px currentColor; }
  .sc-msg-time { font-size: 9px; color: #555; }
  .sc-msg-text { color: #e8e8e8; white-space: pre-wrap; word-wrap: break-word; overflow-wrap: break-word; }
  .sc-msg.action .sc-msg-text { color: #888; font-style: italic; }
  .sc-mention { color: #00f1ff; font-weight: 600; }
  .sc-msg-admin-tag { font-size: 8px; font-weight: 700; color: #ff2262;
    background: rgba(255,34,98,0.1); border: 1px solid rgba(255,34,98,0.3);
    padding: 0 4px; border-radius: 2px; text-transform: uppercase; letter-spacing: .5px; }
  .sc-msg-status-tag { font-size: 8px; color: #666; background: #1a1a1a; border: 1px solid #2a2a2a;
    padding: 0 4px; border-radius: 2px; font-weight: 500; letter-spacing: .3px; }
  .sc-msg.system { text-align: center; color: #555; font-size: 10px; padding: 2px; }
  .sc-msg.system::before { display: none; }
  .sc-msg.mine { background: rgba(0,188,212,0.03); }
  .sc-link { color: #00bcd4; text-decoration: none; border-bottom: 1px dotted #00bcd4; word-break: break-all; }
  .sc-link:hover { color: #00f1ff; border-bottom-color: #00f1ff; }
  .sc-typing { font-size: 10px; color: #555; padding: 1px 10px; height: 16px; font-style: italic;
    flex-shrink: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .sc-typing .sc-typing-name { font-weight: 600; }

  .sc-input-wrap { display: flex; gap: 6px; padding: 6px 8px; border-top: 1px solid #2a2a2a;
    background: #1c1c1c; flex-shrink: 0; align-items: flex-end; }
  .sc-input { flex: 1; background: #0e0e0e; border: 1px solid #2a2a2a; color: #e8e8e8;
    font-family: inherit; font-size: 12px; padding: 6px 8px; border-radius: 4px;
    resize: none; min-height: 48px; max-height: 120px; line-height: 1.4;
    transition: border-color .15s, box-shadow .15s; }
  .sc-input:focus { outline: none; border-color: #00bcd4; box-shadow: 0 0 6px rgba(0,188,212,0.3); }
  .sc-input::placeholder { color: #555; }
  .sc-emoji-btn { background: transparent; border: 1px solid #2a2a2a; color: #888; width: 30px; height: 30px;
    border-radius: 4px; cursor: pointer; font-size: 16px; padding: 0; font-family: inherit; transition: all .15s; }
  .sc-emoji-btn:hover { color: #00f1ff; border-color: #00bcd4; }
  .sc-send { background: transparent; border: 1px solid #2a2a2a; color: #888; font-family: inherit;
    font-size: 10px; font-weight: 700; letter-spacing: .5px; text-transform: uppercase;
    padding: 0 14px; border-radius: 4px; cursor: pointer; transition: all .15s; height: 30px; }
  .sc-send:hover { color: #00f1ff; border-color: #00bcd4; box-shadow: 0 0 8px rgba(0,188,212,0.3); }
  .sc-send:active { transform: translateY(1px); }
  .sc-emoji-panel { display: none; flex-wrap: wrap; gap: 2px; padding: 6px 8px; border-top: 1px solid #2a2a2a;
    background: #0e0e0e; max-height: 90px; overflow-y: auto; }
  .sc-emoji-panel.open { display: flex; }
  .sc-emoji { background: transparent; border: none; cursor: pointer; font-size: 18px; padding: 2px 4px;
    border-radius: 3px; font-family: inherit; }
  .sc-emoji:hover { background: rgba(0,188,212,0.1); }

  /* Activity */
  .sc-act-filters { display: flex; gap: 8px; padding: 6px 8px; border-bottom: 1px solid #2a2a2a;
    background: #161616; align-items: center; font-size: 11px; flex-shrink: 0; flex-wrap: wrap; }
  .sc-act-filters select { background: #0e0e0e; border: 1px solid #2a2a2a; color: #e8e8e8;
    font-family: inherit; font-size: 11px; padding: 3px 6px; border-radius: 3px; }
  .sc-act-filters label { display: flex; align-items: center; gap: 4px; color: #888; cursor: pointer; }
  .sc-act-list { flex: 1; overflow-y: auto; padding: 6px 8px; }
  .sc-act-list::-webkit-scrollbar { width: 6px; }
  .sc-act-list::-webkit-scrollbar-thumb { background: #3a3a3a; border-radius: 3px; }
  .sc-act-item { padding: 5px 8px; margin-bottom: 4px; border: 1px solid #2a2a2a; border-left: 3px solid #2a2a2a; border-radius: 4px;
    font-size: 11px; background: #181818; }
  .sc-act-new { animation: sc-fadein .15s ease-out; }
  .sc-act-row { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
  .sc-act-user { font-weight: 700; text-shadow: 0 0 5px currentColor; }
  .sc-act-action { color: #888; }
  .sc-act-time-val { color: #00f1ff; font-weight: 700; }
  .sc-act-meta { color: #888; font-size: 10px; }
  .sc-act-dnf { color: #ff2262; font-weight: 700; }
  .sc-act-when { color: #555; font-size: 9px; margin-left: auto; }
  .sc-act-hide { background: rgba(255,255,255,0.15); border: none; color: #999; cursor: pointer; font-size: 11px; padding: 0 4px; font-family: inherit; line-height: 1; border-radius: 3px; }
  .sc-act-hide:hover { color: #ff2262; background: rgba(255,34,98,0.1); }
  .sc-act-hidden { display: flex; gap: 4px; flex-wrap: wrap; padding: 2px 0; width: 100%; }
  .sc-act-hidden-label { font-size: 10px; color: #555; }
  .sc-act-hidden-tag { font-size: 10px; color: #888; background: #1a1a1a; border: 1px solid #2a2a2a; padding: 1px 6px; border-radius: 3px; cursor: pointer; }
  .sc-act-hidden-tag:hover { color: #00f1ff; border-color: #00bcd4; }
  .sc-empty { color: #555; text-align: center; padding: 30px 10px; font-size: 12px; font-style: italic; }

  /* Users */
  .sc-users-list { flex: 1; overflow-y: auto; padding: 6px 8px; }
  .sc-users-list::-webkit-scrollbar { width: 6px; }
  .sc-users-list::-webkit-scrollbar-thumb { background: #3a3a3a; border-radius: 3px; }
  .sc-user-item { display: flex; align-items: center; gap: 8px; padding: 5px 8px; margin-bottom: 3px;
    border: 1px solid #2a2a2a; border-radius: 4px; background: #181818; }
  .sc-user-item.me { border-color: rgba(0,188,212,0.3); background: rgba(0,188,212,0.03); }
  .sc-user-name { font-weight: 700; text-shadow: 0 0 5px currentColor; font-size: 12px; }
  .sc-user-status { font-size: 10px; color: #888; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sc-user-badge { font-size: 9px; padding: 1px 5px; border-radius: 3px; text-transform: uppercase;
    letter-spacing: .5px; font-weight: 600; }
  .sc-user-badge.puzzle { color: #00ff00; background: rgba(0,255,0,0.08); border: 1px solid rgba(0,255,0,0.2); }
  .sc-user-badge.stats { color: #ffff00; background: rgba(255,255,0,0.08); border: 1px solid rgba(255,255,0,0.2); }
  .sc-user-badge.sessions { color: #a14dff; background: rgba(161,77,255,0.08); border: 1px solid rgba(161,77,255,0.2); }
  .sc-user-badge.menu { color: #888; background: rgba(128,128,128,0.08); border: 1px solid rgba(128,128,128,0.2); }
  .sc-user-badge.hidden { color: #555; background: transparent; border: 1px solid #2a2a2a; }
  .sc-user-badge.admin { color: #ff2262; background: rgba(255,34,98,0.08); border: 1px solid rgba(255,34,98,0.2);
    text-shadow: 0 0 5px rgba(255,34,98,0.3); }
  .sc-user-badge.idle { color: #555; }
  .sc-invite-btn { background: transparent; border: 1px solid #2a2a2a; color: #888; font-family: inherit;
    font-size: 10px; padding: 2px 8px; border-radius: 3px; cursor: pointer; }
  .sc-invite-btn:hover { color: #00f1ff; border-color: #00bcd4; }

  /* Groups */
  .sc-groups-list { flex: 1; overflow-y: auto; padding: 8px; }
  .sc-groups-list::-webkit-scrollbar { width: 6px; }
  .sc-groups-list::-webkit-scrollbar-thumb { background: #3a3a3a; border-radius: 3px; }
  .sc-create-btn { display: block; width: 100%; background: transparent; border: 1px solid #00bcd4;
    color: #00f1ff; font-family: inherit; font-size: 11px; font-weight: 700; padding: 8px; border-radius: 4px;
    cursor: pointer; margin-bottom: 8px; text-transform: uppercase; letter-spacing: .5px; transition: all .15s; }
  .sc-create-btn:hover { background: rgba(0,188,212,0.08); box-shadow: 0 0 8px rgba(0,188,212,0.2); }
  .sc-group-item { padding: 8px; margin-bottom: 6px; border: 1px solid #2a2a2a; border-radius: 4px; background: #181818; }
  .sc-group-item.active { border-color: rgba(0,188,212,0.4); background: rgba(0,188,212,0.03); }
  .sc-group-name { font-weight: 700; color: #00f1ff; text-shadow: 0 0 5px rgba(0,188,212,0.3); font-size: 12px; }
  .sc-group-meta { font-size: 10px; color: #888; margin-top: 2px; }
  .sc-group-members { font-size: 10px; color: #888; margin-top: 4px; }
  .sc-group-actions { display: flex; gap: 6px; margin-top: 6px; }
  .sc-group-btn { background: transparent; border: 1px solid #2a2a2a; color: #888; font-family: inherit;
    font-size: 10px; padding: 3px 10px; border-radius: 3px; cursor: pointer; transition: all .15s; }
  .sc-group-btn:hover { color: #00f1ff; border-color: #00bcd4; }
  .sc-group-btn.danger:hover { color: #ff2262; border-color: #ff2262; }
  .sc-invite-card { padding: 8px; margin-bottom: 6px; border: 1px solid #ff2262; border-radius: 4px;
    background: rgba(255,34,98,0.04); }
  .sc-invite-card-title { font-size: 12px; color: #ff2262; font-weight: 700; }
  .sc-invite-card-from { font-size: 10px; color: #888; margin-top: 2px; }

  /* Settings */
  .sc-settings { flex: 1; overflow-y: auto; padding: 10px 12px; }
  .sc-settings::-webkit-scrollbar { width: 6px; }
  .sc-settings::-webkit-scrollbar-thumb { background: #3a3a3a; border-radius: 3px; }
  .sc-setting-row { display: flex; align-items: center; justify-content: space-between;
    padding: 8px 0; border-bottom: 1px solid #2a2a2a; font-size: 12px; gap: 10px; }
  .sc-setting-info { flex: 1; min-width: 0; }
  .sc-setting-label { color: #e8e8e8; font-weight: 600; }
  .sc-setting-desc { font-size: 10px; color: #555; margin-top: 2px; line-height: 1.4; }
  .sc-toggle { position: relative; width: 36px; height: 20px; background: #2a2a2a; border-radius: 10px;
    cursor: pointer; transition: background .2s; flex-shrink: 0; }
  .sc-toggle::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
    background: #888; border-radius: 50%; transition: all .2s; }
  .sc-toggle.on { background: rgba(0,188,212,0.3); }
  .sc-toggle.on::after { left: 18px; background: #00f1ff; box-shadow: 0 0 6px #00f1ff; }
  .sc-color-row { display: flex; align-items: center; gap: 8px; }
  .sc-color-input { width: 40px; height: 26px; border: 1px solid #2a2a2a; border-radius: 4px;
    background: #0e0e0e; cursor: pointer; padding: 2px; }
  .sc-color-preview { font-size: 12px; font-weight: 700; text-shadow: 0 0 5px currentColor; }
  .sc-text-input { background: #0e0e0e; border: 1px solid #2a2a2a; color: #e8e8e8; font-family: inherit;
    font-size: 11px; padding: 4px 6px; border-radius: 3px; flex: 1; min-width: 0; max-width: 180px; }
  .sc-text-input:focus { border-color: #00bcd4; box-shadow: 0 0 6px rgba(0,188,212,0.3); outline: none; }
  .sc-btn { background: transparent; border: 1px solid #2a2a2a; color: #888; font-family: inherit;
    font-size: 11px; padding: 4px 10px; border-radius: 3px; cursor: pointer; transition: all .15s; }
  .sc-btn:hover { color: #00f1ff; border-color: #00bcd4; }
  .sc-btn.danger:hover { color: #ff2262; border-color: #ff2262; }
  .sc-settings-section { font-size: 10px; color: #555; text-transform: uppercase; letter-spacing: 1px;
    margin: 14px 0 4px; font-weight: 700; }
  .sc-settings-section:first-child { margin-top: 0; }

  .sc-mini { pointer-events: auto; position: absolute; width: 44px; height: 44px; background: #161616;
    border: 1px solid #00bcd4; border-radius: 8px; box-shadow: 0 0 12px rgba(0,188,212,0.3);
    cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 20px;
    color: #00f1ff; animation: sc-fadein .2s; }
  .sc-mini:hover { box-shadow: 0 0 20px rgba(0,188,212,0.5); transform: scale(1.05); transition: box-shadow .2s, transform .2s; }
  .sc-mini-badge { position: absolute; top: -4px; right: -4px; background: #ff2262; color: #fff;
    font-size: 10px; padding: 0 4px; border-radius: 8px; min-width: 16px; text-align: center; font-weight: 700; }

  .sc-toast { pointer-events: auto; position: absolute; bottom: 16px; right: 16px; background: #161616;
    border: 1px solid #00bcd4; border-radius: 4px; padding: 8px 14px; color: #e8e8e8; font-size: 12px;
    box-shadow: 0 0 12px rgba(0,188,212,0.2); animation: sc-fadein .2s; max-width: 280px;
    word-wrap: break-word; }

  .sc-modal-bg { pointer-events: auto; position: fixed; inset: 0; background: rgba(0,0,0,0.7);
    backdrop-filter: blur(4px); z-index: 2147483647; display: flex; align-items: center; justify-content: center; }
  .sc-modal { background: #161616; border: 1px solid #3a3a3a; border-radius: 6px; padding: 18px;
    max-width: 320px; width: 90%; box-shadow: 0 8px 40px rgba(0,0,0,0.7); }
  .sc-modal h3 { color: #00f1ff; margin: 0 0 10px; font-size: 14px; font-family: inherit; }
  .sc-modal p { color: #888; font-size: 12px; margin: 0 0 12px; line-height: 1.5; font-family: inherit; }
  .sc-modal select, .sc-modal input { width: 100%; background: #0e0e0e; border: 1px solid #2a2a2a; color: #e8e8e8;
    font-family: inherit; font-size: 12px; padding: 6px 8px; border-radius: 4px; margin-bottom: 10px; }
  .sc-modal select:focus, .sc-modal input:focus { border-color: #00bcd4; box-shadow: 0 0 6px rgba(0,188,212,0.3); outline: none; }
  .sc-modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }

  .sc-new-msgs { position: absolute; bottom: 6px; right: 8px; background: #00bcd4; color: #000;
    font-size: 10px; font-weight: 700; padding: 3px 10px; border-radius: 12px; cursor: pointer;
    box-shadow: 0 0 8px rgba(0,188,212,0.5); animation: sc-fadein .2s; z-index: 5; }

  @keyframes sc-fadein { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes sc-pulse { 0%,100% { opacity: 1; } 50% { opacity: .4; } }

  /* Disabled state */
  .sc-chat.sc-disabled .sc-input-wrap { opacity: 0.5; pointer-events: none; }
  .sc-chat.sc-disabled .sc-msgs::after {
    content: 'Not connected. Waiting for server…'; position: absolute; top: 50%; left: 50%;
    transform: translate(-50%, -50%); color: #555; font-size: 11px; text-align: center;
    pointer-events: none; width: 90%;
  }

  /* Logs panel */
  .sc-logs-toolbar { display: flex; align-items: center; gap: 8px; padding: 5px 8px;
    border-bottom: 1px solid #2a2a2a; background: #161616; flex-shrink: 0; }
  .sc-logs-count { font-size: 10px; color: #555; }
  .sc-logs-list { flex: 1; overflow-y: auto; padding: 4px 0; font-size: 10px; }
  .sc-logs-list::-webkit-scrollbar { width: 6px; }
  .sc-logs-list::-webkit-scrollbar-track { background: transparent; }
  .sc-logs-list::-webkit-scrollbar-thumb { background: #3a3a3a; border-radius: 3px; }
  .sc-log-entry { display: flex; gap: 6px; padding: 2px 8px; border-bottom: 1px solid #1a1a1a;
    align-items: flex-start; line-height: 1.4; }
  .sc-log-entry:hover { background: rgba(255,255,255,0.02); }
  .sc-log-time { color: #555; flex-shrink: 0; }
  .sc-log-level { font-weight: 700; flex-shrink: 0; min-width: 38px; }
  .sc-log-info .sc-log-level { color: #00bcd4; }
  .sc-log-error .sc-log-level { color: #ff2262; }
  .sc-log-warn .sc-log-level { color: #ffff00; }
  .sc-log-msg { color: #e8e8e8; word-break: break-word; white-space: pre-wrap; }
  .sc-log-error .sc-log-msg { color: #ff9999; }

  /* Input fix: no scrollbar overflow, better min-height */
  .sc-input { min-height: 48px !important; line-height: 1.5 !important;
    scrollbar-width: thin; scrollbar-color: #3a3a3a transparent; }
  .sc-input::-webkit-scrollbar { width: 5px; }
  .sc-input::-webkit-scrollbar-track { background: transparent; }
  .sc-input::-webkit-scrollbar-thumb { background: #3a3a3a; border-radius: 3px; }
  .sc-input::-webkit-scrollbar-thumb:hover { background: #555; }
  .sc-mention-wrap { position: relative; flex: 1; display: flex; }
  .sc-mention-dropdown { position: absolute; bottom: 100%; left: 0; right: 0; max-height: 160px; overflow-y: auto;
    background: #1a1a1a; border: 1px solid #3a3a3a; border-bottom: none; border-radius: 4px 4px 0 0;
    z-index: 100; scrollbar-width: thin; scrollbar-color: #3a3a3a transparent; }
  .sc-mention-dropdown::-webkit-scrollbar { width: 5px; }
  .sc-mention-dropdown::-webkit-scrollbar-track { background: transparent; }
  .sc-mention-dropdown::-webkit-scrollbar-thumb { background: #3a3a3a; border-radius: 3px; }
  .sc-mention-item { padding: 4px 8px; cursor: pointer; font-size: 12px; color: #ccc; display: flex; align-items: center; gap: 6px; }
  .sc-mention-item:hover, .sc-mention-item.selected { background: rgba(0,188,212,0.12); color: #e8e8e8; }
  .sc-mention-item .sc-mention-color { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }

  /* Global scrollbar styling for all scrollable areas */
  .sc-msgs, .sc-act-list, .sc-users-list, .sc-groups-list, .sc-settings, .sc-logs-list, .sc-emoji-panel {
    scrollbar-width: thin; scrollbar-color: #3a3a3a transparent;
  }
  .sc-emoji-panel::-webkit-scrollbar { width: 5px; }
  .sc-emoji-panel::-webkit-scrollbar-track { background: transparent; }
  .sc-emoji-panel::-webkit-scrollbar-thumb { background: #3a3a3a; border-radius: 3px; }
  .sc-emoji-panel::-webkit-scrollbar-thumb:hover { background: #555; }
  `;

  // ===========================================================================
  // UI: BUILD (shadow DOM)
  // ===========================================================================
  function buildUI() {
    const host = document.createElement('div');
    host.id = 'slidy-chat-host';
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    const root = document.createElement('div');
    root.className = 'sc-root';
    root.innerHTML = `
      <div class="sc-chat" id="chat">
        <div class="sc-header" id="header">
          <span class="sc-status-dot" id="statusDot"></span>
          <span class="sc-version" id="version"></span>
          <span class="sc-conn-status" id="connStatus"></span>
          <span class="sc-online-count" id="onlineCount">0</span>
          <span class="sc-recent-users" id="recentUsers"></span>
          <span class="sc-header-spacer"></span>
          <button class="sc-header-btn" id="btnMin" title="Minimize">—</button>
        </div>
        <div class="sc-tabs" id="tabs">
          <button class="sc-tab active" data-tab="chat">Chat</button>
          <button class="sc-tab" data-tab="activity">Activity</button>
          <button class="sc-tab" data-tab="users">Users</button>
          <button class="sc-tab" data-tab="groups">Groups</button>
          <button class="sc-tab" data-tab="settings">SETTINGS</button>
          <button class="sc-tab" data-tab="logs">Logs</button>
        </div>
        <div class="sc-body" id="body">
          <div class="sc-panel active" data-panel="chat">
            <div class="sc-chat-target"><select id="chatTarget"></select></div>
            <div class="sc-msgs" id="msgs"></div>
            <div class="sc-typing" id="typing"></div>
            <div class="sc-emoji-panel" id="emojiPanel"></div>
            <div class="sc-input-wrap">
              <button class="sc-emoji-btn" id="emojiBtn" title="Emoji">🥚</button>
              <div class="sc-mention-wrap">
                <textarea class="sc-input" id="input" placeholder="Type a message… (Enter=send, Shift+Enter=newline)" rows="1"></textarea>
                <div class="sc-mention-dropdown" id="mentionDropdown" style="display:none"></div>
              </div>
              <button class="sc-send" id="send">Send</button>
            </div>
            <div class="sc-new-msgs" id="newMsgs" style="display:none">↓ New messages</div>
          </div>
          <div class="sc-panel" data-panel="activity">
            <div class="sc-act-filters">
              <select id="actUserFilter"><option value="all">All users</option></select>
              <div class="sc-act-hidden" id="actHidden"></div>
            </div>
            <div class="sc-act-list" id="actList"></div>
          </div>
          <div class="sc-panel" data-panel="users"><div class="sc-users-list" id="usersList"></div></div>
          <div class="sc-panel" data-panel="groups"><div class="sc-groups-list" id="groupsList"></div></div>
          <div class="sc-panel" data-panel="settings"><div class="sc-settings" id="settings"></div></div>
          <div class="sc-panel" data-panel="logs">
            <div class="sc-logs-toolbar">
              <button class="sc-btn" id="clearLogsBtn">Clear</button>
              <span class="sc-logs-count" id="logsCount">0 entries</span>
            </div>
            <div class="sc-logs-list" id="logsList"></div>
          </div>
        </div>
      </div>
      <div class="sc-mini" id="mini" style="display:none">🥚<span class="sc-mini-badge" id="miniBadge" style="display:none">0</span></div>
      <div class="sc-toast" id="toast" style="display:none"></div>
    `;
    shadow.appendChild(root);

    const $ = (id) => shadow.getElementById(id);
    S.ui = {
      host, shadow, root,
      chat: $('chat'), header: $('header'), statusDot: $('statusDot'),
      onlineCount: $('onlineCount'), recentUsers: $('recentUsers'), version: $('version'), connStatus: $('connStatus'), btnMin: $('btnMin'),
      tabs: $('tabs'), body: $('body'),
      chatTarget: $('chatTarget'), msgs: $('msgs'), typing: $('typing'),
      emojiPanel: $('emojiPanel'), emojiBtn: $('emojiBtn'),
      input: $('input'), send: $('send'), newMsgs: $('newMsgs'), mentionDropdown: $('mentionDropdown'),
      actUserFilter: $('actUserFilter'), actList: $('actList'), actHidden: $('actHidden'),
      usersList: $('usersList'), groupsList: $('groupsList'), settings: $('settings'),
      mini: $('mini'), miniBadge: $('miniBadge'), toast: $('toast'),
      logsList: $('logsList'), logsCount: $('logsCount'), clearLogsBtn: $('clearLogsBtn'),
    };

    if (S.ui.version) S.ui.version.textContent = 'v' + VERSION;
    applyPosition(S.ui.chat, S.chatPos, '0px', '0px');
    if (S.minimized) toggleMinimize(true);
    wireEvents();
    renderSettings();
    renderEmojiPanel();
  }

  // ===========================================================================
  // EVENT WIRING
  // ===========================================================================
  function wireEvents() {
    S.ui.tabs.addEventListener('click', (e) => {
      const t = e.target.closest('.sc-tab');
      if (t) switchTab(t.dataset.tab);
    });
    S.ui.btnMin.addEventListener('click', () => toggleMinimize());
    makeDraggable();
    S.ui.chatTarget.addEventListener('change', () => {
      S.chatTarget = S.ui.chatTarget.value === 'main' ? null : S.ui.chatTarget.value;
      S.renderedCount = INITIAL_RENDER;
      S.isAtBottom = true;
      renderChatMessages();
    });
    S.ui.input.addEventListener('keydown', (e) => {
      if (S.ui.mentionDropdown.style.display !== 'none') {
        if (e.key === 'ArrowDown') { e.preventDefault(); selectNextMention(1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); selectNextMention(-1); return; }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptMention(); return; }
        if (e.key === 'Escape') { closeMentionDropdown(); return; }
      }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitInput(); }
    });
    S.ui.input.addEventListener('input', () => { autoGrowInput(); sendTyping(true); updateMention(); });
    S.ui.send.addEventListener('click', submitInput);
    S.ui.emojiBtn.addEventListener('click', () => S.ui.emojiPanel.classList.toggle('open'));
    S.ui.msgs.addEventListener('scroll', onMsgsScroll);
    S.ui.newMsgs.addEventListener('click', () => { S.ui.msgs.scrollTop = S.ui.msgs.scrollHeight; });
    S.ui.actUserFilter.addEventListener('change', () => {
      S.activityFilter.user = S.ui.actUserFilter.value; renderActivity();
    });
    // Clear logs
    S.ui.clearLogsBtn.addEventListener('click', () => {
      S.debugLog = []; renderLogs();
    });
    // Prevent slidysim key handlers from firing while typing (bubble phase only)
    S.ui.input.addEventListener('keydown', (e) => e.stopPropagation(), false);
    S.ui.input.addEventListener('keyup', (e) => e.stopPropagation(), false);

    S.ui.input.addEventListener('blur', () => setTimeout(closeMentionDropdown, 200));
    window.addEventListener('resize', onResize);
  }

  function clampPos(el, pos) {
    if (pos.x == null || pos.y == null || el.style.display === 'none') return;
    const w = el.offsetWidth || parseInt(el.style.width) || 336;
    const h = el.offsetHeight || 520;
    const x = clamp(pos.x, 0, window.innerWidth - w);
    const y = clamp(pos.y, 0, window.innerHeight - h);
    if (x !== pos.x || y !== pos.y) {
      pos.x = x; pos.y = y;
      el.style.left = x + 'px'; el.style.top = y + 'px';
      el.style.right = 'auto'; el.style.bottom = 'auto';
    }
  }

  function onResize() {
    clampPos(S.ui.chat, S.chatPos);
    clampPos(S.ui.mini, S.miniPos);
  }

  function autoGrowInput() {
    const el = S.ui.input;
    el.style.height = '48px';
    el.style.height = Math.min(120, el.scrollHeight) + 'px';
  }

  let mentionIndex = -1;
  let mentionResults = [];

  function updateMention() {
    const el = S.ui.input;
    const pos = el.selectionStart;
    const val = el.value;
    const before = val.slice(0, pos);
    const match = before.match(/@(\w*)$/);
    if (!match) { closeMentionDropdown(); return; }
    const query = match[1].toLowerCase();
    const users = Array.from(S.users.values()).filter(u => u.name !== 'Egg' && !u.isAdmin && u.name.toLowerCase().includes(query));
    if (users.length === 0) { closeMentionDropdown(); return; }
    mentionResults = users;
    mentionIndex = 0;
    const dd = S.ui.mentionDropdown;
    dd.innerHTML = '';
    for (let i = 0; i < users.length; i++) {
      const item = document.createElement('div');
      item.className = 'sc-mention-item' + (i === 0 ? ' selected' : '');
      const dot = document.createElement('span');
      dot.className = 'sc-mention-color';
      dot.style.background = users[i].color || '#00f1ff';
      item.appendChild(dot);
      const nameSpan = document.createElement('span');
      nameSpan.textContent = users[i].name;
      item.appendChild(nameSpan);
      item.dataset.idx = i;
      item.addEventListener('mousedown', () => { mentionIndex = i; acceptMention(); });
      item.addEventListener('mouseenter', () => {
        dd.querySelectorAll('.sc-mention-item').forEach(e => e.classList.remove('selected'));
        item.classList.add('selected');
        mentionIndex = i;
      });
      dd.appendChild(item);
    }
    dd.style.display = 'block';
  }

  function selectNextMention(dir) {
    const items = S.ui.mentionDropdown.querySelectorAll('.sc-mention-item');
    if (!items.length) return;
    items[mentionIndex]?.classList.remove('selected');
    mentionIndex = (mentionIndex + dir + items.length) % items.length;
    items[mentionIndex].classList.add('selected');
    items[mentionIndex].scrollIntoView({ block: 'nearest' });
  }

  function acceptMention() {
    const user = mentionResults[mentionIndex];
    if (!user) return;
    const el = S.ui.input;
    const pos = el.selectionStart;
    const val = el.value;
    const before = val.slice(0, pos);
    const match = before.match(/@(\w*)$/);
    if (!match) { closeMentionDropdown(); return; }
    const start = pos - match[0].length;
    el.value = val.slice(0, start) + '@' + user.name + ' ' + val.slice(pos);
    const newPos = start + user.name.length + 2;
    el.selectionStart = el.selectionEnd = newPos;
    closeMentionDropdown();
    autoGrowInput();
    el.focus();
    sendTyping(true);
  }

  function closeMentionDropdown() {
    S.ui.mentionDropdown.style.display = 'none';
    S.ui.mentionDropdown.innerHTML = '';
    mentionResults = [];
    mentionIndex = -1;
  }

  function submitInput() {
    const text = S.ui.input.value;
    if (!text.trim()) return;
    S.ui.input.value = '';
    autoGrowInput();
    sendTyping(false);
    if (text.startsWith('/rs')) {
      const myActivity = S.activity.slice().reverse().find(e => e.userId === S.myId);
      if (myActivity) {
        const line = (myActivity.time || '?') + ' (' + (myActivity.moves || '0') + ' / ' + (myActivity.tps || '0') + ') in session ' + (myActivity.session || 'Unknown');
        sendChat(line);
      } else {
        sendChat('No solves yet.');
      }
      return;
    }
    sendChat(text);
  }

  // ===========================================================================
  // DRAGGING
  // ===========================================================================
  function makeDraggable() {
    let dragging = false, offX = 0, offY = 0, dragTarget = null;
    let dragMoved = false, dragStartX = 0, dragStartY = 0;

    function startDrag(el, e) {
      if (e.target.closest('button')) return;
      dragging = true;
      dragTarget = el;
      dragMoved = false;
      const rect = el.getBoundingClientRect();
      offX = e.clientX - rect.left;
      offY = e.clientY - rect.top;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      e.preventDefault();
    }

    S.ui.header.addEventListener('mousedown', (e) => startDrag(S.ui.chat, e));
    S.ui.mini.addEventListener('mousedown', (e) => startDrag(S.ui.mini, e));

    document.addEventListener('mousemove', (e) => {
      if (!dragging || !dragTarget) return;
      if (!dragMoved && (Math.abs(e.clientX - dragStartX) > 4 || Math.abs(e.clientY - dragStartY) > 4)) {
        dragMoved = true;
      }
      let x = clamp(e.clientX - offX, 0, window.innerWidth - dragTarget.offsetWidth);
      let y = clamp(e.clientY - offY, 0, window.innerHeight - dragTarget.offsetHeight);
      const pos = (dragTarget === S.ui.chat) ? S.chatPos : S.miniPos;
      pos.x = x; pos.y = y;
      dragTarget.style.left = x + 'px';
      dragTarget.style.top = y + 'px';
      dragTarget.style.right = 'auto';
      dragTarget.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => {
      if (dragging) { dragging = false; dragTarget = null; saveSettings(); }
    });

    S.ui.mini.addEventListener('click', (e) => {
      if (dragMoved) { dragMoved = false; return; }
      toggleMinimize();
    });
  }

  function applyPosition(el, pos, defaultRight, defaultBottom) {
    if (pos.x != null && pos.y != null) {
      el.style.left = pos.x + 'px';
      el.style.top = pos.y + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    } else {
      el.style.right = defaultRight;
      el.style.bottom = defaultBottom;
    }
  }

  function toggleMinimize(force) {
    const toMini = (typeof force === 'boolean') ? force : !S.minimized;
    S.minimized = toMini;
    if (toMini) {
      S.ui.chat.style.display = 'none';
      S.ui.mini.style.display = 'flex';
      clampPos(S.ui.mini, S.miniPos);
      applyPosition(S.ui.mini, S.miniPos, '0px', '0px');
    } else {
      S.ui.chat.style.display = 'flex';
      S.ui.mini.style.display = 'none';
      clampPos(S.ui.chat, S.chatPos);
      applyPosition(S.ui.chat, S.chatPos, '0px', '0px');
      S.unreadPerTab.chat = 0;
      renderTabBadges();
      renderMiniBadge();
    }
    saveSettings();
  }

  // ===========================================================================
  // TABS
  // ===========================================================================
  function switchTab(tab) {
    S.tab = tab;
    S.ui.tabs.querySelectorAll('.sc-tab').forEach(t =>
      t.classList.toggle('active', t.dataset.tab === tab));
    S.ui.body.querySelectorAll('.sc-panel').forEach(p =>
      p.classList.toggle('active', p.dataset.panel === tab));
    if (tab === 'chat') { S.unreadPerTab.chat = 0; if (S.authed) S.ui.input.focus(); }
    if (tab === 'activity') S.unreadPerTab.activity = 0;
    if (tab === 'groups') S.unreadPerTab.groups = 0;
    if (tab === 'logs') S.unreadPerTab.logs = 0;
    renderTabBadges();
    saveSettings();
    if (tab === 'users') renderUsers();
    if (tab === 'groups') renderGroups();
    if (tab === 'activity') renderActivity();
    if (tab === 'settings') renderSettings();
    if (tab === 'logs') renderLogs();
  }

  function renderTabBadges() {
    S.ui.tabs.querySelectorAll('.sc-tab').forEach(t => {
      const tab = t.dataset.tab;
      let count = 0;
      if (tab === 'chat') count = S.unreadPerTab.chat + (S.chatTarget ? S.unreadPerTab.groups : 0);
      else if (tab === 'activity') count = S.unreadPerTab.activity;
      else if (tab === 'groups') count = S.unreadPerTab.groups;
      let badge = t.querySelector('.sc-tab-badge');
      if (count > 0) {
        if (!badge) { badge = document.createElement('span'); badge.className = 'sc-tab-badge'; t.appendChild(badge); }
        badge.textContent = count > 99 ? '99+' : count;
      } else if (badge) { badge.remove(); }
    });
    renderMiniBadge();
  }

  function renderMiniBadge() {
    const total = S.unreadPerTab.chat + S.unreadPerTab.activity + S.unreadPerTab.groups;
    if (S.minimized && total > 0) {
      S.ui.miniBadge.textContent = total > 99 ? '99+' : total;
      S.ui.miniBadge.style.display = 'block';
    } else {
      S.ui.miniBadge.style.display = 'none';
    }
  }

  function renderOnlineCount() {
    if (S.ui.onlineCount) S.ui.onlineCount.textContent = S.users.size;
  }

  function renderRecentUsers() {
    const el = S.ui.recentUsers;
    if (!el) return;
    const MAX_VISIBLE = 3;
    const items = S.recentJoins || [];
    el.innerHTML = '';
    if (items.length === 0) return;
    const visible = items.slice(0, MAX_VISIBLE);
    const extra = items.length - MAX_VISIBLE;
    for (const u of visible) {
      const span = document.createElement('span');
      span.className = 'sc-recent-user';
      span.style.color = u.color || '#00f1ff';
      span.textContent = u.name;
      el.appendChild(span);
    }
    if (extra > 0) {
      const more = document.createElement('span');
      more.className = 'sc-recent-more';
      more.textContent = 'and ' + extra + ' more';
      el.appendChild(more);
    }
  }

  // ===========================================================================
  // DOM-BASED MESSAGE RENDERING (XSS-safe, no innerHTML with user text)
  // ===========================================================================
  function getCurrentMessages() {
    if (S.chatTarget) {
      const g = S.groups.get(S.chatTarget);
      return g ? g.messages : [];
    }
    return S.messages;
  }

  function isCurrentTarget(groupId) {
    return (groupId || null) === (S.chatTarget || null);
  }

  function renderChatMessages() {
    if (!S.ui.msgs) return;
    const list = getCurrentMessages();
    const start = Math.max(0, list.length - S.renderedCount);
    const visible = list.slice(start);
    const wasAtBottom = S.isAtBottom;
    const prevHeight = S.ui.msgs.scrollHeight;
    const prevTop = S.ui.msgs.scrollTop;
    const frag = document.createDocumentFragment();
    for (const msg of visible) frag.appendChild(createMessageEl(msg));
    S.ui.msgs.innerHTML = '';
    S.ui.msgs.appendChild(frag);
    if (wasAtBottom) {
      S.ui.msgs.scrollTop = S.ui.msgs.scrollHeight;
    } else {
      S.ui.msgs.scrollTop = prevTop + (S.ui.msgs.scrollHeight - prevHeight);
    }
    updateNewMsgsPill();
  }

  function createMessageEl(msg) {
    const el = document.createElement('div');
    const isMine = msg.userId === S.myId;
    el.className = 'sc-msg' + (isMine ? ' mine' : '') + (msg.isAdmin ? ' admin-msg' : '') + (msg.system ? ' system' : '');
    if (msg.id) el.dataset.msgId = msg.id;

    if (msg.system) {
      el.textContent = msg.text;
      return el;
    }

    el.style.color = msg.color || '#00f1ff';

    // Header (name + time) — all textContent, XSS-safe
    const header = document.createElement('div');
    header.className = 'sc-msg-header';
    const nameEl = document.createElement('span');
    nameEl.className = 'sc-msg-name';
    nameEl.textContent = msg.name || 'unknown';
    nameEl.style.cursor = 'pointer';
    nameEl.title = 'Click to @mention';
    nameEl.addEventListener('click', () => {
      S.ui.input.focus();
      const val = S.ui.input.value;
      const pos = S.ui.input.selectionStart;
      S.ui.input.value = val.slice(0, pos) + '@' + (msg.name || 'unknown') + ' ' + val.slice(pos);
      S.ui.input.selectionStart = S.ui.input.selectionEnd = pos + (msg.name || 'unknown').length + 2;
      S.ui.input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    header.appendChild(nameEl);
    if (msg.isAdmin) {
      const tag = document.createElement('span');
      tag.className = 'sc-msg-admin-tag';
      tag.textContent = 'ADMIN';
      header.appendChild(tag);
    }
    const user = S.users.get(msg.userId);
    if (user && user.status && user.sharingStatus !== false && !user.isAdmin && user.status !== 'idle') {
      const tag = document.createElement('span');
      tag.className = 'sc-msg-status-tag';
      tag.textContent = ({ puzzle: 'solving', stats: 'stats', sessions: 'browsing', menu: 'menu' })[user.status] || user.status;
      header.appendChild(tag);
    }
    const timeEl = document.createElement('span');
    timeEl.className = 'sc-msg-time';
    timeEl.textContent = formatTime(msg.timestamp);
    timeEl.title = formatFullTime(msg.timestamp);
    header.appendChild(timeEl);
    el.appendChild(header);

    // Text with linkified URLs — DOM-based, XSS-safe
    const textEl = document.createElement('div');
    textEl.className = 'sc-msg-text';
    textEl.appendChild(linkifyText(msg.text || ''));
    el.appendChild(textEl);

    return el;
  }

  // Build a DOM fragment from text, converting URLs to <a> elements
  // and @mentions to styled spans. XSS-safe (all text via createTextNode).
  function linkifyText(text) {
    const frag = document.createDocumentFragment();
    const regex = /(https?:\/\/[^\s<>"'\[\]()]+)|(@\w+)/gi;
    let last = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
      if (match.index > last) {
        frag.appendChild(document.createTextNode(text.slice(last, match.index)));
      }
      if (match[1]) {
        const a = document.createElement('a');
        a.href = match[1];
        a.target = '_blank';
        a.rel = 'noopener noreferrer nofollow';
        a.className = 'sc-link';
        a.textContent = match[1];
        frag.appendChild(a);
      } else {
        const span = document.createElement('span');
        span.className = 'sc-mention';
        span.textContent = match[2];
        span.style.cursor = 'pointer';
        span.addEventListener('click', () => {
          S.ui.input.focus();
          const val = S.ui.input.value;
          const pos = S.ui.input.selectionStart;
          const mention = match[2] + ' ';
          S.ui.input.value = val.slice(0, pos) + mention + val.slice(pos);
          S.ui.input.selectionStart = S.ui.input.selectionEnd = pos + mention.length;
          S.ui.input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        frag.appendChild(span);
      }
      last = match.index + match[0].length;
    }
    if (last < text.length) {
      frag.appendChild(document.createTextNode(text.slice(last)));
    }
    return frag;
  }

  function appendMessage(msg, isLocal) {
    if (msg.groupId) {
      const g = S.groups.get(msg.groupId);
      if (g) {
        g.messages.push(msg);
        if (g.messages.length > 1000) g.messages.shift();
      }
    } else {
      S.messages.push(msg);
      if (S.messages.length > 1000) S.messages.shift();
    }
    if (isCurrentTarget(msg.groupId)) {
      const wasAtBottom = S.isAtBottom;
      S.ui.msgs.appendChild(createMessageEl(msg));
      while (S.ui.msgs.children.length > MAX_RENDERED) {
        S.ui.msgs.removeChild(S.ui.msgs.firstChild);
      }
      if (wasAtBottom || isLocal) {
        S.ui.msgs.scrollTop = S.ui.msgs.scrollHeight;
      } else {
        S.newMsgsBadge++;
        updateNewMsgsPill();
      }
    }
  }

  function addSystemMessage(text, groupId) {
    appendMessage({
      type: 'chat', id: 'sys-' + Date.now(),
      userId: 'system', name: '', color: '#555',
      text: text, timestamp: Date.now() / 1000,
      groupId: groupId, system: true,
    });
  }

  function onMsgsScroll() {
    const el = S.ui.msgs;
    S.isAtBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
    if (S.isAtBottom) { S.newMsgsBadge = 0; updateNewMsgsPill(); }
    if (el.scrollTop < 50) {
      const list = getCurrentMessages();
      if (S.renderedCount < list.length) {
        S.renderedCount = Math.min(list.length, S.renderedCount + LOAD_MORE);
        const prevHeight = el.scrollHeight;
        const prevTop = el.scrollTop;
        renderChatMessages();
        el.scrollTop = prevTop + (el.scrollHeight - prevHeight);
      }
    }
  }

  function updateNewMsgsPill() {
    if (S.newMsgsBadge > 0 && !S.isAtBottom) {
      S.ui.newMsgs.style.display = 'block';
      S.ui.newMsgs.textContent = '↓ ' + S.newMsgsBadge + ' new message' + (S.newMsgsBadge > 1 ? 's' : '');
    } else {
      S.ui.newMsgs.style.display = 'none';
    }
  }

  // ===========================================================================
  // TYPING INDICATOR
  // ===========================================================================
  function renderTyping() {
    if (!S.ui.typing) return;
    const now = Date.now();
    let parts = [];
    for (const [key, info] of S.typingUsers) {
      if (info.expires < now) { S.typingUsers.delete(key); continue; }
      const span = document.createElement('span');
      span.className = 'sc-typing-name';
      span.style.color = info.color;
      span.textContent = info.name;
      parts.push(span);
    }
    S.ui.typing.innerHTML = '';
    if (parts.length === 0) return;
    for (let i = 0; i < parts.length; i++) {
      S.ui.typing.appendChild(parts[i]);
      if (i < parts.length - 1) S.ui.typing.appendChild(document.createTextNode(', '));
    }
    S.ui.typing.appendChild(document.createTextNode(parts.length === 1 ? ' is typing…' : ' are typing…'));
  }

  // ===========================================================================
  // ACTIVITY RENDERING (DOM-based)
  // ===========================================================================
  function renderActivity() {
    if (!S.ui.actList) return;
    let events = S.activity.slice().reverse();
    if (S.activityFilter.user !== 'all') {
      events = events.filter(e => e.name === S.activityFilter.user);
    }
    if (S.activityFilter.hideDNF) events = events.filter(e => !e.isDNF);
    if (S.activityFilter.hidden.size > 0) events = events.filter(e => !S.activityFilter.hidden.has(e.name));
    if (events.length === 0) {
      S.ui.actList.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'sc-empty';
      empty.textContent = 'No activity yet. Solve a puzzle to share!';
      S.ui.actList.appendChild(empty);
      updateUserFilter();
      renderHiddenUsers();
      return;
    }
    events = events.slice(0, 300);
    const frag = document.createDocumentFragment();
    for (const ev of events) frag.appendChild(createActivityEl(ev));
    S.ui.actList.innerHTML = '';
    S.ui.actList.appendChild(frag);
    updateUserFilter();
    renderHiddenUsers();
  }

  function createActivityEl(ev) {
    const el = document.createElement('div');
    el.className = 'sc-act-item';
    el.style.borderLeftColor = ev.color || '#555';
    const row = document.createElement('div');
    row.className = 'sc-act-row';
    const userEl = document.createElement('span');
    userEl.className = 'sc-act-user';
    userEl.style.color = ev.color || '#00f1ff';
    userEl.textContent = (ev.name || 'unknown') + ': ';
    const timeEl = document.createElement('span');
    timeEl.className = 'sc-act-time-val';
    timeEl.textContent = ev.time || '';
    row.appendChild(userEl); row.appendChild(timeEl);
    if (ev.moves || ev.tps) {
      const statsEl = document.createElement('span');
      statsEl.className = 'sc-act-meta';
      statsEl.textContent = '(' + (ev.moves || '0') + ' / ' + (ev.tps || '0') + ')';
      row.appendChild(statsEl);
    }
    if (ev.isDNF) {
      const dnfEl = document.createElement('span');
      dnfEl.className = 'sc-act-dnf';
      dnfEl.textContent = 'DNF';
      row.appendChild(dnfEl);
    }
    const hideBtn = document.createElement('button');
    hideBtn.className = 'sc-act-hide';
    hideBtn.textContent = '\u2715';
    hideBtn.title = 'Hide ' + (ev.name || 'user');
    hideBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleHideUser(ev.name); });
    row.appendChild(hideBtn);
    const whenEl = document.createElement('span');
    whenEl.className = 'sc-act-when';
    whenEl.textContent = formatTime(ev.timestamp);
    row.appendChild(whenEl);
    el.appendChild(row);
    const metaEl = document.createElement('div');
    metaEl.className = 'sc-act-meta';
    metaEl.style.color = '#777';
    if (ev.session) metaEl.textContent = 'in session ' + ev.session;
    el.appendChild(metaEl);
    return el;
  }

  function updateUserFilter() {
    if (!S.ui.actUserFilter) return;
    const current = S.activityFilter.user;
    const seen = new Set();
    const names = [];
    for (const ev of S.activity) {
      if (!seen.has(ev.name)) { seen.add(ev.name); names.push({ name: ev.name, color: ev.color }); }
    }
    S.ui.actUserFilter.innerHTML = '';
    const allOpt = document.createElement('option');
    allOpt.value = 'all'; allOpt.textContent = 'All users';
    S.ui.actUserFilter.appendChild(allOpt);
    for (const u of names) {
      const opt = document.createElement('option');
      opt.value = u.name; opt.textContent = u.name;
      if (u.name === current) opt.selected = true;
      S.ui.actUserFilter.appendChild(opt);
    }
    S.ui.actUserFilter.value = current;
  }

  function toggleHideUser(name) {
    if (S.activityFilter.hidden.has(name)) {
      S.activityFilter.hidden.delete(name);
    } else {
      S.activityFilter.hidden.add(name);
    }
    renderActivity();
    renderHiddenUsers();
  }

  function renderHiddenUsers() {
    if (!S.ui.actHidden) return;
    S.ui.actHidden.innerHTML = '';
    if (S.activityFilter.hidden.size === 0) return;
    const label = document.createElement('span');
    label.className = 'sc-act-hidden-label';
    label.textContent = 'Hidden:';
    S.ui.actHidden.appendChild(label);
    for (const name of S.activityFilter.hidden) {
      const tag = document.createElement('span');
      tag.className = 'sc-act-hidden-tag';
      tag.textContent = name + ' \u2715';
      tag.addEventListener('click', () => toggleHideUser(name));
      S.ui.actHidden.appendChild(tag);
    }
  }

  // ===========================================================================
  // USERS RENDERING (DOM-based)
  // ===========================================================================
  function renderUsers() {
    if (!S.ui.usersList) return;
    const users = Array.from(S.users.values()).sort((a, b) => {
      if (a.id === S.myId) return -1;
      if (b.id === S.myId) return 1;
      return (a.name || '').localeCompare(b.name || '');
    });
    if (users.length === 0) {
      S.ui.usersList.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'sc-empty'; empty.textContent = 'No one online.';
      S.ui.usersList.appendChild(empty);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const u of users) frag.appendChild(createUserEl(u));
    S.ui.usersList.innerHTML = '';
    S.ui.usersList.appendChild(frag);
  }

  function createUserEl(u) {
    const el = document.createElement('div');
    el.className = 'sc-user-item' + (u.id === S.myId ? ' me' : '');
    const isMe = u.id === S.myId;
    const status = u.isAdmin ? 'admin' : (u.sharingStatus === false ? 'hidden' : (u.status || 'idle'));
    const detail = u.isAdmin ? 'Admin panel' :
      (u.sharingStatus === false ? 'privacy on' : (u.statusDetail || ''));
    const statusLabel = ({ puzzle: 'solving', stats: 'stats', sessions: 'browsing',
      menu: 'menu', hidden: 'private', idle: 'idle', connecting: 'connecting',
      admin: 'admin' })[status] || status;
    let displayDetail = detail;
    if (!u.isAdmin && u.sharingStatus !== false) {
      const prefixes = ['Solving: ', 'Stats: '];
      for (const p of prefixes) {
        if (displayDetail.startsWith(p)) { displayDetail = displayDetail.slice(p.length); break; }
      }
      const redundant = ['Solving', 'Browsing stats', 'Main menu', 'Browsing sessions'];
      if (redundant.includes(displayDetail)) displayDetail = '';
    }
    const nameEl = document.createElement('span');
    nameEl.className = 'sc-user-name';
    nameEl.style.color = u.color || '#00f1ff';
    nameEl.textContent = (u.name || 'unknown') + (isMe ? ' (you)' : '');
    nameEl.style.cursor = 'pointer';
    nameEl.title = 'Click to @mention';
    nameEl.addEventListener('click', () => {
      S.ui.input.focus();
      const val = S.ui.input.value;
      const pos = S.ui.input.selectionStart;
      S.ui.input.value = val.slice(0, pos) + '@' + u.name + ' ' + val.slice(pos);
      S.ui.input.selectionStart = S.ui.input.selectionEnd = pos + u.name.length + 2;
      S.ui.input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const badgeEl = document.createElement('span');
    badgeEl.className = 'sc-user-badge ' + status;
    badgeEl.textContent = statusLabel;
    const statusEl = document.createElement('span');
    statusEl.className = 'sc-user-status';
    statusEl.textContent = displayDetail;
    el.appendChild(nameEl); el.appendChild(badgeEl); el.appendChild(statusEl);
    if (!isMe && !u.isAdmin) {
      const btn = document.createElement('button');
      btn.className = 'sc-invite-btn'; btn.textContent = 'Invite';
      btn.addEventListener('click', () => inviteUserToGroup(u));
      el.appendChild(btn);
    }
    return el;
  }

  function inviteUserToGroup(user) {
    const myGroups = Array.from(S.groups.values()).filter(g =>
      g.members.find(m => m.id === S.myId));
    if (myGroups.length === 0) {
      const name = prompt('Create a new group and invite ' + user.name + '?\n\nGroup name:');
      if (name && name.trim()) {
        S.pendingGroupInvite = { userId: user.id, userName: user.name, groupName: name.trim() };
        sendGroupCreate(name.trim());
      }
    } else {
      showModal({
        title: 'Invite ' + user.name,
        body: 'Choose a group to invite them to:',
        select: [{ value: '', label: '— create new group —' }].concat(
          myGroups.map(g => ({ value: g.id, label: g.name }))),
        buttons: [
          { text: 'Cancel', value: null },
          { text: 'Invite', value: 'ok', primary: true },
        ],
      }, (result) => {
        if (!result) return;
        if (result.select === '') {
          const name = prompt('New group name:');
          if (name && name.trim()) {
            S.pendingGroupInvite = { userId: user.id, userName: user.name, groupName: name.trim() };
            sendGroupCreate(name.trim());
          }
        } else {
          sendGroupInvite(result.select, user.id);
          toast('Invited ' + user.name);
        }
      });
    }
  }

  // ===========================================================================
  // GROUPS RENDERING (DOM-based)
  // ===========================================================================
  function renderGroups() {
    if (!S.ui.groupsList) return;
    const myGroups = Array.from(S.groups.values()).filter(g =>
      g.members.find(m => m.id === S.myId));
    S.ui.groupsList.innerHTML = '';

    const createBtn = document.createElement('button');
    createBtn.className = 'sc-create-btn';
    createBtn.textContent = '+ Create Group';
    createBtn.addEventListener('click', () => {
      const name = prompt('New group name:');
      if (name && name.trim()) sendGroupCreate(name.trim());
    });
    S.ui.groupsList.appendChild(createBtn);

    for (const inv of S.pendingInvites) {
      const card = document.createElement('div');
      card.className = 'sc-invite-card';
      const title = document.createElement('div');
      title.className = 'sc-invite-card-title';
      title.textContent = 'Invite: ' + inv.name;
      const from = document.createElement('div');
      from.className = 'sc-invite-card-from';
      from.textContent = 'From ' + (inv.inviterName || 'someone');
      const actions = document.createElement('div');
      actions.className = 'sc-group-actions';
      const acceptBtn = document.createElement('button');
      acceptBtn.className = 'sc-group-btn'; acceptBtn.textContent = 'Accept';
      acceptBtn.addEventListener('click', () => {
        sendGroupJoin(inv.groupId);
        S.pendingInvites = S.pendingInvites.filter(i => i.groupId !== inv.groupId);
        renderGroups();
      });
      const declineBtn = document.createElement('button');
      declineBtn.className = 'sc-group-btn danger'; declineBtn.textContent = 'Decline';
      declineBtn.addEventListener('click', () => {
        S.pendingInvites = S.pendingInvites.filter(i => i.groupId !== inv.groupId);
        renderGroups();
      });
      actions.appendChild(acceptBtn); actions.appendChild(declineBtn);
      card.appendChild(title); card.appendChild(from); card.appendChild(actions);
      S.ui.groupsList.appendChild(card);
    }

    if (myGroups.length === 0 && S.pendingInvites.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sc-empty';
      empty.textContent = 'No groups yet. Create one and invite people from the Users tab.';
      S.ui.groupsList.appendChild(empty);
    }

    for (const g of myGroups) {
      S.ui.groupsList.appendChild(createGroupEl(g));
    }
  }

  function createGroupEl(g) {
    const el = document.createElement('div');
    el.className = 'sc-group-item' + (S.chatTarget === g.id ? ' active' : '');
    const nameEl = document.createElement('div');
    nameEl.className = 'sc-group-name';
    nameEl.textContent = g.name;
    const metaEl = document.createElement('div');
    metaEl.className = 'sc-group-meta';
    metaEl.textContent = g.members.length + ' member' + (g.members.length !== 1 ? 's' : '');
    const membersEl = document.createElement('div');
    membersEl.className = 'sc-group-members';
    membersEl.textContent = g.members.map(m => m.name).join(', ');
    const actions = document.createElement('div');
    actions.className = 'sc-group-actions';
    const openBtn = document.createElement('button');
    openBtn.className = 'sc-group-btn'; openBtn.textContent = 'Open';
    openBtn.addEventListener('click', () => {
      S.chatTarget = g.id; updateChatTargetSelector(); renderGroups(); switchTab('chat');
    });
    const leaveBtn = document.createElement('button');
    leaveBtn.className = 'sc-group-btn danger'; leaveBtn.textContent = 'Leave';
    leaveBtn.addEventListener('click', () => {
      if (confirm('Leave this group?')) {
        sendGroupLeave(g.id);
        S.groups.delete(g.id);
        if (S.chatTarget === g.id) {
          S.chatTarget = null; updateChatTargetSelector(); renderChatMessages();
        }
        renderGroups();
      }
    });
    actions.appendChild(openBtn); actions.appendChild(leaveBtn);
    el.appendChild(nameEl); el.appendChild(metaEl); el.appendChild(membersEl); el.appendChild(actions);
    return el;
  }

  function updateChatTargetSelector() {
    if (!S.ui.chatTarget) return;
    const myGroups = Array.from(S.groups.values()).filter(g =>
      g.members.find(m => m.id === S.myId));
    S.ui.chatTarget.innerHTML = '';
    // Only show the selector if there are groups
    if (myGroups.length === 0) {
      S.ui.chatTarget.parentElement.style.display = 'none';
      return;
    }
    S.ui.chatTarget.parentElement.style.display = 'flex';
    const mainOpt = document.createElement('option');
    mainOpt.value = 'main'; mainOpt.textContent = 'Main Chat';
    if (S.chatTarget === null) mainOpt.selected = true;
    S.ui.chatTarget.appendChild(mainOpt);
    for (const g of myGroups) {
      const opt = document.createElement('option');
      opt.value = g.id; opt.textContent = g.name;
      if (S.chatTarget === g.id) opt.selected = true;
      S.ui.chatTarget.appendChild(opt);
    }
  }

  // ===========================================================================
  // SETTINGS RENDERING (DOM-based)
  // ===========================================================================
  function renderSettings() {
    if (!S.ui.settings) return;
    S.ui.settings.innerHTML = '';

    const sections = [
      { title: 'Privacy', rows: [
        { label: 'Share my status', desc: 'Shows others what you\'re doing (solving / browsing stats / etc.)',
          control: createToggle('shareStatus', S.shareStatus, (v) => {
            S.shareStatus = v; saveSettings();
            if (S.authed) { if (v) detectAndSendStatus(true); else sendStatus('hidden', ''); }
          })},
        { label: 'Share my activity', desc: 'Broadcasts your solves to the Activity tab.',
          control: createToggle('shareActivity', S.shareActivity, (v) => {
            S.shareActivity = v; saveSettings();
          })},
      ]},
      { title: 'Connection', rows: [
        { label: 'Server URL', desc: 'wss:// endpoint (TLS mandatory).',
          control: createTextInput(S.settings_serverUrl || SERVER_URL, (v) => {
            S.settings_serverUrl = v.trim(); saveSettings();
          })},
        { label: 'Password', desc: localStorage.getItem(PASSWORD_KEY) ? 'Set. Click to change.' : 'Not set.',
          control: createButton('Change', () => {
            const pw = prompt('Enter new chat password:');
            if (pw) { setPassword(pw); toast('Password updated. Reconnecting…');
              disconnect(); connect(); }
          })},
        { label: 'Reconnect', desc: 'State: ' + S.connState,
          control: createButton('Reconnect', () => {
            if (S.reconnectTimer) { clearTimeout(S.reconnectTimer); S.reconnectTimer = null; }
            disconnect();
            S.reconnectDelay = RECONNECT_MIN; connect();
          })},
      ]},
      { title: 'Window', rows: [
        { label: 'Reset position', desc: 'Move chat and mini button back to bottom-right.',
          control: createButton('Reset', () => {
            S.chatPos = { x: null, y: null };
            S.miniPos = { x: null, y: null };
            S.ui.chat.style.left = 'auto'; S.ui.chat.style.top = 'auto';
            S.ui.chat.style.right = '0px'; S.ui.chat.style.bottom = '0px';
            S.ui.mini.style.left = 'auto'; S.ui.mini.style.top = 'auto';
            S.ui.mini.style.right = '16px'; S.ui.mini.style.bottom = '16px';
            saveSettings();
          })},
      ]},
      { title: 'About', rows: [
        { label: 'SlidySim Chat v' + VERSION,
          desc: 'Random bright color per session. Egg-themed emoji panel. /rs = post latest solve in chat.',
          control: null },
      ]},
    ];

    for (const section of sections) {
      const secTitle = document.createElement('div');
      secTitle.className = 'sc-settings-section'; secTitle.textContent = section.title;
      S.ui.settings.appendChild(secTitle);
      for (const row of section.rows) {
        const rowEl = document.createElement('div');
        rowEl.className = 'sc-setting-row';
        const info = document.createElement('div');
        info.className = 'sc-setting-info';
        const label = document.createElement('div');
        label.className = 'sc-setting-label'; label.textContent = row.label;
        info.appendChild(label);
        if (row.desc) {
          const desc = document.createElement('div');
          desc.className = 'sc-setting-desc'; desc.textContent = row.desc;
          info.appendChild(desc);
        }
        rowEl.appendChild(info);
        if (row.control) rowEl.appendChild(row.control);
        S.ui.settings.appendChild(rowEl);
      }
    }
  }

  function createToggle(key, value, onChange) {
    const t = document.createElement('div');
    t.className = 'sc-toggle' + (value ? ' on' : '');
    t.addEventListener('click', () => {
      const v = !t.classList.contains('on');
      t.classList.toggle('on', v);
      onChange(v);
    });
    return t;
  }

  function createTextInput(value, onChange) {
    const input = document.createElement('input');
    input.type = 'text'; input.className = 'sc-text-input'; input.value = value;
    input.addEventListener('change', () => {
      onChange(input.value);
      toast('Setting saved. Reconnect to apply.');
    });
    return input;
  }

  function createButton(text, onClick) {
    const btn = document.createElement('button');
    btn.className = 'sc-btn'; btn.textContent = text;
    btn.addEventListener('click', onClick);
    return btn;
  }

  // ===========================================================================
  // EMOJI PANEL (egg + silly whitelist only)
  // ===========================================================================
  // ===========================================================================
  // LOGS RENDERING
  // ===========================================================================
  function renderLogs() {
    if (!S.ui.logsList) return;
    S.ui.logsList.innerHTML = '';
    S.ui.logsCount.textContent = S.debugLog.length + ' entries';
    const frag = document.createDocumentFragment();
    for (const entry of S.debugLog) {
      const el = document.createElement('div');
      el.className = 'sc-log-entry sc-log-' + entry.level;
      const time = document.createElement('span');
      time.className = 'sc-log-time';
      const d = new Date(entry.ts);
      time.textContent = String(d.getHours()).padStart(2, '0') + ':' +
        String(d.getMinutes()).padStart(2, '0') + ':' +
        String(d.getSeconds()).padStart(2, '0');
      const levelEl = document.createElement('span');
      levelEl.className = 'sc-log-level';
      levelEl.textContent = entry.level.toUpperCase();
      const msgEl = document.createElement('span');
      msgEl.className = 'sc-log-msg';
      msgEl.textContent = entry.msg;
      el.appendChild(time); el.appendChild(levelEl); el.appendChild(msgEl);
      frag.appendChild(el);
    }
    S.ui.logsList.appendChild(frag);
    S.ui.logsList.scrollTop = S.ui.logsList.scrollHeight;
  }

  function renderEmojiPanel() {
    S.ui.emojiPanel.innerHTML = '';
    for (const emoji of ALLOWED_EMOJIS) {
      const btn = document.createElement('button');
      btn.className = 'sc-emoji'; btn.type = 'button'; btn.textContent = emoji;
      btn.addEventListener('click', () => {
        const cursor = S.ui.input.selectionStart;
        const text = S.ui.input.value;
        S.ui.input.value = text.slice(0, cursor) + emoji + text.slice(cursor);
        S.ui.input.focus();
        S.ui.input.selectionStart = S.ui.input.selectionEnd = cursor + emoji.length;
        autoGrowInput();
      });
      S.ui.emojiPanel.appendChild(btn);
    }
  }

  // ===========================================================================
  // MODAL (DOM-based)
  // ===========================================================================
  function showModal(opts, callback) {
    const bg = document.createElement('div');
    bg.className = 'sc-modal-bg';
    const modal = document.createElement('div');
    modal.className = 'sc-modal';
    const h3 = document.createElement('h3'); h3.textContent = opts.title || '';
    modal.appendChild(h3);
    if (opts.body) {
      const p = document.createElement('p'); p.textContent = opts.body;
      modal.appendChild(p);
    }
    let selectEl = null;
    if (opts.select) {
      selectEl = document.createElement('select');
      selectEl.className = 'sc-text-input';
      for (const o of opts.select) {
        const opt = document.createElement('option');
        opt.value = o.value; opt.textContent = o.label;
        selectEl.appendChild(opt);
      }
      modal.appendChild(selectEl);
    }
    if (opts.input) {
      const input = document.createElement('input');
      input.type = 'text'; input.placeholder = opts.input.placeholder || '';
      modal.appendChild(input);
    }
    const actions = document.createElement('div');
    actions.className = 'sc-modal-actions';
    for (const b of opts.buttons) {
      const btn = document.createElement('button');
      btn.className = 'sc-btn'; btn.textContent = b.text;
      if (b.primary) { btn.style.color = '#00f1ff'; btn.style.borderColor = '#00bcd4'; }
      btn.addEventListener('click', () => {
        if (!b.value) { S.ui.root.removeChild(bg); callback(null); return; }
        const result = {};
        if (selectEl) result.select = selectEl.value;
        S.ui.root.removeChild(bg);
        callback(result);
      });
      actions.appendChild(btn);
    }
    modal.appendChild(actions);
    bg.appendChild(modal);
    bg.addEventListener('click', (e) => {
      if (e.target === bg) { S.ui.root.removeChild(bg); callback(null); }
    });
    S.ui.root.appendChild(bg);
  }

  // ===========================================================================
  // TOAST
  // ===========================================================================
  let toastTimer = null;
  function toast(msg) {
    if (!S.ui.toast) return;
    S.ui.toast.textContent = msg;
    S.ui.toast.style.display = 'block';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { S.ui.toast.style.display = 'none'; }, 3500);
  }

  // ===========================================================================
  // INIT
  // ===========================================================================
  function init() {
    loadSettings();
    buildUI();
    setConnState('disconnected');
    setupBridgeListener();
    connect();
    startObservers();
    // Heartbeat
    setInterval(() => { if (S.authed) send({ type: 'ping' }); }, 30000);
    // Periodic status check fallback
    setInterval(() => {
      if (S.authed && S.shareStatus) detectAndSendStatus(true);
    }, 3000);
    // Typing expiry check
    setInterval(() => {
      if (S.typingUsers.size > 0) renderTyping();
    }, 2000);
    window.addEventListener('beforeunload', disconnect);
    dlog('Initialized v' + VERSION + ', server: ' + (S.settings_serverUrl || SERVER_URL));
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init);
})();
