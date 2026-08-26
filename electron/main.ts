import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadEnv, setEnvValue } from './env';
import { transcribe } from './transcribe';
import { IPC, SETTINGS_KEYS, SECRET_SETTINGS_KEYS, SECRET_SENTINEL, MAX_TOOL_CALLS_LIMIT } from './ipc-channels';
import type {
  WorkspaceHydration,
  ChatImage,
  ProviderSettings,
  ChatProvider,
  RoadmapItemStatus,
  WorkspaceKind,
  PermissionOverrides,
  ApprovalDecision,
} from './ipc-channels';
import * as fsService from './fs-service';
import { WorkspaceManager } from './workspace-manager';
import { saveAttachment, attachmentDirFor, readImageAsDataUrl } from './attachment-store';
import { listCatalogModels } from './models-service';
import { initUpdater, checkForUpdates, downloadUpdate, installUpdate } from './updater';
import { BrowserViewManager } from './browser-view-manager';
import { loadPermissionOverrides, savePermissionOverrides, loadBashAllowlist, saveBashAllowlist } from './perm-store';

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

/**
 * The ruleset ships with the project. RULES_DIR stays available as an override
 * for pointing a workspace at a different ruleset, but the app must never
 * depend on a folder outside itself to know how to behave.
 */
const bundledRules = path.join(__dirname, '..', 'rules');
const overrideRules = process.env.RULES_DIR?.trim();
if (overrideRules && fs.existsSync(overrideRules)) {
  process.env.RULES_DIR = overrideRules;
} else {
  if (overrideRules) {
    console.warn(`[forge] RULES_DIR "${overrideRules}" not found; using bundled rules/`);
  }
  process.env.RULES_DIR = fs.existsSync(bundledRules) ? bundledRules : '';
}
console.log(`[forge] ruleset: ${process.env.RULES_DIR || '(none found)'}`);

// Seed the permission overrides cache so workspace.ts's resolvePermission
// never needs to do a synchronous file read on the hot path.
loadPermissionOverrides();

let win: BrowserWindow | null = null;

function send(channel: string, ...args: unknown[]) {
  win?.webContents.send(channel, ...args);
}

const manager = new WorkspaceManager({
  terminal: (workspaceId, evt) => send(IPC.termData, workspaceId, evt),
  activity: (workspaceId, sessionId, evt) => send(IPC.agentActivity, workspaceId, sessionId, evt),
  message: (workspaceId, sessionId, msg) => send(IPC.agentMessage, workspaceId, sessionId, msg),
  status: (workspaceId) => {
    const ws = manager.get(workspaceId);
    if (ws) send(IPC.wsUpdated, ws.summary());
  },
  diffProposed: (workspaceId, diff) => send(IPC.diffProposed, workspaceId, diff),
  diffUpdated: (workspaceId, diff) => send(IPC.diffUpdated, workspaceId, diff),
  sessions: (workspaceId) => {
    const ws = manager.get(workspaceId);
    if (ws) send(IPC.sessUpdated, workspaceId, ws.listSessions());
  },
  commandApproval: (workspaceId, sessionId, requestId, command, category) =>
    send(IPC.cmdApprovalRequest, workspaceId, { requestId, command, sessionId, category }),
  subagentCommandApproval: (workspaceId, req) => send(IPC.subagentCmdApprovalRequest, workspaceId, req),
  roadmapUpdated: (workspaceId, sessionId, items) => send(IPC.roadmapUpdated, workspaceId, sessionId, items),
});

const browserViewManager = new BrowserViewManager((workspaceId, state) => send(IPC.browserNavState, workspaceId, state));

