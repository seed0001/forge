import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { WorkspaceManager } from './workspace-manager';
import type { ChatMessage, ProjectSummary, SessionSummary } from './ipc-channels';
import { readFileBinaryDetailed } from './fs-service';

/** Enough for chat-attached media (generated images/audio) — extend if a new generator produces another type. */
const MEDIA_CONTENT_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

/** The phone's lighter-weight equivalent of ProjectHydration — just enough to render the chats list, not the desktop's full tab payload. */
interface SessionsListResponse {
  summary: ProjectSummary;
  sessions: SessionSummary[];
}

export interface PortalHandle {
  broadcastMessage: (projectId: string, sessionId: string, msg: ChatMessage) => void;
  broadcastStatus: (projectId: string, runningSessionIds: string[]) => void;
  close: () => void;
}

const COOKIE_NAME = 'forge_portal';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FAILED_LOGINS = 8;
const LOGIN_LOCKOUT_MS = 5 * 60 * 1000;

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/** Same-length-or-not, this always runs a real timingSafeEqual so a length mismatch doesn't return measurably faster than a near-miss. */
function passwordsMatch(candidate: string, real: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(real);
  if (a.length !== b.length) {
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function readJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

/**
 * The phone portal server: a password-gated, dependency-free HTTP + WebSocket
 * app that lets a phone browse every open workspace/project and its chats
 * (sessions), same as the desktop app, without ever touching the desktop's
 * own shared "active session" state — see Project.sendToSession and
 * Project.newBackgroundSession, which exist for exactly this "don't hijack
 * what the Operator is looking at" reason (built originally for the
 * scheduler).
 */
export function startPortalServer(
  manager: WorkspaceManager,
  getPortalPassword: () => string,
  port: number
): PortalHandle {
  /** token -> expiry epoch ms. In-memory only — a restart (or Disable) invalidates every login, which is fine: the tunnel URL itself is regenerated every time the portal is enabled anyway. */
  const validTokens = new Map<string, number>();
  let failedLogins = 0;
  let lockedUntil = 0;

  function isAuthed(req: http.IncomingMessage): boolean {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (!token) return false;
    const expiry = validTokens.get(token);
    if (!expiry || expiry < Date.now()) {
      validTokens.delete(token);
      return false;
    }
    return true;
  }

  /** projectId/sessionId are null until the socket sends its first `subscribe`. */
  const subs = new Map<WebSocket, { projectId: string | null; sessionId: string | null }>();

  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch((err) => {
      console.error('[portal] request failed:', err);
      if (!res.headersSent) res.writeHead(500);
      res.end('Internal error');
    });
  });

  server.listen(port, () => console.log(`[forge] portal server listening on http://localhost:${port}/`));

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (socket, req) => {
    if (!isAuthed(req)) {
      socket.close(4001, 'unauthorized');
      return;
    }
    subs.set(socket, { projectId: null, sessionId: null });
    socket.on('close', () => subs.delete(socket));
    socket.on('message', (raw) => {
      let data: any;
      try {
        data = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (data?.type === 'subscribe' && typeof data.projectId === 'string' && typeof data.sessionId === 'string') {
        const project = manager.findProject(data.projectId);
        if (!project || !project.listSessions().some((s) => s.id === data.sessionId)) return;
        subs.set(socket, { projectId: data.projectId, sessionId: data.sessionId });
        return;
      }
      if (data?.type === 'text' && typeof data.text === 'string' && data.text.trim()) {
        const sub = subs.get(socket);
        if (!sub?.projectId || !sub.sessionId) return;
        const project = manager.findProject(sub.projectId);
        void project?.sendToSession(sub.sessionId, data.text.trim(), 'portal').then((sent) => {
          if (!sent && socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'busy' }));
        });
      }
    });
  });

  function broadcastMessage(projectId: string, sessionId: string, msg: ChatMessage) {
    const json = JSON.stringify({ type: 'chat', msg });
    for (const [socket, sub] of subs) {
      if (socket.readyState === socket.OPEN && sub.projectId === projectId && sub.sessionId === sessionId) {
        socket.send(json);
      }
    }
  }

  function broadcastStatus(projectId: string, runningSessionIds: string[]) {
    for (const [socket, sub] of subs) {
      if (socket.readyState !== socket.OPEN || sub.projectId !== projectId || !sub.sessionId) continue;
      socket.send(JSON.stringify({ type: 'status', running: runningSessionIds.includes(sub.sessionId) }));
    }
  }

  async function handleLogin(req: http.IncomingMessage, res: http.ServerResponse) {
    if (Date.now() < lockedUntil) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Too many attempts — try again in a few minutes.' }));
      return;
    }
    const body = await readJsonBody(req);
    const candidate = typeof body.password === 'string' ? body.password : '';
    const real = getPortalPassword();
    if (!real || !passwordsMatch(candidate, real)) {
      failedLogins += 1;
      if (failedLogins >= MAX_FAILED_LOGINS) {
        lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
        failedLogins = 0;
      }
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Wrong password.' }));
      return;
    }
    failedLogins = 0;
    const token = crypto.randomBytes(32).toString('hex');
    validTokens.set(token, Date.now() + SESSION_TTL_MS);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      // No Secure attribute: cloudflared terminates TLS upstream, so this process only ever sees plain HTTP.
      'Set-Cookie': `${COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    });
    res.end(JSON.stringify({ ok: true }));
  }

  function handleLogout(req: http.IncomingMessage, res: http.ServerResponse) {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (token) validTokens.delete(token);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`,
    });
    res.end(JSON.stringify({ ok: true }));
  }

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const method = req.method ?? 'GET';
    const reqUrl = new URL(req.url ?? '/', 'http://localhost');
    const pathname = reqUrl.pathname;

    if (method === 'GET' && pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE_HTML);
      return;
    }

    if (method === 'GET' && pathname === '/api/me') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ authed: isAuthed(req) }));
      return;
    }

    if (method === 'POST' && pathname === '/api/login') {
      await handleLogin(req, res);
      return;
    }

    if (method === 'POST' && pathname === '/api/logout') {
      handleLogout(req, res);
      return;
    }

    // Everything below requires a valid session cookie.
    if (!isAuthed(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    if (method === 'GET' && pathname === '/api/projects') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(manager.list().map((w) => w.summary())));
      return;
    }

    if (method === 'POST' && pathname === '/api/projects') {
      const workspace = manager.createWorkspace('coding');
      const project = await manager.addProject(workspace.id, null);
      project?.setKind('coding');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(project?.summary() ?? null));
      return;
    }

    const sessionsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/sessions$/);
    if (sessionsMatch) {
      const project = manager.findProject(sessionsMatch[1]);
      if (!project) {
        res.writeHead(404);
        res.end('Project not found');
        return;
      }
      if (method === 'GET') {
        const body: SessionsListResponse = { summary: project.summary(), sessions: project.listSessions() };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
        return;
      }
      if (method === 'POST') {
        const session = project.newBackgroundSession('New chat');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(session));
        return;
      }
    }

    if (method === 'GET' && pathname === '/api/history') {
      const projectId = reqUrl.searchParams.get('projectId');
      const sessionId = reqUrl.searchParams.get('sessionId');
      const project = projectId ? manager.findProject(projectId) : undefined;
      if (!project || !sessionId) {
        res.writeHead(400);
        res.end('Bad request');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(project.getSessionChat(sessionId)));
      return;
    }

    if (method === 'GET' && pathname === '/api/media') {
      const projectId = reqUrl.searchParams.get('projectId');
      const rawPath = reqUrl.searchParams.get('path');
      const project = projectId ? manager.findProject(projectId) : undefined;
      const rootPath = project?.rootPath;
      if (!rootPath || !rawPath) {
        res.writeHead(400);
        res.end('Bad request');
        return;
      }
      // Root-scoped exactly like the desktop app's own file reads (fs-service's
      // assertInside, via readFileBinaryDetailed) — a phone-facing route is the
      // last place we want an arbitrary-file-read hole.
      const result = await readFileBinaryDetailed(rootPath, rawPath);
      if (!result.ok) {
        res.writeHead(result.reason === 'outside-root' ? 403 : 404);
        res.end(result.detail);
        return;
      }
      const ext = path.extname(rawPath).toLowerCase();
      const contentType = MEDIA_CONTENT_TYPES[ext] ?? 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': result.data.length });
      res.end(result.data);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  }

  return {
    broadcastMessage,
    broadcastStatus,
    close: () => {
      wss.close();
      server.close();
    },
  };
}

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Forge</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { height: 100%; margin: 0; }
  body {
    background: #0b0b0c;
    color: #e8e6e1;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    display: flex;
    flex-direction: column;
  }
  .screen { display: none; flex: 1; flex-direction: column; min-height: 0; }
  .screen.active { display: flex; }
  .col { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .row { display: flex; align-items: center; gap: 8px; }
  header {
    padding: env(safe-area-inset-top, 14px) 16px 12px;
    border-bottom: 1px solid #1e1e20;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-shrink: 0;
  }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; letter-spacing: 0.02em; }
  header .sub { font-size: 12px; color: #8a8a86; margin-top: 1px; }
  #status { font-size: 12px; color: #8a8a86; }
  #status.running { color: #d7b56d; }
  #status.disconnected { color: #b45050; }
  .header-btn {
    background: none;
    border: none;
    color: #d7b56d;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    padding: 4px 6px;
    white-space: nowrap;
  }
  .header-btn.plain { color: #c8c8c4; font-weight: 400; }
  #screen-login { align-items: center; justify-content: center; gap: 16px; padding: 24px; }
  #screen-login h1 { font-size: 20px; margin: 0; }
  #login-form { display: flex; flex-direction: column; gap: 10px; width: 100%; max-width: 280px; }
  #login-form input {
    background: #17171a;
    border: 1px solid #29292c;
    border-radius: 10px;
    color: #e8e6e1;
    padding: 12px 14px;
    font-size: 16px;
    outline: none;
  }
  #login-form button {
    background: #d7b56d;
    color: #17171a;
    border: none;
    border-radius: 10px;
    padding: 12px;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
  }
  #login-error { color: #b45050; font-size: 13px; min-height: 1.2em; text-align: center; }
  .card-list { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; -webkit-overflow-scrolling: touch; }
  .card-list-note { color: #8a8a86; font-size: 13px; padding: 4px 2px; }
  .workspace-group-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #6b6b68;
    margin: 10px 0 -2px 2px;
  }
  .workspace-group-label:first-child { margin-top: 0; }
  .card {
    background: #17171a;
    border: 1px solid #232326;
    border-radius: 12px;
    padding: 13px 15px;
    cursor: pointer;
  }
  .card:active { background: #1c1c1f; }
  .card-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .card-title { font-weight: 600; font-size: 15px; }
  .card-sub { font-size: 12px; color: #8a8a86; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #3a3a3d; flex-shrink: 0; }
  .status-dot.running { background: #d7b56d; animation: pulse 1.1s infinite; }
  #log {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .bubble { max-width: 86%; padding: 10px 13px; border-radius: 14px; word-wrap: break-word; overflow-wrap: break-word; }
  .user { align-self: flex-end; background: #2a2a2e; border-bottom-right-radius: 4px; }
  .assistant { align-self: flex-start; background: #17171a; border: 1px solid #232326; border-bottom-left-radius: 4px; }
  .bubble > *:first-child { margin-top: 0; }
  .bubble > *:last-child { margin-bottom: 0; }
  .bubble h1, .bubble h2, .bubble h3, .bubble h4, .bubble h5, .bubble h6 { margin: 0.5em 0 0.3em; font-weight: 600; line-height: 1.3; }
  .bubble h1 { font-size: 1.3em; }
  .bubble h2 { font-size: 1.18em; }
  .bubble h3 { font-size: 1.08em; }
  .bubble h4, .bubble h5, .bubble h6 { font-size: 1em; }
  .bubble p { margin: 0.5em 0; }
  .bubble ul, .bubble ol { margin: 0.5em 0; padding-left: 1.3em; }
  .bubble li { margin: 0.2em 0; }
  .bubble code {
    font-family: ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace;
    background: rgba(255, 255, 255, 0.09);
    padding: 0.15em 0.35em;
    border-radius: 4px;
    font-size: 0.88em;
  }
  .bubble pre.code-block {
    background: #0e0e10;
    border: 1px solid #232326;
    border-radius: 8px;
    padding: 10px 12px;
    margin: 0.5em 0;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
  .bubble pre.code-block code { background: none; padding: 0; font-size: 0.85em; white-space: pre; }
  .bubble a { color: #d7b56d; text-decoration: underline; word-break: break-word; }
  .bubble .table-wrap { overflow-x: auto; margin: 0.5em 0; -webkit-overflow-scrolling: touch; }
  .bubble table { border-collapse: collapse; width: 100%; font-size: 0.88em; }
  .bubble th, .bubble td { border: 1px solid #29292c; padding: 6px 10px; text-align: left; white-space: nowrap; }
  .bubble th { background: #1c1c1f; font-weight: 600; }
  .bubble img.chat-image { max-width: 100%; height: auto; border-radius: 8px; margin: 0.4em 0; display: block; }
  .bubble audio.chat-audio { width: 100%; margin: 0.4em 0; }
  #bar {
    display: flex;
    gap: 8px;
    padding: 10px 12px calc(env(safe-area-inset-bottom, 10px) + 10px);
    border-top: 1px solid #1e1e20;
    flex-shrink: 0;
    background: #0b0b0c;
  }
  #text {
    flex: 1;
    background: #17171a;
    border: 1px solid #29292c;
    border-radius: 20px;
    color: #e8e6e1;
    padding: 10px 16px;
    font-size: 15px;
    outline: none;
    resize: none;
    max-height: 120px;
  }
  button.round {
    flex-shrink: 0;
    width: 42px;
    height: 42px;
    border-radius: 50%;
    border: none;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    cursor: pointer;
  }
  #send { background: #d7b56d; color: #17171a; }
  #mic { background: #17171a; border: 1px solid #29292c; color: #e8e6e1; }
  #mic.recording { background: #b45050; color: white; animation: pulse 1.1s infinite; }
  #mic.hidden { display: none; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }
  #toast {
    position: fixed;
    bottom: 78px;
    left: 50%;
    transform: translateX(-50%);
    background: #17171a;
    border: 1px solid #29292c;
    color: #c8c8c4;
    font-size: 12px;
    padding: 6px 12px;
    border-radius: 12px;
    opacity: 0;
    transition: opacity 0.2s;
    pointer-events: none;
    white-space: nowrap;
    max-width: 90vw;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  #toast.show { opacity: 1; }
</style>
</head>
<body>

<div id="screen-login" class="screen">
  <h1>Forge</h1>
  <form id="login-form">
    <input id="login-password" type="password" placeholder="Portal password" autocomplete="current-password" autofocus />
    <button type="submit">Log in</button>
    <div id="login-error"></div>
  </form>
</div>

<div id="screen-projects" class="screen">
  <header>
    <div class="col">
      <h1>Projects</h1>
    </div>
    <div class="row">
      <button class="header-btn" id="new-project-btn">+ New</button>
      <button class="header-btn plain" id="logout-btn">Log out</button>
    </div>
  </header>
  <div class="card-list" id="projects-list"></div>
</div>

<div id="screen-sessions" class="screen">
  <header>
    <div class="col">
      <button class="header-btn plain" id="sessions-back-btn">‹ Projects</button>
      <div class="sub" id="sessions-project-name"></div>
    </div>
    <button class="header-btn" id="new-chat-btn">+ New chat</button>
  </header>
  <div class="card-list" id="sessions-list"></div>
</div>

<div id="screen-chat" class="screen">
  <header>
    <div class="col">
      <button class="header-btn plain" id="chat-back-btn">‹ Chats</button>
      <span id="status">connecting…</span>
    </div>
  </header>
  <div id="log"></div>
  <div id="toast"></div>
  <div id="bar">
    <button id="mic" class="round" title="Voice input">🎤</button>
    <textarea id="text" rows="1" placeholder="Message…"></textarea>
    <button id="send" class="round" title="Send">➤</button>
  </div>
</div>

<script>
(function () {
  const state = {
    projectId: localStorage.getItem('forge_portal_project') || null,
    sessionId: localStorage.getItem('forge_portal_session') || null,
    projectName: '',
  };

  const screens = {
    login: document.getElementById('screen-login'),
    projects: document.getElementById('screen-projects'),
    sessions: document.getElementById('screen-sessions'),
    chat: document.getElementById('screen-chat'),
  };
  function showScreen(name) {
    for (const key in screens) screens[key].classList.toggle('active', key === name);
  }

  async function api(path, opts) {
    const res = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...((opts && opts.headers) || {}) },
    });
    if (res.status === 401) {
      showScreen('login');
      throw new Error('unauthorized');
    }
    return res;
  }

  function relTime(ms) {
    const diff = Date.now() - ms;
    const min = Math.round(diff / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return min + 'm ago';
    const hr = Math.round(min / 60);
    if (hr < 24) return hr + 'h ago';
    return Math.round(hr / 24) + 'd ago';
  }

  // ── Login ─────────────────────────────────────────────────────────────
  const loginForm = document.getElementById('login-form');
  const loginPassword = document.getElementById('login-password');
  const loginError = document.getElementById('login-error');
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.textContent = '';
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: loginPassword.value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        loginError.textContent = data.error || 'Wrong password.';
        return;
      }
      loginPassword.value = '';
      boot();
    } catch {
      loginError.textContent = 'Could not reach the server.';
    }
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    try { await fetch('/api/logout', { method: 'POST' }); } catch {}
    localStorage.removeItem('forge_portal_project');
    localStorage.removeItem('forge_portal_session');
    if (ws) ws.close();
    showScreen('login');
  });

  // ── Projects screen ──────────────────────────────────────────────────
  const projectsList = document.getElementById('projects-list');

  function statusRunning(summary) {
    return summary.status === 'running';
  }

  async function loadProjects() {
    const res = await api('/api/projects');
    const workspaces = await res.json();
    projectsList.innerHTML = '';
    const showGroups = workspaces.length > 1;
    let any = false;
    for (const ws of workspaces) {
      if (!ws.projects.length) continue;
      if (showGroups) {
        const label = document.createElement('div');
        label.className = 'workspace-group-label';
        label.textContent = ws.label;
        projectsList.appendChild(label);
      }
      for (const p of ws.projects) {
        any = true;
        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML =
          '<div class="card-row"><span class="card-title"></span><span class="status-dot' +
          (statusRunning(p) ? ' running' : '') +
          '"></span></div>' +
          '<div class="card-sub"></div>';
        card.querySelector('.card-title').textContent = p.name;
        card.querySelector('.card-sub').textContent = p.rootPath ? p.rootPath.split(/[\\\\/]/).pop() : 'No folder yet';
        card.addEventListener('click', () => openProject(p.id, p.name));
        projectsList.appendChild(card);
      }
    }
    if (!any) {
      const note = document.createElement('div');
      note.className = 'card-list-note';
      note.textContent = 'No projects yet — tap "+ New" to start one.';
      projectsList.appendChild(note);
    }
  }

  document.getElementById('new-project-btn').addEventListener('click', async () => {
    const res = await api('/api/projects', { method: 'POST' });
    const project = await res.json();
    if (!project) return;
    const sres = await api('/api/projects/' + project.id + '/sessions');
    const hydration = await sres.json();
    const first = hydration.sessions[0];
    if (first) openSession(project.id, project.name, first.id);
    else openProject(project.id, project.name);
  });

  function openProject(projectId, name) {
    state.projectId = projectId;
    state.projectName = name;
    localStorage.setItem('forge_portal_project', projectId);
    document.getElementById('sessions-project-name').textContent = name;
    showScreen('sessions');
    void loadSessions();
  }

  document.getElementById('sessions-back-btn').addEventListener('click', () => {
    showScreen('projects');
    void loadProjects();
  });

  // ── Sessions (chats) screen ──────────────────────────────────────────
  const sessionsList = document.getElementById('sessions-list');

  async function loadSessions() {
    const res = await api('/api/projects/' + state.projectId + '/sessions');
    const hydration = await res.json();
    const running = new Set(hydration.summary.runningSessionIds || []);
    sessionsList.innerHTML = '';
    if (!hydration.sessions.length) {
      const note = document.createElement('div');
      note.className = 'card-list-note';
      note.textContent = 'No chats yet — tap "+ New chat" to start one.';
      sessionsList.appendChild(note);
      return;
    }
    for (const s of hydration.sessions) {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML =
        '<div class="card-row"><span class="card-title"></span><span class="status-dot' +
        (running.has(s.id) ? ' running' : '') +
        '"></span></div>' +
        '<div class="card-sub"></div>';
      card.querySelector('.card-title').textContent = s.title || 'New chat';
      const preview = s.preview ? s.preview : 'No messages yet';
      card.querySelector('.card-sub').textContent = preview + ' · ' + relTime(s.updatedAt);
      card.addEventListener('click', () => openSession(state.projectId, state.projectName, s.id));
      sessionsList.appendChild(card);
    }
  }

  document.getElementById('new-chat-btn').addEventListener('click', async () => {
    const res = await api('/api/projects/' + state.projectId + '/sessions', { method: 'POST' });
    const session = await res.json();
    openSession(state.projectId, state.projectName, session.id);
  });

  document.getElementById('chat-back-btn').addEventListener('click', () => {
    showScreen('sessions');
    void loadSessions();
  });

  function openSession(projectId, projectName, sessionId) {
    state.projectId = projectId;
    state.projectName = projectName;
    state.sessionId = sessionId;
    localStorage.setItem('forge_portal_project', projectId);
    localStorage.setItem('forge_portal_session', sessionId);
    showScreen('chat');
    void loadHistoryAndSubscribe();
  }

  // ── Chat screen ───────────────────────────────────────────────────────
  const log = document.getElementById('log');
  const statusEl = document.getElementById('status');
  const textEl = document.getElementById('text');
  const sendBtn = document.getElementById('send');
  const micBtn = document.getElementById('mic');
  const toast = document.getElementById('toast');

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('show'), 2600);
  }

  // --- Minimal, dependency-free markdown renderer -----------------------
  // Message text originates from the AI agent's own output, so raw HTML in
  // it is escaped FIRST; every transform below only ever adds tags we wrote
  // ourselves, so the escaped+transformed result is safe to drop in via
  // innerHTML.
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function splitTableRow(line) {
    let t = line.trim();
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|')) t = t.slice(0, -1);
    return t.split('|').map((c) => c.trim());
  }

  function isTableSeparatorLine(line) {
    const cells = splitTableRow(line);
    return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
  }

  function inlineFormat(text) {
    // Links first, so their [text] and (url) aren't mistaken for emphasis.
    text = text.replace(
      /\\[([^\\]]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );
    // Bold before italic -- consumes ** / __ pairs so the single-char italic
    // regexes below only ever see genuine single markers.
    text = text.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
    text = text.replace(/__(.+?)__/g, '<strong>$1</strong>');
    text = text.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
    text = text.replace(/_(.+?)_/g, '<em>$1</em>');
    return text;
  }

  function mdToHtml(src) {
    const escaped = escapeHtml(src);

    // Pull code (block + inline) out before any other transform touches the
    // text, so markdown/HTML-ish characters inside code are shown literally.
    const codeBlocks = [];
    let text = escaped.replace(/\`\`\`([a-zA-Z0-9_+-]*)\\n?([\\s\\S]*?)\`\`\`/g, function (_m, _lang, code) {
      const idx = codeBlocks.length;
      codeBlocks.push(code.replace(/\\n$/, ''));
      return ' CODEBLOCK' + idx + ' ';
    });
    const inlineCodes = [];
    text = text.replace(/\`([^\`\\n]+)\`/g, function (_m, code) {
      const idx = inlineCodes.length;
      inlineCodes.push(code);
      return ' INLINECODE' + idx + ' ';
    });

    const lines = text.split('\\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      // GFM pipe table: a row followed by a |---|---| separator row.
      if (line.indexOf('|') !== -1 && i + 1 < lines.length && isTableSeparatorLine(lines[i + 1])) {
        const headerCells = splitTableRow(line);
        i += 2;
        const bodyRows = [];
        while (i < lines.length && lines[i].trim() !== '' && lines[i].indexOf('|') !== -1) {
          bodyRows.push(splitTableRow(lines[i]));
          i++;
        }
        let html =
          '<div class="table-wrap"><table><thead><tr>' +
          headerCells.map((c) => '<th>' + inlineFormat(c) + '</th>').join('') +
          '</tr></thead><tbody>';
        for (const row of bodyRows) {
          html += '<tr>' + row.map((c) => '<td>' + inlineFormat(c) + '</td>').join('') + '</tr>';
        }
        html += '</tbody></table></div>';
        out.push(html);
        continue;
      }

      // Headers
      const headerMatch = line.match(/^(#{1,6})\\s+(.*)$/);
      if (headerMatch) {
        const level = headerMatch[1].length;
        out.push('<h' + level + '>' + inlineFormat(headerMatch[2]) + '</h' + level + '>');
        i++;
        continue;
      }

      // Bullet list
      if (/^\\s*[-*+]\\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\\s*[-*+]\\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\\s*[-*+]\\s+/, ''));
          i++;
        }
        out.push('<ul>' + items.map((it) => '<li>' + inlineFormat(it) + '</li>').join('') + '</ul>');
        continue;
      }

      // Numbered list
      if (/^\\s*\\d+[.)]\\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\\s*\\d+[.)]\\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\\s*\\d+[.)]\\s+/, ''));
          i++;
        }
        out.push('<ol>' + items.map((it) => '<li>' + inlineFormat(it) + '</li>').join('') + '</ol>');
        continue;
      }

      // Blank line separates blocks
      if (line.trim() === '') {
        i++;
        continue;
      }

      // Lone code-block placeholder line -- keep it out of paragraph grouping.
      // (Tested against the raw line, not a trimmed copy: trimming would eat
      // the leading/trailing space the placeholder and its restore regex both
      // rely on to delimit the token.)
      if (/^ CODEBLOCK\\d+ $/.test(line)) {
        out.push(line);
        i++;
        continue;
      }

      // Paragraph: gather consecutive plain lines, join with <br>
      const paraLines = [line];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        !/^(#{1,6})\\s+/.test(lines[i]) &&
        !/^\\s*[-*+]\\s+/.test(lines[i]) &&
        !/^\\s*\\d+[.)]\\s+/.test(lines[i]) &&
        !/^ CODEBLOCK\\d+ $/.test(lines[i])
      ) {
        paraLines.push(lines[i]);
        i++;
      }
      out.push('<p>' + inlineFormat(paraLines.join('<br>')) + '</p>');
    }

    let html = out.join('\\n');
    html = html.replace(
      / CODEBLOCK(\\d+) /g,
      function (_m, idx) { return '<pre class="code-block"><code>' + codeBlocks[Number(idx)] + '</code></pre>'; }
    );
    html = html.replace(/ INLINECODE(\\d+) /g, function (_m, idx) { return '<code>' + inlineCodes[Number(idx)] + '</code>'; });
    return html;
  }
  // ------------------------------------------------------------------------

  function bubble(role, text, images, audio) {
    const el = document.createElement('div');
    el.className = 'bubble ' + (role === 'user' ? 'user' : 'assistant');
    let html = text ? mdToHtml(text) : '';
    if (Array.isArray(images)) {
      for (const img of images) {
        if (!img || !img.path) continue;
        html +=
          '<img class="chat-image" src="/api/media?projectId=' +
          encodeURIComponent(state.projectId) +
          '&path=' +
          encodeURIComponent(img.path) +
          '" alt="' +
          escapeHtml(img.name || 'image') +
          '" />';
      }
    }
    if (Array.isArray(audio)) {
      for (const a of audio) {
        if (!a || !a.path) continue;
        html +=
          '<audio class="chat-audio" controls preload="none" src="/api/media?projectId=' +
          encodeURIComponent(state.projectId) +
          '&path=' +
          encodeURIComponent(a.path) +
          '"></audio>';
      }
    }
    el.innerHTML = html;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  // The browser's own TTS reads markdown syntax aloud verbatim — strip it to plain prose first.
  function stripMarkdownForSpeech(text) {
    return text
      .replace(/\`\`\`[\\s\\S]*?\`\`\`/g, ' code block omitted ')
      .replace(/\`([^\`]+)\`/g, '$1')
      .replace(/!\\[[^\\]]*\\]\\([^)]*\\)/g, '')
      .replace(/\\[([^\\]]+)\\]\\([^)]*\\)/g, '$1')
      .replace(/[*_#>~]/g, '')
      .trim();
  }

  let voiceReplyEnabled = false;
  function speak(text) {
    if (!voiceReplyEnabled || !('speechSynthesis' in window)) return;
    const clean = stripMarkdownForSpeech(text);
    if (!clean) return;
    speechSynthesis.cancel();
    speechSynthesis.speak(new SpeechSynthesisUtterance(clean));
  }

  async function loadHistoryAndSubscribe() {
    log.innerHTML = '';
    statusEl.textContent = 'connecting…';
    statusEl.className = '';
    try {
      const res = await api('/api/history?projectId=' + encodeURIComponent(state.projectId) + '&sessionId=' + encodeURIComponent(state.sessionId));
      const history = await res.json();
      for (const m of history) bubble(m.role, m.text || '', m.images, m.audio);
    } catch {
      return;
    }
    subscribe();
  }

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let ws;
  let wsReady = false;
  function connectSocket() {
    ws = new WebSocket(proto + '://' + location.host + '/ws');
    wsReady = false;
    ws.onopen = () => {
      wsReady = true;
      subscribe();
    };
    ws.onclose = () => {
      wsReady = false;
      if (screens.chat.classList.contains('active')) {
        statusEl.textContent = 'disconnected — retrying…';
        statusEl.className = 'disconnected';
      }
      setTimeout(connectSocket, 2000);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (evt) => {
      const data = JSON.parse(evt.data);
      if (data.type === 'chat') {
        bubble(data.msg.role, data.msg.text || '', data.msg.images, data.msg.audio);
        if (data.msg.role === 'assistant') speak(data.msg.text || '');
      } else if (data.type === 'status') {
        statusEl.textContent = data.running ? 'thinking…' : 'idle';
        statusEl.className = data.running ? 'running' : '';
      } else if (data.type === 'busy') {
        showToast('Still working on your last message…');
      }
    };
  }

  function subscribe() {
    if (!wsReady || !state.projectId || !state.sessionId) return;
    ws.send(JSON.stringify({ type: 'subscribe', projectId: state.projectId, sessionId: state.sessionId }));
    statusEl.textContent = 'idle';
    statusEl.className = '';
  }

  function send(text) {
    if (!text || !wsReady) return;
    // First send of any kind is the user gesture Safari/Chrome require before
    // speechSynthesis will actually play audio — enable it right here.
    voiceReplyEnabled = true;
    ws.send(JSON.stringify({ type: 'text', text }));
  }
  sendBtn.addEventListener('click', () => {
    const text = textEl.value.trim();
    send(text);
    textEl.value = '';
    textEl.style.height = 'auto';
  });
  textEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = textEl.value.trim();
      send(text);
      textEl.value = '';
      textEl.style.height = 'auto';
    }
  });
  textEl.addEventListener('input', () => {
    textEl.style.height = 'auto';
    textEl.style.height = Math.min(textEl.scrollHeight, 120) + 'px';
  });

  // Native browser speech-to-text — Chrome/Android/Edge support this well;
  // Safari/iOS does not implement SpeechRecognition, so the mic button hides
  // itself there and the person just types instead.
  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognitionCtor) {
    micBtn.classList.add('hidden');
  } else {
    const recognition = new SpeechRecognitionCtor();
    recognition.lang = navigator.language || 'en-US';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    let listening = false;

    recognition.onresult = (evt) => {
      const transcript = evt.results[0][0].transcript.trim();
      if (transcript) send(transcript);
    };
    recognition.onerror = (evt) => {
      if (evt.error !== 'aborted' && evt.error !== 'no-speech') showToast('Voice input error: ' + evt.error);
    };
    recognition.onend = () => {
      listening = false;
      micBtn.classList.remove('recording');
    };

    micBtn.addEventListener('click', () => {
      if (listening) {
        recognition.stop();
        return;
      }
      voiceReplyEnabled = true;
      try {
        recognition.start();
        listening = true;
        micBtn.classList.add('recording');
      } catch {
        // start() throws if already running — ignore, the toggle above handles it next tap.
      }
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────────
  async function boot() {
    let authed = false;
    try {
      const res = await fetch('/api/me');
      const data = await res.json();
      authed = !!data.authed;
    } catch {}
    if (!authed) {
      showScreen('login');
      return;
    }
    connectSocket();
    if (state.projectId && state.sessionId) {
      try {
        const res = await api('/api/projects/' + state.projectId + '/sessions');
        const hydration = await res.json();
        state.projectName = hydration.summary.name;
        const exists = hydration.sessions.some((s) => s.id === state.sessionId);
        if (exists) {
          document.getElementById('sessions-project-name').textContent = state.projectName;
          showScreen('chat');
          void loadHistoryAndSubscribe();
          return;
        }
      } catch {}
    }
    showScreen('projects');
    void loadProjects();
  }
  boot();
})();
</script>
</body>
</html>`;
