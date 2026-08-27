import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { loadEnv, setEnvValue } from './env';
import { loadWorkspaceIndex, saveWorkspaceIndex } from './workspace-index-store';
import { transcribe } from './transcribe';
import { synthesizeSpeech, listVoices as listTtsVoices } from './tts-service';
import { startPortalServer, type PortalHandle } from './portal-server';
import { activeProviderId } from './chat-provider';
import { IPC, SETTINGS_KEYS, SECRET_SETTINGS_KEYS, SECRET_SENTINEL, MAX_TOOL_CALLS_LIMIT, MODEL_ENV_KEY } from './ipc-channels';
import type {
  ProjectHydration,
  ChatImage,
  ProviderSettings,
  ChatProvider,
  RoadmapItemStatus,
  WorkspaceKind,
  WorkspaceType,
  PermissionOverrides,
  ApprovalDecision,
  ScheduleSpec,
  TtsProvider,
} from './ipc-channels';
import * as fsService from './fs-service';
import { WorkspaceManager } from './workspace-manager';
import { saveAttachment, attachmentDirFor, readImageAsDataUrl } from './attachment-store';
import { listCatalogModels } from './models-service';
import { initUpdater, checkForUpdates, downloadUpdate, installUpdate } from './updater';
import { BrowserViewManager } from './browser-view-manager';
import { loadPermissionOverrides, savePermissionOverrides, loadBashAllowlist, saveBashAllowlist } from './perm-store';
import { createOverlayWindow, overlaySend } from './overlay-window';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * In dev, __dirname's parent is the project root — a normal writable folder.
 * Packaged, it's inside app.asar: read-only, and shared by every user of the
 * install, so it can never hold this machine's own .env. userData (per-user,
 * per-app, always writable — e.g. %APPDATA%/Forge on Windows) is the packaged
 * equivalent; .env.example still ships inside the asar purely as the template
 * copied from on first run.
 */
const envExample = path.join(__dirname, '..', '.env.example');
const envFile = path.join(app.isPackaged ? app.getPath('userData') : path.join(__dirname, '..'), '.env');
if (!fs.existsSync(envFile) && fs.existsSync(envExample)) {
  fs.copyFileSync(envExample, envFile);
}
loadEnv(envFile);

// The agent's standing rules now live in a single Operator-owned file
// (userData/RULES.md, see rules-store.ts) — read into every session, appended to
// only when the Operator explicitly asks. No bundled ruleset, no RULES_DIR.

// Seed the permission overrides cache so project.ts's resolvePermission
// never needs to do a synchronous file read on the hot path.
loadPermissionOverrides();

let win: BrowserWindow | null = null;

function send(channel: string, ...args: unknown[]) {
  win?.webContents.send(channel, ...args);
}

/**
 * The phone portal mirrors ONE project (the active project of the same
 * workspace this desktop app opens on startup) — set once that project
 * exists, in app.whenReady. Declared up here because the WorkspaceManager's
 * emit callbacks (which fire from deep inside agent turns) are wired before
 * that project is created.
 */
let portal: PortalHandle | null = null;
let portalProjectId: string | null = null;
/** Which WORKSPACE was focused last — tracked so it can be persisted and restored across restarts, and (via its active project) reported to the renderer's first load via IPC.wsGetInitialActive. */
let activeWorkspaceId: string | null = null;
let portalTunnelProc: ReturnType<typeof spawn> | null = null;
/** Current tunnel state — polled by the renderer's Portal control on mount via IPC.portalGetStatus, pushed live via IPC.portalStatus. Stays 'disabled' until the Operator explicitly enables it in Settings. */
let portalStatus: import('./ipc-channels').PortalStatus = { state: 'disabled' };
function setPortalStatus(next: typeof portalStatus) {
  portalStatus = next;
  send(IPC.portalStatus, next);
}

// Killing the tunnel process on quit is a single, permanent listener that
// always reads the LIVE portalTunnelProc — not registered per-enable, so
// toggling the portal on/off repeatedly across a session can never stack up
// duplicate listeners holding stale process references.
// Closing the main window only hides it (the Orb overlay stays and keeps the
// app alive); a genuine quit comes from the Orb menu / app.quit(), which sets
// this so the main window's close handler stops intercepting.
let quitting = false;
app.on('before-quit', () => {
  quitting = true;
  portalTunnelProc?.kill();
});

/** Writes the current workspace/project structure and active tab to disk — called after any mutation that should be remembered for next launch. */
async function persistWorkspaceIndex(): Promise<void> {
  const list = manager.list();
  const workspaces = list.map((workspace) => {
    const projects = workspace.listProjects();
    return {
      label: workspace.label,
      type: workspace.type,
      metaFile: workspace.metaFile,
      projects: projects.map((p) => ({ rootPath: p.rootPath, kind: p.kind })),
      activeProjectIndex: Math.max(
        0,
        projects.findIndex((p) => p.id === workspace.activeProjectId)
      ),
    };
  });
  const activeWorkspaceIndex = Math.max(
    0,
    list.findIndex((w) => w.id === activeWorkspaceId)
  );
  await saveWorkspaceIndex({ workspaces, activeWorkspaceIndex });
}

