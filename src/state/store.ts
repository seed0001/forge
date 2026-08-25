import { create } from 'zustand';
import { forge } from '../lib/forge-api';
import type {
  FileNode,
  ActivityEvent,
  TermDataEvent,
  PendingDiff,
  Checkpoint,
  ChatMessage,
  ChatImage,
  WorkspaceSummary,
  SessionSummary,
  Autonomy,
  CommandApproval,
  OpenRouterModel,
} from '../../electron/ipc-channels';

export interface OpenFile {
  path: string;
  name: string;
  content: string;
  isDirty: boolean;
}

/** An image attached in the composer, not yet sent — already saved to disk, kept with its own blob URL for instant preview. */
export interface PendingImage {
  id: string;
  path: string;
  name: string;
  dataUrl: string;
}

/**
 * Renderer-side mirror of one workspace. The main process owns the real state;
 * this accumulates events for EVERY workspace, including ones the user isn't
 * currently looking at, so switching tabs is instant and nothing is missed.
 */
/** Which surface the centre column is showing. Chat is the primary one. */
export type CenterView = 'chat' | 'editor' | 'terminal';

/** Which list the sidebar is showing. Sessions is the primary one. */
export type SidebarView = 'sessions' | 'files';

export interface WorkspaceView {
  summary: WorkspaceSummary;
  center: CenterView;
  sidebar: SidebarView;
  sessions: SessionSummary[];
  tree: FileNode[];
  /** Bumped whenever a decided diff may have changed the tree, so Sidebar folders reload. */
  treeVersion: number;
  openFiles: OpenFile[];
  activeFilePath: string | null;
  terminalLines: (TermDataEvent & { id: string })[];
  chat: ChatMessage[];
  activity: ActivityEvent[];
  pendingDiffs: Record<string, PendingDiff>;
  checkpoints: Checkpoint[];
  reviewing: boolean;
  hydrated: boolean;
  /** A run_command call waiting on a yes/no at Manual autonomy, if any. */
  pendingApproval: CommandApproval | null;
  /** When the current run began, used to gauge how deep the work has gone. */
  runStartedAt: number | null;
  /** Images attached in the composer, waiting to go out with the next message. */
  composerImages: PendingImage[];
  /** The chat image currently open in the paint editor overlay, if any. */
  paintTarget: { src: string; name: string } | null;
}

interface ForgeState {
  workspaces: Record<string, WorkspaceView>;
  order: string[];
  activeId: string | null;

  /**
   * Model selection is global, not per-workspace — every workspace's agent
   * reads the same OPENROUTER_MODEL. Mirrors electron/agent-service.ts.
   */
  currentModel: string;
  models: OpenRouterModel[];
  modelsLoading: boolean;
  modelsError: string | null;
  /** True once a list fetch has completed (success or failure) — lets the picker tell "never loaded" from "loaded, empty". */
  modelsLoadedOnce: boolean;

  init: () => Promise<void>;
  newWorkspace: () => Promise<void>;
  closeWorkspace: (id: string) => Promise<void>;
  selectWorkspace: (id: string) => Promise<void>;
  pickFolder: (id: string) => Promise<void>;
  setAutonomy: (level: Autonomy) => Promise<void>;
  decideApproval: (approved: boolean) => Promise<void>;