function loadContent(w: BrowserWindow) {
  if (process.env.VITE_DEV_SERVER_URL) {
    w.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    w.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

function createWindow() {
  const w = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#000000',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#000000', symbolColor: '#a8a8a4', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
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

  w.on('closed', () => {
    if (win === w) win = null;
  });

  win = w;
  loadContent(w);
}

app.whenReady().then(() => {
  // Only what the app actually uses: the mic for voice input, and clipboard
  // writes for the "Copy" button on code blocks. Electron consults both the
  // async request handler and the sync check handler depending on the API and
  // platform, so both need to agree or a call silently rejects.
  const ALLOWED = new Set(['media', 'clipboard-write', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => ALLOWED.has(permission));

  // In dev, default to the project's own folder so there's something real on
  // screen immediately. Packaged, that folder is inside the read-only asar and
  // isn't a real project anyway — start with no root and let the user pick one.
  const first = manager.create(app.isPackaged ? null : path.join(__dirname, '..'));
  void first.restoreSessions();

  createWindow();
  initUpdater((status) => send(IPC.updateStatus, status));

  ipcMain.handle(IPC.wsList, async () => manager.list().map((w) => w.summary()));

  ipcMain.handle(IPC.wsCreate, async () => {
    const ws = manager.create(null);
    ws.newSession();
    return ws.summary();
  });

  ipcMain.handle(IPC.wsClose, async (_e, workspaceId: string) => {
    browserViewManager.forgetWorkspace(workspaceId);
    manager.close(workspaceId);
    return manager.list().map((w) => w.summary());
  });

  ipcMain.handle(IPC.wsMarkSeen, async (_e, workspaceId: string) => {
    const ws = manager.get(workspaceId);
    if (!ws) return null;
    ws.markSeen();
    return ws.summary();
  });

  ipcMain.handle(IPC.wsSetAutonomy, async (_e, workspaceId: string, level: 'manual' | 'balanced' | 'auto') => {
    const ws = manager.get(workspaceId);
    if (!ws) return null;
    ws.setAutonomy(level);
    return ws.summary();
  });

  ipcMain.handle(IPC.wsSetKind, async (_e, workspaceId: string, kind: WorkspaceKind) => {
    const ws = manager.get(workspaceId);
    if (!ws) return null;
    ws.setKind(kind);
    return ws.summary();
  });

  ipcMain.handle(IPC.wsSetClipsFolder, async (_e, workspaceId: string) => {
    const ws = manager.get(workspaceId);
    if (!ws || !win) return null;
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (result.canceled || result.filePaths.length === 0) return null;
    ws.setClipsFolder(result.filePaths[0]);
    return ws.summary();
  });

  ipcMain.handle(IPC.cmdApprovalDecide, async (_e, workspaceId: string, requestId: string, decision: ApprovalDecision) => {
    manager.get(workspaceId)?.resolveApproval(requestId, decision);
    return true;
  });

  ipcMain.handle(IPC.subagentCmdApprovalDecide, async (_e, workspaceId: string, requestId: string, approved: boolean) => {
    manager.get(workspaceId)?.resolveSubagentApproval(requestId, approved);
    return true;
  });

  ipcMain.handle(IPC.wsSetRoot, async (_e, workspaceId: string) => {
    const ws = manager.get(workspaceId);
    if (!ws || !win) return null;
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (result.canceled || result.filePaths.length === 0) return null;
    await ws.setRoot(result.filePaths[0]);
    send(IPC.wsUpdated, ws.summary());
    send(IPC.sessUpdated, workspaceId, ws.listSessions());
    return ws.summary();
  });

  ipcMain.handle(IPC.sessList, async (_e, workspaceId: string) => {
    return manager.get(workspaceId)?.listSessions() ?? [];
  });

  ipcMain.handle(IPC.sessNew, async (_e, workspaceId: string) => {
    const ws = manager.get(workspaceId);
    if (!ws) return null;
    const created = ws.newSession();
    send(IPC.wsUpdated, ws.summary());
    send(IPC.sessUpdated, workspaceId, ws.listSessions());
    return created;
  });

  ipcMain.handle(IPC.sessSelect, async (_e, workspaceId: string, sessionId: string) => {
    const ws = manager.get(workspaceId);
    if (!ws || !ws.selectSession(sessionId)) return null;
    send(IPC.wsUpdated, ws.summary());
    return { chat: ws.chat, activity: ws.activity, summary: ws.summary(), roadmap: ws.roadmap };
  });

  ipcMain.handle(IPC.sessDelete, async (_e, workspaceId: string, sessionId: string) => {
    const ws = manager.get(workspaceId);
    if (!ws) return [];
    ws.deleteSession(sessionId);
    send(IPC.wsUpdated, ws.summary());
    send(IPC.sessUpdated, workspaceId, ws.listSessions());
    return ws.listSessions();
  });

  ipcMain.handle(IPC.wsHydrate, async (_e, workspaceId: string): Promise<WorkspaceHydration | null> => {
    const ws = manager.get(workspaceId);
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
    };
  });

  ipcMain.handle(IPC.fsListDir, async (_e, workspaceId: string, dirPath: string) => {
    const ws = manager.get(workspaceId);
    if (!ws?.rootPath) return [];
    return fsService.listDirDetailed(ws.rootPath, dirPath);
  });

  ipcMain.handle(IPC.fsListTree, async (_e, workspaceId: string) => {
    const ws = manager.get(workspaceId);
    if (!ws?.rootPath) return [];
    return fsService.listDir(ws.rootPath);
  });

  ipcMain.handle(IPC.fsReadFile, async (_e, workspaceId: string, filePath: string) => {
    const ws = manager.get(workspaceId);
    if (!ws?.rootPath) return '';
    return fsService.readFileSafe(ws.rootPath, filePath);
  });

  ipcMain.handle(IPC.fsWriteFile, async (_e, workspaceId: string, filePath: string, content: string) => {
    const ws = manager.get(workspaceId);
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
    const ws = manager.get(workspaceId);
    if (!ws) return { exitCode: 1, output: 'No such workspace' };
    return ws.runCommand(command);
  });

  ipcMain.handle(IPC.termKill, async (_e, workspaceId: string) => {
    manager.get(workspaceId)?.terminal.kill();
    return true;
  });

  ipcMain.handle(IPC.agentSend, async (_e, workspaceId: string, text: string, images?: ChatImage[]) => {
    const ws = manager.get(workspaceId);
    if (!ws) return false;
    await ws.sendToAgent(text, images);
    return true;
  });

  ipcMain.handle(IPC.agentStop, async (_e, workspaceId: string) => {
    manager.get(workspaceId)?.stopAgent();
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
      const ws = manager.get(workspaceId);
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
    manager.get(workspaceId)?.decideRoadmapItem(itemId, decision);
    return true;
  });

  ipcMain.handle(
    IPC.roadmapEdit,
    async (_e, workspaceId: string, itemId: string, patch: { title?: string; summary?: string; detail?: string }) => {
      manager.get(workspaceId)?.editRoadmapItem(itemId, patch);
      return true;
    }
  );

  ipcMain.handle(IPC.roadmapPushBack, async (_e, workspaceId: string, itemId: string, newDetail: string) => {
    manager.get(workspaceId)?.pushBackRoadmapItem(itemId, newDetail);
    return true;
  });

  ipcMain.handle(IPC.roadmapSetStatus, async (_e, workspaceId: string, itemId: string, status: RoadmapItemStatus) => {
    manager.get(workspaceId)?.setRoadmapItemStatus(itemId, status);
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
    const ws = manager.get(workspaceId);
    if (!ws) return false;
    const url = browserViewManager.getCurrentUrl();
    const extracted = await browserViewManager.extractPage();
    if (!extracted || !url) return false;
    await ws.summarizePage(extracted, url);
    return true;
  });

  ipcMain.handle(IPC.browserSaveClip, async (_e, workspaceId: string) => {
    const ws = manager.get(workspaceId);
    if (!ws) return { ok: false as const, error: 'Workspace not found.' };
    const url = browserViewManager.getCurrentUrl();
    const extracted = await browserViewManager.extractPage();
    if (!extracted || !url) return { ok: false as const, error: 'Could not read this page — try reloading it.' };
    return ws.saveClip(extracted, url);
  });

  ipcMain.handle(IPC.checkpointList, async (_e, workspaceId: string) => {
    return manager.get(workspaceId)?.diffs.listCheckpoints() ?? [];
  });

  ipcMain.handle(IPC.checkpointUndo, async (_e, workspaceId: string, filePath: string) => {
    const ws = manager.get(workspaceId);
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

  ipcMain.handle(IPC.attachmentSave, async (_e, workspaceId: string, buffer: ArrayBuffer, mimeType: string) => {
    const ws = manager.get(workspaceId);
    return saveAttachment(ws?.rootPath ?? null, workspaceId, Buffer.from(buffer), mimeType);
  });

  ipcMain.handle(IPC.imageRead, async (_e, workspaceId: string, filePath: string) => {
    const ws = manager.get(workspaceId);
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
    const provider: ChatProvider = process.env.PROVIDER === 'fairrouter' ? 'fairrouter' : 'openrouter';
    const model = (provider === 'fairrouter' ? process.env.FAIRROUTER_MODEL : process.env.OPENROUTER_MODEL) || '';
    return { provider, model };
  });

  ipcMain.handle(IPC.modelsSetCurrent, async (_e, modelId: string, provider: ChatProvider) => {
    const modelKey = provider === 'fairrouter' ? 'FAIRROUTER_MODEL' : 'OPENROUTER_MODEL';
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
    const model = (provider === 'fairrouter' ? process.env.FAIRROUTER_MODEL : process.env.OPENROUTER_MODEL) || '';
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  manager.disposeAll();
  if (process.platform !== 'darwin') app.quit();
});