// This ProjectEmit is wired with each callback keyed by a PROJECT id (the
// argument name below is literally what Project passes as `this.id` — see
// electron/project.ts). manager.findProject() resolves it without needing to
// know which Workspace that project lives in.
const manager = new WorkspaceManager({
  terminal: (projectId, evt) => send(IPC.termData, projectId, evt),
  activity: (projectId, sessionId, evt) => {
    send(IPC.agentActivity, projectId, sessionId, evt);
    if (projectId === orbProjectId) overlaySend(IPC.overlayAgentActivity, evt);
  },
  message: (projectId, sessionId, msg) => {
    send(IPC.agentMessage, projectId, sessionId, msg);
    if (projectId === portalProjectId) portal?.broadcastMessage(msg);
    if (
      projectId === orbProjectId &&
      !msg.note &&
      msg.role === 'assistant' &&
      typeof msg.text === 'string' &&
      msg.text.trim()
    ) {
      console.log('[orb] reply:', msg.text.slice(0, 200));
      overlaySend(IPC.overlayAgentReply, msg.text);
      void speakThroughOrb(msg.text);
    }
  },
  status: (projectId) => {
    const project = manager.findProject(projectId);
    if (project) send(IPC.wsUpdated, project.summary());
    if (project && projectId === portalProjectId) portal?.broadcastStatus(project.status === 'running');
    if (project && projectId === orbProjectId) {
      overlaySend(IPC.overlayAgentStatus, project.status === 'running');
    }
  },
  diffProposed: (projectId, diff) => send(IPC.diffProposed, projectId, diff),
  diffUpdated: (projectId, diff) => send(IPC.diffUpdated, projectId, diff),
  sessions: (projectId) => {
    const project = manager.findProject(projectId);
    if (project) send(IPC.sessUpdated, projectId, project.listSessions());
  },
  commandApproval: (projectId, sessionId, requestId, command, category) =>
    send(IPC.cmdApprovalRequest, projectId, { requestId, command, sessionId, category }),
  subagentCommandApproval: (projectId, req) => send(IPC.subagentCmdApprovalRequest, projectId, req),
  roadmapUpdated: (projectId, sessionId, items) => send(IPC.roadmapUpdated, projectId, sessionId, items),
  schedulerUpdated: (projectId, tasks) => send(IPC.schedUpdated, projectId, tasks),
  focusUpdated: (projectId, agents) => send(IPC.focusUpdated, projectId, agents),
  focusBoardUpdated: (projectId, messages) => send(IPC.focusBoardUpdated, projectId, messages),
  focusQuestion: (projectId, req) => send(IPC.focusQuestionRequest, projectId, req),
});

// Scheduled tasks are ticked centrally rather than each project running its
// own timer — one interval, checked against every open project's own
// schedule list, is simpler to reason about and impossible to leak a timer
// from when a project closes.
setInterval(() => {
  for (const workspace of manager.list()) {
    for (const project of workspace.listProjects()) project.tickScheduler();
  }
}, 20_000);

const browserViewManager = new BrowserViewManager((workspaceId, state) => send(IPC.browserNavState, workspaceId, state));