  setCenter: (view: CenterView) => void;
  setSidebar: (view: SidebarView) => void;
  newSession: () => Promise<void>;
  selectSession: (sessionId: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  openFile: (path: string, name: string) => Promise<void>;
  closeFile: (path: string) => void;
  setActiveFile: (path: string) => void;
  updateActiveContent: (content: string) => void;
  saveActiveFile: () => Promise<void>;

  runCommand: (command: string) => Promise<void>;

  loadModels: (forceRefresh?: boolean) => Promise<void>;
  setModel: (modelId: string) => Promise<void>;

  sendChat: (text: string) => Promise<void>;
  stopAgent: () => Promise<void>;

  addComposerImage: (buffer: ArrayBuffer, mimeType: string, name: string) => Promise<void>;
  removeComposerImage: (id: string) => void;
  openPaintEditor: (src: string, name: string) => void;
  closePaintEditor: () => void;

  openReview: () => void;
  closeReview: () => void;
  decideHunk: (diffId: string, hunkIndex: number | 'all', decision: 'accepted' | 'rejected') => Promise<void>;
  undoPath: (path: string) => Promise<void>;
}

function emptyView(summary: WorkspaceSummary): WorkspaceView {
  return {
    summary,
    center: 'chat',
    sidebar: 'sessions',
    sessions: [],
    tree: [],
    treeVersion: 0,
    openFiles: [],
    activeFilePath: null,
    terminalLines: [],
    chat: [],
    activity: [],
    pendingDiffs: {},
    checkpoints: [],
    reviewing: false,
    hydrated: false,
    pendingApproval: null,
    runStartedAt: null,
    composerImages: [],
    paintTarget: null,
  };
}

let lineSeq = 0;
let imgSeq = 0;

/**
 * Main-process events are broadcast for the lifetime of the window, so they are
 * subscribed exactly once. Without this guard React's StrictMode double-invokes
 * the bootstrap effect in dev and every message, activity row and terminal line
 * arrives twice.
 */
let subscribed = false;

export const useForge = create<ForgeState>((set, get) => {
  /** Apply a change to one workspace slice without disturbing the others. */
  function patch(id: string, fn: (v: WorkspaceView) => WorkspaceView) {
    set((s) => {
      const view = s.workspaces[id];
      if (!view) return s;
      return { workspaces: { ...s.workspaces, [id]: fn(view) } };
    });
  }

  /** Revokes any pending composer attachments' blob URLs before they're dropped from state. */
  function forgetComposerImages(id: string) {
    get().workspaces[id]?.composerImages.forEach((p) => URL.revokeObjectURL(p.dataUrl));
  }

  function activeView(): WorkspaceView | null {
    const { activeId, workspaces } = get();
    return activeId ? workspaces[activeId] ?? null : null;
  }

  return {
    workspaces: {},
    order: [],
    activeId: null,

    currentModel: '',
    models: [],
    modelsLoading: false,
    modelsError: null,
    modelsLoadedOnce: false,

    init: async () => {
      void forge.models.getCurrent().then((modelId) => set({ currentModel: modelId }));

      const list = await forge.workspaces.list();
      set((s) => {
        const workspaces: Record<string, WorkspaceView> = {};
        for (const summary of list) {
          // Keep whatever this workspace already has on screen; only refresh
          // the summary. Re-running init must never discard open editors.
          const existing = s.workspaces[summary.id];
          workspaces[summary.id] = existing ? { ...existing, summary } : emptyView(summary);
        }
        return {
          workspaces,
          order: list.map((w) => w.id),
          activeId: s.activeId && workspaces[s.activeId] ? s.activeId : list[0]?.id ?? null,
        };
      });

      if (subscribed) {
        const current = get().activeId ?? list[0]?.id;
        if (current) await get().selectWorkspace(current);
        return;
      }
      subscribed = true;

      // Every subscription is keyed by workspace id, so background work lands in
      // the right slice whether or not that workspace is on screen.
      forge.workspaces.onUpdated((summary) => {
        patch(summary.id, (v) => {
          const wasRunning = v.summary.status === 'running';
          const nowRunning = summary.status === 'running';
          return {
            ...v,
            summary,
            runStartedAt: nowRunning ? (wasRunning ? v.runStartedAt : Date.now()) : null,
          };
        });
      });

      forge.terminal.onData((workspaceId, evt) => {
        lineSeq += 1;
        const line = { ...evt, id: `l-${lineSeq}` };
        patch(workspaceId, (v) => ({ ...v, terminalLines: [...v.terminalLines, line].slice(-800) }));
      });

      forge.agent.onActivity((workspaceId, evt) => {
        patch(workspaceId, (v) => {
          const idx = v.activity.findIndex((a) => a.id === evt.id);
          const activity = idx >= 0 ? v.activity.map((a, i) => (i === idx ? evt : a)) : [...v.activity, evt];
          return { ...v, activity };
        });
      });

      forge.agent.onMessage((workspaceId, msg) => {
        patch(workspaceId, (v) => ({ ...v, chat: [...v.chat, msg] }));
      });

      forge.agent.onApprovalRequest((workspaceId, req) => {
        patch(workspaceId, (v) => ({ ...v, pendingApproval: req }));
      });

      forge.sessions.onUpdated((workspaceId, sessions) => {
        patch(workspaceId, (v) => ({ ...v, sessions }));
      });

      forge.diff.onProposed((workspaceId, diff) => {
        patch(workspaceId, (v) => ({ ...v, pendingDiffs: { ...v.pendingDiffs, [diff.id]: diff } }));
      });

      forge.diff.onUpdated((workspaceId, diff) => {
        patch(workspaceId, (v) => {
          const next = { ...v.pendingDiffs };
          const settled = diff.hunks.every(
            (h) => diff.decisions[h.index] && diff.decisions[h.index] !== 'pending'
          );
          if (settled) delete next[diff.id];
          else next[diff.id] = diff;
          return { ...v, pendingDiffs: next };
        });
        // The agent may have rewritten a file that is open in a buffer.
        const view = get().workspaces[workspaceId];
        if (view?.openFiles.some((f) => f.path === diff.path)) {
          forge.fs.readFile(diff.path).then((content) => {
            patch(workspaceId, (v) => ({
              ...v,
              openFiles: v.openFiles.map((f) => (f.path === diff.path ? { ...f, content, isDirty: false } : f)),
            }));
          });
        }
        // A decided hunk may have written a new file, or a new folder to hold
        // it — the tree was only ever loaded once, on hydrate. Reload the root
        // listing and bump treeVersion so every expanded Sidebar folder (each
        // caches its own children locally) reloads itself too.
        forge.fs.listTree(workspaceId).then((tree) => {
          patch(workspaceId, (v) => ({ ...v, tree, treeVersion: v.treeVersion + 1 }));
        });
      });

      const first = get().activeId ?? list[0]?.id;
      if (first) await get().selectWorkspace(first);
    },

    newWorkspace: async () => {
      const summary = await forge.workspaces.create();
      set((s) => ({
        workspaces: { ...s.workspaces, [summary.id]: { ...emptyView(summary), hydrated: true } },
        order: [...s.order, summary.id],
        activeId: summary.id,
      }));
    },

    closeWorkspace: async (id) => {
      const list = await forge.workspaces.close(id);
      set((s) => {
        const workspaces = { ...s.workspaces };
        delete workspaces[id];
        const order = list.map((w) => w.id);
        const activeId = s.activeId === id ? order[order.length - 1] ?? null : s.activeId;
        return { workspaces, order, activeId };
      });
      const next = get().activeId;
      if (next) await get().selectWorkspace(next);
    },

    selectWorkspace: async (id) => {
      set({ activeId: id });
      const view = get().workspaces[id];
      if (!view) return;

      if (view.summary.unseenCompletion) {
        const summary = await forge.workspaces.markSeen(id);
        if (summary) patch(id, (v) => ({ ...v, summary }));
      }
      if (view.hydrated) return;

      const data = await forge.workspaces.hydrate(id);
      if (!data) return;
      patch(id, (v) => ({
        ...v,
        summary: data.summary,
        sessions: data.sessions,
        tree: data.tree,
        chat: data.chat,
        activity: data.activity,
        terminalLines: data.terminalLines,
        pendingDiffs: Object.fromEntries(data.pendingDiffs.map((d) => [d.id, d])),
        checkpoints: data.checkpoints,
        hydrated: true,
      }));
    },

    pickFolder: async (id) => {
      const summary = await forge.workspaces.setRoot(id);
      if (!summary) return;
      const [tree, sessions] = await Promise.all([forge.fs.listTree(id), forge.sessions.list(id)]);
      // A different folder means a different history, so the thread resets too.
      patch(id, (v) => ({
        ...v,
        summary,
        tree,
        sessions,
        openFiles: [],
        activeFilePath: null,
        chat: [],
        activity: [],
      }));
    },

    setAutonomy: async (level) => {
      const id = get().activeId;
      if (!id) return;
      // Optimistic: the confirming wsUpdated broadcast lands a moment later.
      patch(id, (v) => ({ ...v, summary: { ...v.summary, autonomy: level } }));
      await forge.workspaces.setAutonomy(id, level);
    },

    decideApproval: async (approved) => {
      const id = get().activeId;
      const view = activeView();
      const req = view?.pendingApproval;
      if (!id || !req) return;
      patch(id, (v) => ({ ...v, pendingApproval: null }));
      await forge.agent.decideApproval(id, req.requestId, approved);
    },

    setCenter: (viewName) => {
      const id = get().activeId;
      if (id) patch(id, (v) => ({ ...v, center: viewName }));
    },

    setSidebar: (viewName) => {
      const id = get().activeId;
      if (id) patch(id, (v) => ({ ...v, sidebar: viewName }));
    },

    newSession: async () => {
      const id = get().activeId;
      if (!id) return;
      await forge.sessions.create(id);
      forgetComposerImages(id);
      // A new session starts empty; clear the visible thread immediately.
      patch(id, (v) => ({ ...v, chat: [], activity: [], center: 'chat', composerImages: [] }));
    },

    selectSession: async (sessionId) => {
      const id = get().activeId;
      if (!id) return;
      const result = await forge.sessions.select(id, sessionId);
      if (!result) return;
      forgetComposerImages(id);
      patch(id, (v) => ({
        ...v,
        summary: result.summary,
        chat: result.chat,
        activity: result.activity,
        center: 'chat',
        composerImages: [],
      }));
    },

    deleteSession: async (sessionId) => {
      const id = get().activeId;
      if (!id) return;
      const wasActive = get().workspaces[id]?.summary.activeSessionId === sessionId;
      await forge.sessions.remove(id, sessionId);
      if (wasActive) {
        forgetComposerImages(id);
        patch(id, (v) => ({ ...v, chat: [], activity: [], composerImages: [] }));
      }
    },

    openFile: async (filePath, name) => {
      const id = get().activeId;
      if (!id) return;
      const view = get().workspaces[id];
      if (view?.openFiles.some((f) => f.path === filePath)) {
        patch(id, (v) => ({ ...v, activeFilePath: filePath, center: 'editor' }));
        return;
      }
      const content = await forge.fs.readFile(filePath);
      patch(id, (v) => ({
        ...v,
        openFiles: [...v.openFiles, { path: filePath, name, content, isDirty: false }],
        activeFilePath: filePath,
        center: 'editor',
      }));
    },

    closeFile: (filePath) => {
      const id = get().activeId;
      if (!id) return;
      patch(id, (v) => {
        const openFiles = v.openFiles.filter((f) => f.path !== filePath);
        const activeFilePath =
          v.activeFilePath === filePath ? openFiles[openFiles.length - 1]?.path ?? null : v.activeFilePath;
        return { ...v, openFiles, activeFilePath };
      });
    },

    setActiveFile: (filePath) => {
      const id = get().activeId;
      if (id) patch(id, (v) => ({ ...v, activeFilePath: filePath }));
    },

    updateActiveContent: (content) => {
      const id = get().activeId;
      if (!id) return;
      patch(id, (v) => ({
        ...v,
        openFiles: v.openFiles.map((f) => (f.path === v.activeFilePath ? { ...f, content, isDirty: true } : f)),
      }));
    },

    saveActiveFile: async () => {
      const id = get().activeId;
      const view = activeView();
      const file = view?.openFiles.find((f) => f.path === view.activeFilePath);
      if (!id || !file) return;
      await forge.fs.writeFile(id, file.path, file.content);
      patch(id, (v) => ({
        ...v,
        openFiles: v.openFiles.map((f) => (f.path === file.path ? { ...f, isDirty: false } : f)),
      }));
    },

    runCommand: async (command) => {
      const id = get().activeId;
      if (id) await forge.terminal.run(id, command);
    },

    loadModels: async (forceRefresh) => {
      // A plain re-open of the dropdown reuses whatever's already loaded — only
      // an explicit refresh (or the very first open) hits the network.
      if (!forceRefresh && get().modelsLoadedOnce) return;
      set({ modelsLoading: true, modelsError: null });
      const result = await forge.models.list(forceRefresh);
      if (result.ok) {
        set({ models: result.models, modelsLoading: false, modelsLoadedOnce: true });
      } else {
        set({ modelsError: result.error, modelsLoading: false, modelsLoadedOnce: true });
      }
    },

    setModel: async (modelId) => {
      // Optimistic: takes effect for the very next agent turn in every workspace.
      set({ currentModel: modelId });
      await forge.models.setCurrent(modelId);
    },

    sendChat: async (text) => {
      const id = get().activeId;
      if (!id) return;
      const pending = get().workspaces[id]?.composerImages ?? [];
      const images: ChatImage[] = pending.map((p) => ({ path: p.path, name: p.name }));
      pending.forEach((p) => URL.revokeObjectURL(p.dataUrl));
      patch(id, (v) => ({ ...v, activity: [], composerImages: [] }));
      await forge.agent.send(id, text, images.length ? images : undefined);
    },

    stopAgent: async () => {
      const id = get().activeId;
      if (!id) return;
      // The main process rejects any approval it's holding as part of stopping,
      // but that resolves a promise mid-tool-call — it never tells the renderer
      // to take the card down, so clear it here rather than leave it stranded.
      patch(id, (v) => ({ ...v, pendingApproval: null }));
      await forge.agent.stop(id);
    },

    addComposerImage: async (buffer, mimeType, name) => {
      const id = get().activeId;
      if (!id) return;
      const saved = await forge.attachments.save(id, buffer, mimeType);
      if (!saved) return;
      const dataUrl = URL.createObjectURL(new Blob([buffer], { type: mimeType }));
      imgSeq += 1;
      const image: PendingImage = { id: `img-${imgSeq}`, path: saved.path, name: name || saved.name, dataUrl };
      patch(id, (v) => ({ ...v, composerImages: [...v.composerImages, image] }));
    },

    removeComposerImage: (imageId) => {
      const id = get().activeId;
      if (!id) return;
      const view = get().workspaces[id];
      const image = view?.composerImages.find((p) => p.id === imageId);
      if (image) URL.revokeObjectURL(image.dataUrl);
      patch(id, (v) => ({ ...v, composerImages: v.composerImages.filter((p) => p.id !== imageId) }));
    },

    openPaintEditor: (src, name) => {
      const id = get().activeId;
      if (id) patch(id, (v) => ({ ...v, paintTarget: { src, name } }));
    },

    closePaintEditor: () => {
      const id = get().activeId;
      if (id) patch(id, (v) => ({ ...v, paintTarget: null }));
    },

    openReview: () => {
      const id = get().activeId;
      if (id) patch(id, (v) => ({ ...v, reviewing: true }));
    },

    closeReview: () => {
      const id = get().activeId;
      if (id) patch(id, (v) => ({ ...v, reviewing: false }));
    },

    decideHunk: async (diffId, hunkIndex, decision) => {
      const id = get().activeId;
      if (!id) return;
      await forge.diff.decide(id, diffId, hunkIndex, decision);
      const checkpoints = await forge.checkpoints.list(id);
      patch(id, (v) => ({ ...v, checkpoints }));
    },

    undoPath: async (filePath) => {
      const id = get().activeId;
      if (!id) return;
      await forge.checkpoints.undo(id, filePath);
      const checkpoints = await forge.checkpoints.list(id);
      const content = await forge.fs.readFile(filePath);
      patch(id, (v) => ({
        ...v,
        checkpoints,
        openFiles: v.openFiles.map((f) => (f.path === filePath ? { ...f, content, isDirty: false } : f)),
      }));
    },
  };
});

/** Convenience hook: the currently visible workspace slice. */
export function useActiveWorkspace(): WorkspaceView | null {
  return useForge((s) => (s.activeId ? s.workspaces[s.activeId] ?? null : null));
}
