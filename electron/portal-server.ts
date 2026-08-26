import http from 'node:http';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Workspace } from './workspace';
import type { ChatMessage } from './ipc-channels';
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

export interface PortalHandle {
  broadcastMessage: (msg: ChatMessage) => void;
  broadcastStatus: (running: boolean) => void;
  close: () => void;
}

export function startPortalServer(getWorkspace: () => Workspace | null, port: number): PortalHandle {
  const clients = new Set<WebSocket>();

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, getWorkspace).catch((err) => {
      console.error('[portal] request failed:', err);
      if (!res.headersSent) res.writeHead(500);
      res.end('Internal error');
    });
  });

  server.listen(port, () => console.log(`[forge] portal server listening on http://localhost:${port}/`));

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (socket) => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    socket.on('message', (raw) => {
      let data: any;
      try {
        data = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (data?.type === 'text' && typeof data.text === 'string' && data.text.trim()) {
        void getWorkspace()?.sendToAgent(data.text.trim(), undefined, 'portal');
      }
    });
  });

  function broadcast(payload: unknown) {
    const json = JSON.stringify(payload);
    for (const c of clients) if (c.readyState === c.OPEN) c.send(json);
  }

  return {
    broadcastMessage: (msg) => broadcast({ type: 'chat', msg }),
    broadcastStatus: (running) => broadcast({ type: 'status', running }),
    close: () => {
      wss.close();
      server.close();
    },
  };
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  getWorkspace: () => Workspace | null
) {
  const url = req.url ?? '/';

  if (req.method === 'GET' && url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE_HTML);
    return;
  }

  if (req.method === 'GET' && url === '/api/history') {
    const ws = getWorkspace();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ws?.chat ?? []));
    return;
  }

  if (req.method === 'GET' && url.startsWith('/api/media')) {
    const ws = getWorkspace();
    const rootPath = ws?.rootPath;
    const reqUrl = new URL(url, 'http://localhost');
    const rawPath = reqUrl.searchParams.get('path');
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
  header {
    padding: env(safe-area-inset-top, 14px) 16px 12px;
    border-bottom: 1px solid #1e1e20;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
  }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; letter-spacing: 0.02em; }
  #status { font-size: 12px; color: #8a8a86; }
  #status.running { color: #d7b56d; }
  #status.disconnected { color: #b45050; }
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
<header>
  <h1>Forge</h1>
  <span id="status">connecting…</span>
</header>
<div id="log"></div>
<div id="toast"></div>
<div id="bar">
  <button id="mic" class="round" title="Voice input">🎤</button>
  <textarea id="text" rows="1" placeholder="Message…"></textarea>
  <button id="send" class="round" title="Send">➤</button>
</div>
<script>
(function () {
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
          '<img class="chat-image" src="/api/media?path=' +
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
          '<audio class="chat-audio" controls preload="none" src="/api/media?path=' +
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

  fetch('/api/history').then((r) => r.json()).then((history) => {
    for (const m of history) bubble(m.role, m.text || '', m.images, m.audio);
  }).catch(() => {});

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let ws;
  function connect() {
    ws = new WebSocket(proto + '://' + location.host + '/ws');
    ws.onopen = () => { statusEl.textContent = 'idle'; statusEl.className = ''; };
    ws.onclose = () => {
      statusEl.textContent = 'disconnected — retrying…';
      statusEl.className = 'disconnected';
      setTimeout(connect, 2000);
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
      }
    };
  }
  connect();

  function send(text) {
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
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
})();
</script>
</body>
</html>`;