function loadContent(w: BrowserWindow) {
  if (process.env.VITE_DEV_SERVER_URL) {
    w.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    w.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

/**
 * Spawns `cloudflared tunnel --url` — a "quick tunnel": no Cloudflare account,
 * no login, no DNS setup, just an ephemeral https://*.trycloudflare.com URL
 * that proxies straight to the portal server. Only ever called in direct
 * response to the Operator clicking "Enable" in Settings (see enablePortal) —
 * never automatically. The URL is shown once, in the Settings panel that's
 * already open when this fires; it is deliberately NOT also written to a
 * plaintext file or popped as an OS notification, since either one just
 * copies the same "whoever sees this can use the portal" risk onto a second,
 * less controlled surface (a file other local software can read, a banner
 * visible on a lock screen) for no real benefit over the panel itself.
 */
function startPortalTunnel(port: number) {
  setPortalStatus({ state: 'starting' });

  let proc;
  try {
    proc = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    setPortalStatus({ state: 'unavailable', reason: String(err) });
    return;
  }
  portalTunnelProc = proc;

  proc.on('error', (err) => {
    console.warn('[forge] cloudflared not available:', err.message);
    setPortalStatus({ state: 'unavailable', reason: err.message });
  });

  let announced = false;
  const onOutput = (chunk: Buffer) => {
    if (announced) return;
    const match = chunk.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (!match) return;
    announced = true;
    console.log(`[forge] portal available at: ${match[0]}`);
    setPortalStatus({ state: 'ready', url: match[0] });
  };
  proc.stdout.on('data', onOutput);
  proc.stderr.on('data', onOutput); // cloudflared logs its assigned URL to stderr, not stdout.

  proc.on('exit', (code) => {
    if (portalTunnelProc === proc) portalTunnelProc = null;
    if (!announced) setPortalStatus({ state: 'unavailable', reason: `cloudflared exited (code ${code})` });
  });
}

/** Idempotent — a second call while already running/starting is a no-op. */
function enablePortal() {
  if (portal || portalStatus.state === 'starting') return;
  const target = manager.findProject(portalProjectId ?? '') ?? manager.list()[0]?.activeProject;
  if (!target) {
    setPortalStatus({ state: 'unavailable', reason: 'No project open yet.' });
    return;
  }
  portalProjectId = target.id;
  const portalPort = Number(process.env.PORTAL_PORT) || 5333;
  portal = startPortalServer(() => manager.findProject(portalProjectId!) ?? null, portalPort);
  startPortalTunnel(portalPort);
}

function disablePortal() {
  portalTunnelProc?.kill();
  portalTunnelProc = null;
  portal?.close();
  portal = null;
  setPortalStatus({ state: 'disabled' });
}

function createWindow() {
  const w = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#000000',
    // The Orb overlay is the front door; the main window opens on demand.
    show: false,
    // Created hidden — force it to render anyway so it's ready the instant the
    // Orb summons it, instead of showing a black frame that fills in later.
    paintWhenInitiallyHidden: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#000000', symbolColor: '#a8a8a4', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  // A renderer crash (OOM, native module fault, etc.) leaves the BrowserWindow
  // alive but blank — Electron does not close it or fire window-all-closed on
  // its own. Reload in place so the user gets the app back instead of a black
  // screen with no way out except force-quitting the whole process.
  w.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[forge] renderer process gone: ${details.reason}`);
    if (!w.isDestroyed()) loadContent(w);
  });

  w.webContents.on('unresponsive', () => {
    console.error('[forge] renderer unresponsive');
  });

  // The main window is a thing the Orb summons — closing it just hides it.
  w.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      w.hide();
    }
  });
  w.on('closed', () => {
    if (win === w) win = null;
  });

  win = w;
  loadContent(w);
}

/** Show the main Forge window, creating it if it was never made / was destroyed. */
function showMainWindow() {
  if (!win || win.isDestroyed()) createWindow();
  win?.show();
  win?.focus();
}

// ── The Orb's own agent ────────────────────────────────────────────────
// A dedicated project the desktop Orb talks to. Full autonomy (spoken
// confirmations for risky actions come later); its replies are spoken aloud
// through the Orb using whatever TTS voice Forge is configured for.
let orbProjectId: string | null = null;

async function ensureOrbProject() {
  if (orbProjectId) {
    const existing = manager.findProject(orbProjectId);
    if (existing) return existing;
  }
  const ws = manager.createWorkspace('coding', 'Orb');
  const project = await manager.addProject(ws.id, app.getPath('home'), 'chat');
  if (!project) return null;
  orbProjectId = project.id;
  project.setAutonomy('auto');
  void persistWorkspaceIndex();
  return project;
}

async function orbAsk(text: string) {
  console.log('[orb] ask:', text);
  const project = await ensureOrbProject();
  if (!project) {
    overlaySend(IPC.overlayAgentReply, "I couldn't start my agent.");
    return;
  }
  try {
    await project.sendToAgent(text);
  } catch (err) {
    console.error('[orb] sendToAgent failed:', err);
    overlaySend(IPC.overlayAgentReply, 'Something went wrong on my end.');
  }
}

function orbStopAgent() {
  if (orbProjectId) manager.findProject(orbProjectId)?.stopAgent();
}

function spokenSummary(text: string, limit = 420): string {
  const flat = text.replace(/```[\s\S]*?```/g, ' (code) ').replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return stop > limit * 0.5 ? cut.slice(0, stop + 1) : cut.replace(/\s\S*$/, '') + '…';
}

async function speakThroughOrb(text: string) {
  const provider = (process.env.TTS_PROVIDER || 'edge') as TtsProvider;
  const voice =
    provider === 'sapi'
      ? process.env.TTS_SAPI_VOICE || ''
      : provider === 'xtts'
        ? process.env.TTS_XTTS_VOICE || ''
        : process.env.TTS_EDGE_VOICE || 'en-US-AndrewNeural';
  try {
    const res = await synthesizeSpeech(spokenSummary(text), provider, voice);
    if (res.audio) {
      overlaySend(IPC.overlaySpeak, { b64: res.audio.toString('base64'), mime: res.mimeType });
    }
  } catch {
    /* a failed synthesis just means no voice for this reply */
  }
}

app.whenReady().then(async () => {
  // Only what the app actually uses: the mic for voice input, and clipboard
  // writes for the "Copy" button on code blocks. Electron consults both the
  // async request handler and the sync check handler depending on the API and
  // platform, so both need to agree or a call silently rejects.
  const ALLOWED = new Set(['media', 'clipboard-write', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => ALLOWED.has(permission));

  // Reopen every workspace (and every project inside each) that was open
  // last time, in the same order, pointed at the same folders (or blank),
  // with the same Coding/Browsing kind so a reopened project skips straight
  // back to its chat instead of landing on the chooser screen again. A fresh
  // install (no index yet) falls back to today's default: in dev, the
  // project's own folder so there's something real on screen immediately;
  // packaged, that folder is inside the read-only asar and isn't a real
  // project anyway, so start with one blank workspace/project and let the
  // user pick one. Note that neither workspace nor project ids are persisted
  // (they never were, even before the workspace/project split) — this just
  // rebuilds the same label/type/folder/kind structure with freshly minted ids.
  const index = await loadWorkspaceIndex();
  const restoreWorkspaces =
    index.workspaces.length > 0
      ? index.workspaces
      : [
          {
            label: 'Workspace 1',
            type: 'coding' as WorkspaceType,
            metaFile: '',
            projects: [{ rootPath: app.isPackaged ? null : path.join(__dirname, '..'), kind: null }],
            activeProjectIndex: 0,
          },
        ];
  const restoredWorkspaces = await Promise.all(
    restoreWorkspaces.map(async (entry) => {
      const workspace = manager.createWorkspace(entry.type, entry.label);
      workspace.metaFile = entry.metaFile;
      const projects = await Promise.all(
        entry.projects.map(async (p) => {
          const project = await manager.addProject(workspace.id, p.rootPath, p.kind);
          if (project) void project.restoreSessions();
          return project;
        })
      );
      const activeIdx = Math.min(Math.max(entry.activeProjectIndex, 0), Math.max(projects.length - 1, 0));
      const activeProject = projects[activeIdx] ?? projects[0];
      if (activeProject) workspace.setActiveProject(activeProject.id);
      return workspace;
    })
  );

  const activeIdx = Math.min(Math.max(index.activeWorkspaceIndex, 0), restoredWorkspaces.length - 1);
  activeWorkspaceId = restoredWorkspaces[activeIdx]?.id ?? restoredWorkspaces[0]?.id ?? null;

  // Remembers which project the portal would mirror once enabled — the
  // server and tunnel themselves only ever start in response to the
  // Operator's own click in Settings (see enablePortal), never here.
  portalProjectId = (activeWorkspaceId ? manager.get(activeWorkspaceId) : undefined)?.activeProjectId ?? null;

  createWindow();
  try {
    createOverlayWindow({
      showMainWindow,
      quit: () => app.quit(),
      ask: (t) => void orbAsk(t),
      stopAgent: orbStopAgent,
    });
  } catch (err) {
    // A broken overlay must never take down the main app.
    console.error('[forge] overlay window failed to start:', err);
    showMainWindow();
  }
  initUpdater((status) => send(IPC.updateStatus, status));

  // ── Renderer-facing "workspace" (= project tab) surface ─────────────────
  // Every one of these keeps its pre-restructure signature and meaning: one
  // tab per Project, `id` is a project id. Each Workspace this creates gets
  // exactly one Project under it for now — the real multi-project-per-
  // workspace surface is the wsTreeList/projectAdd/etc. section further down,
  // not yet wired into any UI control.

  ipcMain.handle(IPC.wsList, async () =>
    manager.list().flatMap((workspace) => workspace.listProjects().map((p) => p.summary()))
  );

  ipcMain.handle(IPC.wsGetInitialActive, async () => {
    const workspace = activeWorkspaceId ? manager.get(activeWorkspaceId) : undefined;
    return workspace?.activeProjectId ?? null;
  });

  ipcMain.handle(IPC.wsSetActive, async (_e, projectId: string) => {
    const workspace = manager.workspaceContaining(projectId);
    if (workspace) {
      activeWorkspaceId = workspace.id;
      workspace.setActiveProject(projectId);
    }
    void persistWorkspaceIndex();
    return true;
  });

  ipcMain.handle(IPC.wsCreate, async (_e, type?: WorkspaceType) => {
    const workspace = manager.createWorkspace(type ?? 'coding');
    const project = await manager.addProject(workspace.id, null);
    void persistWorkspaceIndex();
    return project!.summary();
  });

  ipcMain.handle(IPC.wsClose, async (_e, projectId: string) => {
    const workspace = manager.workspaceContaining(projectId);
    if (workspace) {
      for (const p of workspace.listProjects()) browserViewManager.forgetWorkspace(p.id);
      manager.close(workspace.id);
    }
    void persistWorkspaceIndex();
    return manager.list().flatMap((w) => w.listProjects().map((p) => p.summary()));
  });

  ipcMain.handle(IPC.wsMarkSeen, async (_e, projectId: string) => {
    const project = manager.findProject(projectId);
    if (!project) return null;
    project.markSeen();
    return project.summary();
  });

  ipcMain.handle(IPC.wsSetAutonomy, async (_e, projectId: string, level: 'manual' | 'balanced' | 'auto') => {
    const project = manager.findProject(projectId);
    if (!project) return null;
    project.setAutonomy(level);
    return project.summary();
  });

  ipcMain.handle(IPC.wsSetKind, async (_e, projectId: string, kind: WorkspaceKind) => {
    const project = manager.findProject(projectId);
    if (!project) return null;
    project.setKind(kind);
    void persistWorkspaceIndex();
    return project.summary();
  });

  ipcMain.handle(IPC.wsSetClipsFolder, async (_e, projectId: string) => {
    const project = manager.findProject(projectId);
    if (!project || !win) return null;
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (result.canceled || result.filePaths.length === 0) return null;
    project.setClipsFolder(result.filePaths[0]);
    return project.summary();
  });

  // ── Real Workspace-level CRUD (new — not yet wired into any UI control) ──
  // Everything below acts on genuine Workspace ids, not project ids. A later
  // UI phase (the sidebar tree / splash / type-picker) is what will actually
  // call these; for now they exist and work, callable by hand or by a future
  // renderer change, without touching anything the current UI depends on.

  ipcMain.handle(IPC.wsTreeList, async () => manager.list().map((w) => w.summary()));

  ipcMain.handle(IPC.wsRename, async (_e, workspaceId: string, label: string) => {
    const workspace = manager.get(workspaceId);
    if (!workspace) return null;
    workspace.label = label;
    void persistWorkspaceIndex();
    return workspace.summary();
  });

  ipcMain.handle(IPC.wsSetMeta, async (_e, workspaceId: string, text: string) => {
    const workspace = manager.get(workspaceId);
    if (!workspace) return null;
    workspace.metaFile = text;
    void persistWorkspaceIndex();
    return workspace.summary();
  });

  ipcMain.handle(IPC.projectAdd, async (_e, workspaceId: string) => {
    const workspace = manager.get(workspaceId);
    if (!workspace || !win) return null;
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (result.canceled || result.filePaths.length === 0) return null;
    const project = await manager.addProject(workspaceId, result.filePaths[0]);
    if (!project) return null;
    workspace.setActiveProject(project.id);
    void persistWorkspaceIndex();
    return workspace.summary();
  });

  ipcMain.handle(IPC.projectList, async (_e, workspaceId: string) => {
    return manager.get(workspaceId)?.listProjects().map((p) => p.summary()) ?? [];
  });

  ipcMain.handle(IPC.projectRemove, async (_e, workspaceId: string, projectId: string) => {
    const workspace = manager.get(workspaceId);
    if (!workspace) return null;
    browserViewManager.forgetWorkspace(projectId);
    manager.removeProject(workspaceId, projectId);
    void persistWorkspaceIndex();
    return workspace.summary();
  });

  ipcMain.handle(IPC.projectSetActive, async (_e, workspaceId: string, projectId: string) => {
    const workspace = manager.get(workspaceId);
    if (!workspace) return false;
    const ok = workspace.setActiveProject(projectId);
    if (ok) void persistWorkspaceIndex();
    return ok;
  });

  ipcMain.handle(IPC.cmdApprovalDecide, async (_e, workspaceId: string, requestId: string, decision: ApprovalDecision) => {
    manager.findProject(workspaceId)?.resolveApproval(requestId, decision);
    return true;
  });

  ipcMain.handle(IPC.subagentCmdApprovalDecide, async (_e, workspaceId: string, requestId: string, approved: boolean) => {
    manager.findProject(workspaceId)?.resolveSubagentApproval(requestId, approved);
    return true;
  });

  ipcMain.handle(IPC.wsSetRoot, async (_e, workspaceId: string) => {
    const ws = manager.findProject(workspaceId);
    if (!ws || !win) return null;
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (result.canceled || result.filePaths.length === 0) return null;
    await ws.setRoot(result.filePaths[0]);
    send(IPC.wsUpdated, ws.summary());
    send(IPC.sessUpdated, workspaceId, ws.listSessions());
    void persistWorkspaceIndex();
    return ws.summary();
  });

  ipcMain.handle(IPC.sessList, async (_e, workspaceId: string) => {
    return manager.findProject(workspaceId)?.listSessions() ?? [];
  });

  ipcMain.handle(IPC.sessNew, async (_e, workspaceId: string) => {
    const ws = manager.findProject(workspaceId);
    if (!ws) return null;
    const created = ws.newSession();
    send(IPC.wsUpdated, ws.summary());
    send(IPC.sessUpdated, workspaceId, ws.listSessions());
    return created;
  });

  ipcMain.handle(IPC.sessSelect, async (_e, workspaceId: string, sessionId: string) => {
    const ws = manager.findProject(workspaceId);
    if (!ws || !ws.selectSession(sessionId)) return null;
    send(IPC.wsUpdated, ws.summary());
    return { chat: ws.chat, activity: ws.activity, summary: ws.summary(), roadmap: ws.roadmap };
  });

  ipcMain.handle(IPC.sessDelete, async (_e, workspaceId: string, sessionId: string) => {
    const ws = manager.findProject(workspaceId);
    if (!ws) return [];
    ws.deleteSession(sessionId);
    send(IPC.wsUpdated, ws.summary());
    send(IPC.sessUpdated, workspaceId, ws.listSessions());
    return ws.listSessions();
  });

  ipcMain.handle(IPC.wsHydrate, async (_e, workspaceId: string): Promise<ProjectHydration | null> => {
    const ws = manager.findProject(workspaceId);
    if (!ws) return null;
    return {
      summary: ws.summary(),
      sessions: ws.listSessions(),
      tree: ws.rootPath ? await fsService.listDir(ws.rootPath) : [],
      chat: ws.chat,
      activity: ws.activity,
      terminalLines: ws.terminalLines,
      pendingDiffs: ws.diffs.list(),
      checkpoints: ws.diffs.listCheckpoints(),
      roadmap: ws.roadmap,
      schedules: ws.listSchedules(),
      focusAgents: ws.listFocusAgents(),
      board: ws.readBoard(undefined, 200),
    };
  });

  ipcMain.handle(IPC.fsListDir, async (_e, workspaceId: string, dirPath: string) => {
    const ws = manager.findProject(workspaceId);
    if (!ws?.rootPath) return [];
    return fsService.listDirDetailed(ws.rootPath, dirPath);
  });

  ipcMain.handle(IPC.fsListTree, async (_e, workspaceId: string) => {
    const ws = manager.findProject(workspaceId);
    if (!ws?.rootPath) return [];
    return fsService.listDir(ws.rootPath);
  });

  ipcMain.handle(IPC.fsReadFile, async (_e, workspaceId: string, filePath: string) => {
    const ws = manager.findProject(workspaceId);
    if (!ws?.rootPath) return '';
    return fsService.readFileSafe(ws.rootPath, filePath);
  });

  ipcMain.handle(IPC.fsWriteFile, async (_e, workspaceId: string, filePath: string, content: string) => {
    const ws = manager.findProject(workspaceId);
    if (!ws?.rootPath) return false;
    await fsService.writeFile(ws.rootPath, filePath, content);
    return true;
  });

  ipcMain.handle(IPC.fsOpenInBrowser, async (_e, filePath: string) => {
    // openPath hands the file to whatever the OS has registered for its
    // extension — for .html/.htm that is the default browser, same as
    // double-clicking it in Explorer/Finder.
    const err = await shell.openPath(filePath);
    return err ? false : true;
  });

  ipcMain.handle(IPC.termRun, async (_e, workspaceId: string, command: string) => {
    const ws = manager.findProject(workspaceId);
    if (!ws) return { exitCode: 1, output: 'No such workspace' };
    return ws.runCommand(command);
  });

  ipcMain.handle(IPC.termKill, async (_e, workspaceId: string) => {
    manager.findProject(workspaceId)?.terminal.kill();
    return true;
  });

  ipcMain.handle(IPC.agentSend, async (_e, workspaceId: string, text: string, images?: ChatImage[]) => {
    const ws = manager.findProject(workspaceId);
    if (!ws) return false;
    await ws.sendToAgent(text, images);
    return true;
  });

  ipcMain.handle(IPC.agentStop, async (_e, workspaceId: string) => {
    manager.findProject(workspaceId)?.stopAgent();
    return true;
  });

  ipcMain.handle(
    IPC.diffDecide,
    async (
      _e,
      workspaceId: string,
      diffId: string,
      hunkIndex: number | 'all',
      decision: 'accepted' | 'rejected'
    ) => {
      const ws = manager.findProject(workspaceId);
      if (!ws?.rootPath) return null;
      const diff = await ws.diffs.decide(ws.rootPath, diffId, hunkIndex, decision);
      if (diff) {
        send(IPC.diffUpdated, workspaceId, diff);
        send(IPC.wsUpdated, ws.summary());
      }
      // Once the whole batch is decided (not just this one file), let the
      // agent know — otherwise it stays idle forever waiting on a review
      // that already happened.
      if (ws.diffs.list().length === 0) ws.resumeAfterReview();
      return diff ?? null;
    }
  );

  ipcMain.handle(IPC.roadmapDecide, async (_e, workspaceId: string, itemId: string, decision: 'approve' | 'reject') => {
    manager.findProject(workspaceId)?.decideRoadmapItem(itemId, decision);
    return true;
  });

  ipcMain.handle(
    IPC.roadmapEdit,
    async (_e, workspaceId: string, itemId: string, patch: { title?: string; summary?: string; detail?: string }) => {
      manager.findProject(workspaceId)?.editRoadmapItem(itemId, patch);
      return true;
    }
  );

  ipcMain.handle(IPC.roadmapPushBack, async (_e, workspaceId: string, itemId: string, newDetail: string) => {
    manager.findProject(workspaceId)?.pushBackRoadmapItem(itemId, newDetail);
    return true;
  });

  ipcMain.handle(IPC.roadmapSetStatus, async (_e, workspaceId: string, itemId: string, status: RoadmapItemStatus) => {
    manager.findProject(workspaceId)?.setRoadmapItemStatus(itemId, status);
    return true;
  });

  ipcMain.handle(
    IPC.browserSetBounds,
    async (_e, workspaceId: string, bounds: { x: number; y: number; width: number; height: number }) => {
      if (!win) return false;
      browserViewManager.attach(win, workspaceId, bounds);
      return true;
    }
  );

  ipcMain.handle(IPC.browserDetach, async () => {
    browserViewManager.detach();
    return true;
  });

  ipcMain.handle(IPC.browserNavigate, async (_e, _workspaceId: string, url: string) => {
    browserViewManager.navigate(url);
    return true;
  });

  ipcMain.handle(IPC.browserBack, async () => {
    browserViewManager.back();
    return true;
  });

  ipcMain.handle(IPC.browserForward, async () => {
    browserViewManager.forward();
    return true;
  });

  ipcMain.handle(IPC.browserReload, async () => {
    browserViewManager.reload();
    return true;
  });

  ipcMain.handle(IPC.browserSummarize, async (_e, workspaceId: string) => {
    const ws = manager.findProject(workspaceId);
    if (!ws) return false;
    const url = browserViewManager.getCurrentUrl();
    const extracted = await browserViewManager.extractPage();
    if (!extracted || !url) return false;
    await ws.summarizePage(extracted, url);
    return true;
  });

  ipcMain.handle(IPC.browserSaveClip, async (_e, workspaceId: string) => {
    const ws = manager.findProject(workspaceId);
    if (!ws) return { ok: false as const, error: 'Workspace not found.' };
    const url = browserViewManager.getCurrentUrl();
    const extracted = await browserViewManager.extractPage();
    if (!extracted || !url) return { ok: false as const, error: 'Could not read this page — try reloading it.' };
    return ws.saveClip(extracted, url);
  });

  ipcMain.handle(IPC.checkpointList, async (_e, workspaceId: string) => {
    return manager.findProject(workspaceId)?.diffs.listCheckpoints() ?? [];
  });

  ipcMain.handle(IPC.checkpointUndo, async (_e, workspaceId: string, filePath: string) => {
    const ws = manager.findProject(workspaceId);
    if (!ws?.rootPath) return false;
    const cp = ws.diffs.findLatestCheckpoint(filePath);
    if (!cp) return false;
    await fsService.writeFile(ws.rootPath, cp.path, cp.previousContent);
    ws.diffs.removeCheckpoint(cp);
    return true;
  });

  ipcMain.handle(IPC.voiceTranscribe, async (_e, buffer: ArrayBuffer, mimeType: string) => {
    return transcribe(buffer, mimeType);
  });

  ipcMain.handle(IPC.ttsSynthesize, async (_e, text: string, provider: TtsProvider, voice: string) => {
    const { audio, mimeType, error } = await synthesizeSpeech(text, provider, voice);
    return { audio: audio ? audio.toString('base64') : null, mimeType, error };
  });

  ipcMain.handle(IPC.ttsListVoices, async (_e, provider: TtsProvider) => {
    return listTtsVoices(provider);
  });

  ipcMain.handle(IPC.attachmentSave, async (_e, workspaceId: string, buffer: ArrayBuffer, mimeType: string) => {
    const ws = manager.findProject(workspaceId);
    return saveAttachment(ws?.rootPath ?? null, workspaceId, Buffer.from(buffer), mimeType);
  });

  ipcMain.handle(IPC.imageRead, async (_e, workspaceId: string, filePath: string) => {
    const ws = manager.findProject(workspaceId);
    return readImageAsDataUrl(filePath, [attachmentDirFor(ws?.rootPath ?? null, workspaceId), ws?.rootPath ?? null]);
  });

  ipcMain.handle(IPC.modelsList, async (_e, forceRefresh?: boolean) => {
    try {
      return { ok: true as const, models: await listCatalogModels(!!forceRefresh) };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Empty model, not a hardcoded slug, when nothing's configured yet — the
  // Model Selector renders that as "Select model" rather than silently
  // implying some particular vendor's model is already chosen.
  ipcMain.handle(IPC.modelsGetCurrent, async (): Promise<{ provider: ChatProvider; model: string }> => {
    const provider = activeProviderId();
    const model = process.env[MODEL_ENV_KEY[provider]] || '';
    return { provider, model };
  });

  ipcMain.handle(IPC.modelsSetCurrent, async (_e, modelId: string, provider: ChatProvider) => {
    const modelKey = MODEL_ENV_KEY[provider];
    process.env.PROVIDER = provider;
    process.env[modelKey] = modelId;
    setEnvValue(envFile, 'PROVIDER', provider);
    setEnvValue(envFile, modelKey, modelId);
    return true;
  });

  // Switches the active chat provider on its own, independent of picking a
  // model — each provider remembers its own last-picked model (its own
  // *_MODEL var), so switching back and forth restores it automatically.
  ipcMain.handle(IPC.providerSet, async (_e, provider: ChatProvider): Promise<{ provider: ChatProvider; model: string }> => {
    process.env.PROVIDER = provider;
    setEnvValue(envFile, 'PROVIDER', provider);
    const model = process.env[MODEL_ENV_KEY[provider]] || '';
    return { provider, model };
  });

  // settingsGet never returns a real credential value — only whether one is
  // configured — so a compromised renderer can't exfiltrate every provider
  // key in one silent IPC call. Non-secret fields (base URL, model, max tool
  // calls) aren't credentials and are still returned as-is.
  ipcMain.handle(IPC.settingsGet, async (): Promise<ProviderSettings> => {
    const out = {} as ProviderSettings;
    const secretKeys = new Set<string>(SECRET_SETTINGS_KEYS);
    for (const key of SETTINGS_KEYS) {
      const real = process.env[key] || '';
      out[key] = secretKeys.has(key) ? (real ? SECRET_SENTINEL : '') : real;
    }
    return out;
  });

  ipcMain.handle(IPC.settingsSet, async (_e, values: Partial<ProviderSettings>) => {
    const secretKeys = new Set<string>(SECRET_SETTINGS_KEYS);
    for (const key of SETTINGS_KEYS) {
      if (!(key in values)) continue;
      let value = (values[key] ?? '').trim();
      // The sentinel is only ever something settingsGet handed back for an
      // untouched field — never persist it as if it were a real new key.
      if (secretKeys.has(key) && value === SECRET_SENTINEL) continue;
      if (key === 'MAX_TOOL_CALLS' && value) {
        const n = Number.parseInt(value, 10);
        value = Number.isFinite(n) ? String(Math.min(Math.max(n, 1), MAX_TOOL_CALLS_LIMIT)) : '';
      }
      process.env[key] = value;
      setEnvValue(envFile, key, value);
    }
    return true;
  });

  // ── Permission overrides ──────────────────────────────────────────────

  ipcMain.handle(IPC.permsGet, async (): Promise<PermissionOverrides> => {
    return loadPermissionOverrides();
  });

  ipcMain.handle(IPC.permsSet, async (_e, overrides: Partial<PermissionOverrides>) => {
    const current = loadPermissionOverrides();
    const next: PermissionOverrides = {
      bash: overrides.bash !== undefined ? overrides.bash : current.bash,
      edit: overrides.edit !== undefined ? overrides.edit : current.edit,
      webfetch: overrides.webfetch !== undefined ? overrides.webfetch : current.webfetch,
    };
    savePermissionOverrides(next);
    return true;
  });

  ipcMain.handle(IPC.permsGetAllowlist, async (): Promise<string[]> => {
    return loadBashAllowlist();
  });

  ipcMain.handle(IPC.permsSetAllowlist, async (_e, patterns: string[]) => {
    saveBashAllowlist(Array.isArray(patterns) ? patterns.filter((p) => typeof p === 'string') : []);
    return true;
  });

  // ── Scheduler ─────────────────────────────────────────────────────────

  ipcMain.handle(IPC.schedList, async (_e, workspaceId: string) => {
    return manager.findProject(workspaceId)?.listSchedules() ?? [];
  });

  ipcMain.handle(
    IPC.schedCreate,
    async (_e, workspaceId: string, label: string, prompt: string, schedule: ScheduleSpec) => {
      return manager.findProject(workspaceId)?.createSchedule(label, prompt, schedule) ?? null;
    }
  );

  ipcMain.handle(
    IPC.schedUpdate,
    async (
      _e,
      workspaceId: string,
      id: string,
      patch: { label?: string; prompt?: string; schedule?: ScheduleSpec; enabled?: boolean }
    ) => {
      manager.findProject(workspaceId)?.updateSchedule(id, patch);
      return true;
    }
  );

  ipcMain.handle(IPC.schedDelete, async (_e, workspaceId: string, id: string) => {
    manager.findProject(workspaceId)?.deleteSchedule(id);
    return true;
  });

  ipcMain.handle(IPC.schedRunNow, async (_e, workspaceId: string, id: string) => {
    manager.findProject(workspaceId)?.runScheduleNow(id);
    return true;
  });

  // ── Focus agents & message board ─────────────────────────────────────────

  ipcMain.handle(IPC.focusList, async (_e, workspaceId: string) => {
    return manager.findProject(workspaceId)?.listFocusAgents() ?? [];
  });

  ipcMain.handle(IPC.focusStart, async (_e, workspaceId: string, task: string, label: string, budgetMinutes?: number) => {
    return manager.findProject(workspaceId)?.startFocusAgent(task, label, budgetMinutes) ?? null;
  });

  ipcMain.handle(IPC.focusStop, async (_e, workspaceId: string, id: string) => {
    manager.findProject(workspaceId)?.stopFocusAgent(id);
    return true;
  });

  ipcMain.handle(IPC.focusBoardList, async (_e, workspaceId: string) => {
    return manager.findProject(workspaceId)?.readBoard(undefined, 200) ?? [];
  });

  ipcMain.handle(IPC.focusQuestionAnswer, async (_e, workspaceId: string, requestId: string, answer: string) => {
    manager.findProject(workspaceId)?.answerFocusQuestion(requestId, answer);
    return true;
  });

  // ── Update ────────────────────────────────────────────────────────────
  // Every step below runs only in direct response to one of these three IPC
  // calls — nothing in electron/updater.ts checks, downloads, or installs on
  // its own. See its top comment for why.
  ipcMain.handle(IPC.updateCheck, async () => {
    void checkForUpdates();
    return true;
  });
  ipcMain.handle(IPC.updateDownload, async () => {
    void downloadUpdate();
    return true;
  });
  ipcMain.handle(IPC.updateInstall, async () => {
    installUpdate();
    return true;
  });

  // The renderer's Portal button reads this once on mount (tunnel may already
  // be 'ready' by the time the window loads) and then just listens for
  // IPC.portalStatus pushes for everything after.
  ipcMain.handle(IPC.portalGetStatus, async () => portalStatus);
  ipcMain.handle(IPC.portalEnable, async () => {
    enablePortal();
    return true;
  });
  ipcMain.handle(IPC.portalDisable, async () => {
    disablePortal();
    return true;
  });

  app.on('activate', () => {
    showMainWindow();
  });
});

app.on('window-all-closed', () => {
  // Only fires once the Orb overlay is gone too — i.e. a real quit.
  manager.disposeAll();
  if (process.platform !== 'darwin') app.quit();
});
