import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Workspace } from './workspace';
import type { ChatMessage } from './ipc-channels';

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
        void getWorkspace()?.sendToAgent(data.text.trim());
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
  .bubble { max-width: 86%; padding: 10px 13px; border-radius: 14px; white-space: pre-wrap; word-wrap: break-word; }
  .user { align-self: flex-end; background: #2a2a2e; border-bottom-right-radius: 4px; }
  .assistant { align-self: flex-start; background: #17171a; border: 1px solid #232326; border-bottom-left-radius: 4px; }
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

  function bubble(role, text) {
    const el = document.createElement('div');
    el.className = 'bubble ' + (role === 'user' ? 'user' : 'assistant');
    el.textContent = text;
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
    for (const m of history) bubble(m.role, m.text || '');
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
        bubble(data.msg.role, data.msg.text || '');
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
