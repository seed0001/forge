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
  ProjectSummary,
  SessionSummary,
  Autonomy,
  CommandApproval,
  SubagentCommandApproval,
  CatalogModel,
  ChatProvider,
  ReasoningLevel,
  UpdateStatus,
  PortalStatus,
  ProviderSettings,
  RoadmapItem,
  RoadmapItemStatus,
  WorkspaceKind,
  BrowserNavState,
  PermissionOverrides,
  PermissionCategory,
  PermissionLevel,
  ApprovalDecision,
  ScheduleSpec,
  ScheduledTask,
  FocusAgentSummary,
  FocusMessage,
} from '../../electron/ipc-channels';

/** A Focus agent's ask_and_wait call waiting on the Operator, keyed by requestId — mirrors pendingSubagentApprovals. */
export interface PendingFocusQuestion {
  requestId: string;
  from: string;
  question: string;
}

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

/** One run's worth of activity, grouped for the Activity panel. */
export interface ProcessTurn {
  id: string;
  startedAt: number;
  endedAt: number | null;
  /** While running: the latest meaningful step. When done: the run's summary line. */
  label: string;
  status: 'running' | 'done' | 'error' | 'stopped';
  events: ActivityEvent[];
}

const MAX_PROCESS_TURNS = 40;
const MAX_TURN_EVENTS = 160;
let processTurnSeq = 0;

/**
 * Fold one activity event into the grouped process log. A `summary` event
 * closes the open turn (and never gets added as a step); any other event
 * opens a new turn if there isn't one, then appends/updates within it.
 */
function foldIntoProcessLog(log: ProcessTurn[], evt: ActivityEvent): ProcessTurn[] {
  const out = log.slice();
  const cur = out[out.length - 1];
  const open = cur && cur.endedAt === null ? cur : null;

  if (evt.summary) {
    if (open) {
      out[out.length - 1] = {
        ...open,
        endedAt: Date.now(),
        label: evt.detail || open.label,
        status:
          evt.status === 'error'
            ? /stopped by you|stopped —/i.test(evt.detail)
              ? 'stopped'
              : 'error'
            : 'done',
      };
    }
    return out;
  }

  let turn = open;
  if (!turn) {
    processTurnSeq += 1;
    turn = {
      id: `pt-${Date.now()}-${processTurnSeq}`,
      startedAt: Date.now(),
      endedAt: null,
      label: 'Working…',
      status: 'running',
      events: [],
    };
    out.push(turn);
  }

  const idx = turn.events.findIndex((e) => e.id === evt.id);
  const events = (idx >= 0 ? turn.events.map((e, i) => (i === idx ? evt : e)) : [...turn.events, evt]).slice(
    -MAX_TURN_EVENTS
  );
  // Live heading: the most recent step that isn't a bare "Thinking…" tick.
  const meaningful = [...events].reverse().find((e) => !(e.kind === 'thinking' && /^Thinking(…|\.\.\.)?/.test(e.detail)));
  out[out.length - 1] = { ...turn, events, label: meaningful?.detail ?? 'Working…' };
  return out.slice(-MAX_PROCESS_TURNS);
}

/** Build a starting process log from a session's server-side activity trail (only the current/last run is available on switch). */
function seedProcessLog(activity: ActivityEvent[]): ProcessTurn[] {
  if (!activity.length) return [];
  processTurnSeq += 1;
  const summary = activity.find((e) => e.summary);
  const steps = activity.filter((e) => !e.summary);
  const active = !summary && steps.some((e) => e.status === 'active');
  return [
    {
      id: `pt-seed-${processTurnSeq}`,
      startedAt: Date.now(),
      endedAt: active ? null : Date.now(),
      label: summary?.detail ?? (active ? 'Working…' : 'Earlier activity'),
      status: active ? 'running' : summary?.status === 'error' ? 'error' : 'done',
      events: steps.slice(-MAX_TURN_EVENTS),
    },
  ];
}

/**
 * Renderer-side mirror of one workspace. The main process owns the real state;
 * this accumulates events for EVERY workspace, including ones the user isn't
 * currently looking at, so switching tabs is instant and nothing is missed.
 */
/** Which surface the centre column is showing. Chat is the primary one. */
export type CenterView = 'chat' | 'editor' | 'terminal' | 'roadmap' | 'scheduler' | 'browser' | 'audit';

/** Which list the sidebar is showing. Sessions is the primary one. */
export type SidebarView = 'sessions' | 'files';

export interface WorkspaceView {
  summary: ProjectSummary;
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
  roadmap: RoadmapItem[];
  reviewing: boolean;
  hydrated: boolean;
  /** A run_command call waiting on a yes/no at Manual autonomy, if any. */
  pendingApproval: CommandApproval | null;
  /** Subagent run_command calls waiting on a yes/no, keyed by requestId — unlike pendingApproval, NOT filtered by activeSessionId, since a subagent has no session tab of its own to be "on". */
  pendingSubagentApprovals: Record<string, SubagentCommandApproval>;
  /** When the current run began, used to gauge how deep the work has gone. */
  runStartedAt: number | null;
  /** Images attached in the composer, waiting to go out with the next message. */
  composerImages: PendingImage[];
  /** Text staged for the composer from elsewhere (e.g. "Discuss & chat" on a roadmap item) — ChatView folds it into the input once, then clears it. */
  composerDraft: string | null;
  /** Grouped, uncollapsed activity history for the Activity panel — one entry per run, newest last. Renderer-only, lives for the session's on-screen lifetime. */
  processLog: ProcessTurn[];
  /** The chat image currently open in the paint editor overlay, if any. */
  paintTarget: { src: string; name: string } | null;
  /** A Browsing workspace's live nav state — null for a coding workspace, or before any page has loaded. */
  browserNav: BrowserNavState | null;
  schedules: ScheduledTask[];
  focusAgents: FocusAgentSummary[];
  board: FocusMessage[];
  /** Focus agents' ask_and_wait calls waiting on the Operator, keyed by requestId — deliberately not session-scoped, same reasoning as pendingSubagentApprovals. */
  pendingFocusQuestions: Record<string, PendingFocusQuestion>;
  /**
   * Live activity trail for each Focus agent, keyed by focus-agent id (not
   * session id) — mirrors `activity` above but for Focus agents, which run on
   * their own dedicated background session and so never match
   * `summary.activeSessionId`. Without this, forge.agent.onActivity's
   * active-session filter would silently drop every Focus agent's tool-call
   * trail. Populated only from live broadcasts going forward — there is no
   * backfill of a Focus agent's history from before the workspace was
   * hydrated.
   */
  focusActivity: Record<string, ActivityEvent[]>;
}

interface ForgeState {
  workspaces: Record<string, WorkspaceView>;
  order: string[];
  activeId: string | null;

  /**
   * Model selection is global, not per-workspace — every workspace's agent
   * reads the same active provider/model. Mirrors electron/agent-service.ts.
   */
  currentModel: string;
  currentProvider: ChatProvider;
  models: CatalogModel[];
  modelsLoading: boolean;
  modelsError: string | null;
  /** True once a list fetch has completed (success or failure) — lets the picker tell "never loaded" from "loaded, empty". */
  modelsLoadedOnce: boolean;

  /** How hard the model reasons per turn — global, like the model choice. */
  reasoningLevel: ReasoningLevel;

  /** Manual-only, app-wide — see electron/updater.ts for why nothing here runs on its own. */
  updateStatus: UpdateStatus;

  /** The phone portal's Cloudflare quick-tunnel — see electron/main.ts's startPortalTunnel. */
  portalStatus: PortalStatus;

  /** Provider API keys, app-wide (one .env, not per-workspace). Loaded lazily when the Settings overlay first opens. */
  settingsOpen: boolean;
  providerSettings: ProviderSettings | null;
  settingsSaving: boolean;

  /** The "What's New" / changelog overlay. */
  changelogOpen: boolean;

  /** Permission category overrides and the bash allowlist, app-wide. Loaded lazily alongside providerSettings. */
  permOverrides: PermissionOverrides | null;
  bashAllowlist: string[];

  /** Whether a fresh assistant reply speaks itself automatically — a pure client-side preference, persisted to localStorage rather than the .env-backed settings. */
  ttsAutoSpeak: boolean;

  init: () => Promise<void>;
  newWorkspace: () => Promise<void>;
  closeWorkspace: (id: string) => Promise<void>;
  selectWorkspace: (id: string) => Promise<void>;
  pickFolder: (id: string) => Promise<void>;
  setAutonomy: (level: Autonomy) => Promise<void>;
  setWorkspaceKind: (kind: WorkspaceKind) => Promise<void>;
  decideApproval: (decision: ApprovalDecision) => Promise<void>;
  decideSubagentApproval: (requestId: string, approved: boolean) => Promise<void>;

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
  setModel: (modelId: string, provider: ChatProvider) => Promise<void>;
  selectProvider: (provider: ChatProvider) => Promise<void>;
  setReasoningLevel: (level: ReasoningLevel) => Promise<void>;

  checkForUpdates: () => Promise<void>;
  downloadUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;

  enablePortal: () => Promise<void>;
  disablePortal: () => Promise<void>;

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

  decideRoadmapItem: (itemId: string, decision: 'approve' | 'reject') => Promise<void>;
  editRoadmapItem: (itemId: string, patch: { title?: string; summary?: string; detail?: string }) => Promise<void>;
  pushBackRoadmapItem: (itemId: string, newDetail: string) => Promise<void>;
  setRoadmapItemStatus: (itemId: string, status: RoadmapItemStatus) => Promise<void>;
  /** "Discuss & chat" on a roadmap item — stage its context in the composer and switch to the chat view. */
  discussRoadmapItem: (item: RoadmapItem) => void;
  /** ChatView calls this once it has folded composerDraft into the input. */
  consumeComposerDraft: () => void;

  createSchedule: (label: string, prompt: string, schedule: ScheduleSpec) => Promise<void>;
  updateSchedule: (
    taskId: string,
    patch: { label?: string; prompt?: string; schedule?: ScheduleSpec; enabled?: boolean }
  ) => Promise<void>;
  deleteSchedule: (taskId: string) => Promise<void>;
  runScheduleNow: (taskId: string) => Promise<void>;

  startFocusAgent: (task: string, label: string, budgetMinutes?: number) => Promise<void>;
  stopFocusAgent: (focusId: string) => Promise<void>;
  answerFocusQuestion: (requestId: string, answer: string) => Promise<void>;

  openSettings: () => void;
  closeSettings: () => void;
  openChangelog: () => void;
  closeChangelog: () => void;
  saveSettings: (values: Partial<ProviderSettings>) => Promise<boolean>;
  setTtsAutoSpeak: (enabled: boolean) => void;

  setPermOverride: (category: PermissionCategory, level: PermissionLevel | null) => Promise<void>;
  addAllowlistPattern: (pattern: string) => Promise<void>;
  removeAllowlistPattern: (pattern: string) => Promise<void>;

  browserSetBounds: (bounds: { x: number; y: number; width: number; height: number }) => Promise<void>;
  browserDetach: () => Promise<void>;
  browserNavigate: (url: string) => Promise<void>;
  browserBack: () => Promise<void>;
  browserForward: () => Promise<void>;
  browserReload: () => Promise<void>;
  browserSummarize: () => Promise<void>;
  browserSaveClip: () => Promise<{ ok: true; path: string } | { ok: false; error: string }>;
  setClipsFolder: () => Promise<boolean>;
}

function emptyView(summary: ProjectSummary): WorkspaceView {
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
    roadmap: [],
    reviewing: false,
    hydrated: false,
    pendingApproval: null,
    pendingSubagentApprovals: {},
    runStartedAt: null,
    composerImages: [],
    composerDraft: null,
    processLog: [],
    paintTarget: null,
    browserNav: null,
    schedules: [],
    focusAgents: [],
    board: [],
    pendingFocusQuestions: {},
    focusActivity: {},
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
    currentProvider: 'openrouter',
    models: [],
    modelsLoading: false,
    modelsError: null,
    modelsLoadedOnce: false,
    reasoningLevel: 'flash',

    updateStatus: { state: 'idle' },
    portalStatus: { state: 'disabled' },

    settingsOpen: false,
    changelogOpen: false,
    providerSettings: null,
    settingsSaving: false,

    permOverrides: null,
    bashAllowlist: [],

    ttsAutoSpeak: (() => {
      try {
        return localStorage.getItem('forge-tts-auto-speak') === '1';
      } catch {
        return false;
      }
    })(),

    init: async () => {
      void forge.models
        .getCurrent()
        .then(({ provider, model }) => set({ currentModel: model, currentProvider: provider }));
      void forge.reasoning.getCurrent().then((level) => set({ reasoningLevel: level }));
      if (!subscribed) forge.updates.onStatus((status) => set({ updateStatus: status }));
      if (!subscribed) {
        forge.portal.onStatus((status) => set({ portalStatus: status }));
        // The tunnel may already be 'ready' by the time this window loads — the
        // push above only covers status changes from here on, so back-fill once.
        void forge.portal.getStatus().then((status) => set({ portalStatus: status }));
      }

      // getInitialActive reports which tab was focused before the app last
      // closed (see electron/workspace-index-store.ts) — only meaningful on
      // this very first load, when activeId isn't set yet; a later re-run of
      // init() already has a real activeId and this fallback is simply unused.
      const [list, initialActive] = await Promise.all([forge.workspaces.list(), forge.workspaces.getInitialActive()]);
      set((s) => {
        const workspaces: Record<string, WorkspaceView> = {};
        for (const summary of list) {
          // Keep whatever this workspace already has on screen; only refresh
          // the summary. Re-running init must never discard open editors.
          const existing = s.workspaces[summary.id];
          workspaces[summary.id] = existing ? { ...existing, summary } : emptyView(summary);
        }
        const fallback = (initialActive && workspaces[initialActive] ? initialActive : list[0]?.id) ?? null;
        return {
          workspaces,
          order: list.map((w) => w.id),
          activeId: s.activeId && workspaces[s.activeId] ? s.activeId : fallback,
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

      forge.agent.onActivity((workspaceId, sessionId, evt) => {
        patch(workspaceId, (v) => {
          let next = v;

          // Each session runs independently now — a background session's
          // activity is already being persisted server-side regardless;
          // the visible trail only ever reflects whichever session is on
          // screen right now, so a broadcast for any other session is
          // simply not applied here (switching to it later fetches its
          // real current state via sessions.select, same as today).
          if (sessionId === v.summary.activeSessionId) {
            // A summary event is the whole run's trail collapsed into one row —
            // replace everything rather than append, so a task with dozens of
            // tool calls ends as one line instead of a long stacked list.
            const activity = evt.summary
              ? [evt]
              : (() => {
                  const idx = v.activity.findIndex((a) => a.id === evt.id);
                  return idx >= 0 ? v.activity.map((a, i) => (i === idx ? evt : a)) : [...v.activity, evt];
                })();
            next = { ...next, activity, processLog: foldIntoProcessLog(next.processLog, evt) };
          }

          // A Focus agent runs on its own dedicated background session,
          // broadcast on this same channel but tagged with that session's id
          // rather than the workspace's activeSessionId — the check above
          // alone would otherwise silently drop it (which is exactly what
          // happened before this branch existed). Mirror the same
          // collapse-on-summary/append-otherwise logic into a separate log
          // keyed by focus-agent id so the Focus panel can show its live
          // trail no matter which session is on screen.
          const focusAgent = v.focusAgents.find((f) => f.sessionId === sessionId);
          if (focusAgent) {
            const existing = next.focusActivity[focusAgent.id] ?? [];
            const updated = evt.summary
              ? [evt]
              : (() => {
                  const idx = existing.findIndex((a) => a.id === evt.id);
                  return idx >= 0 ? existing.map((a, i) => (i === idx ? evt : a)) : [...existing, evt];
                })();
            next = { ...next, focusActivity: { ...next.focusActivity, [focusAgent.id]: updated } };
          }

          return next;
        });
      });

      forge.agent.onMessage((workspaceId, sessionId, msg) => {
        patch(workspaceId, (v) => (sessionId !== v.summary.activeSessionId ? v : { ...v, chat: [...v.chat, msg] }));
      });

      forge.agent.onApprovalRequest((workspaceId, req) => {
        patch(workspaceId, (v) => (req.sessionId !== v.summary.activeSessionId ? v : { ...v, pendingApproval: req }));
      });

      // Deliberately NOT filtered by activeSessionId — a subagent has no session
      // tab of its own to be "on", so this must stay visible regardless of which
      // session the Operator is currently viewing in this workspace.
      forge.agent.onSubagentApprovalRequest((workspaceId, req) => {
        patch(workspaceId, (v) => ({
          ...v,
          pendingSubagentApprovals: { ...v.pendingSubagentApprovals, [req.requestId]: req },
        }));
      });

      forge.sessions.onUpdated((workspaceId, sessions) => {
        patch(workspaceId, (v) => ({ ...v, sessions }));
      });

      forge.browser.onNavState((workspaceId, state) => {
        patch(workspaceId, (v) => ({ ...v, browserNav: state }));
      });

      forge.roadmap.onUpdated((workspaceId, sessionId, items) => {
        // A push for a session the user has since navigated away from must not
        // clobber whatever's currently on screen.
        const view = get().workspaces[workspaceId];
        if (view?.summary.activeSessionId !== sessionId) return;
        patch(workspaceId, (v) => ({ ...v, roadmap: items }));
      });

      forge.scheduler.onUpdated((workspaceId, tasks) => {
        patch(workspaceId, (v) => ({ ...v, schedules: tasks }));
      });

      forge.focus.onUpdated((workspaceId, agents) => {
        patch(workspaceId, (v) => ({ ...v, focusAgents: agents }));
      });

      forge.focus.board.onUpdated((workspaceId, messages) => {
        patch(workspaceId, (v) => ({ ...v, board: messages }));
      });

      // Not session-scoped — same reasoning as the subagent approval card:
      // a Focus agent has no session tab of its own to be "on".
      forge.focus.board.onQuestion((workspaceId, req) => {
        patch(workspaceId, (v) => ({
          ...v,
          pendingFocusQuestions: { ...v.pendingFocusQuestions, [req.requestId]: req },
        }));
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
          forge.fs.readFile(workspaceId, diff.path).then((content) => {
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
      void forge.workspaces.setActive(summary.id);
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
      void forge.workspaces.setActive(id);
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
        processLog: seedProcessLog(data.activity),
        terminalLines: data.terminalLines,
        pendingDiffs: Object.fromEntries(data.pendingDiffs.map((d) => [d.id, d])),
        checkpoints: data.checkpoints,
        roadmap: data.roadmap,
        schedules: data.schedules,
        focusAgents: data.focusAgents,
        board: data.board,
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
        roadmap: [],
      }));
    },

    setAutonomy: async (level) => {
      const id = get().activeId;
      if (!id) return;
      // Optimistic: the confirming wsUpdated broadcast lands a moment later.
      patch(id, (v) => ({ ...v, summary: { ...v.summary, autonomy: level } }));
      await forge.workspaces.setAutonomy(id, level);
    },

    setWorkspaceKind: async (kind) => {
      const id = get().activeId;
      if (!id) return;
      // Optimistic: leaving the chooser screen should feel instant.
      patch(id, (v) => ({ ...v, summary: { ...v.summary, kind }, center: kind === 'browsing' ? 'browser' : 'chat' }));
      await forge.workspaces.setKind(id, kind);
    },

    decideApproval: async (decision) => {
      const id = get().activeId;
      const view = activeView();
      const req = view?.pendingApproval;
      if (!id || !req) return;
      patch(id, (v) => ({ ...v, pendingApproval: null }));
      await forge.agent.decideApproval(id, req.requestId, decision);
    },

    decideSubagentApproval: async (requestId, approved) => {
      const id = get().activeId;
      if (!id) return;
      patch(id, (v) => {
        const next = { ...v.pendingSubagentApprovals };
        delete next[requestId];
        return { ...v, pendingSubagentApprovals: next };
      });
      await forge.agent.decideSubagentApproval(id, requestId, approved);
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
      // Refused (null) while the agent is still running the current session —
      // rebuilding it against a new, empty conversation would orphan the
      // in-flight turn's callbacks. Leave the UI exactly as it is.
      const created = await forge.sessions.create(id);
      if (!created) return;
      forgetComposerImages(id);
      // A new session starts empty; clear the visible thread immediately.
      patch(id, (v) => ({ ...v, chat: [], activity: [], roadmap: [], processLog: [], center: 'chat', composerImages: [] }));
    },

    selectSession: async (sessionId) => {
      const id = get().activeId;
      if (!id) return;
      // Same refusal as newSession — null while a turn is in flight.
      const result = await forge.sessions.select(id, sessionId);
      if (!result) return;
      forgetComposerImages(id);
      patch(id, (v) => ({
        ...v,
        summary: result.summary,
        chat: result.chat,
        activity: result.activity,
        roadmap: result.roadmap,
        processLog: seedProcessLog(result.activity),
        center: 'chat',
        composerImages: [],
      }));
    },

    deleteSession: async (sessionId) => {
      const id = get().activeId;
      if (!id) return;
      const wasActive = get().workspaces[id]?.summary.activeSessionId === sessionId;
      const list = await forge.sessions.remove(id, sessionId);
      // The delete is refused if this was the active session and the agent is
      // still running it — in that case sessionId still appears in the
      // returned list, so don't clear a thread that's actually still there.
      const stillExists = list.some((s) => s.id === sessionId);
      if (wasActive && !stillExists) {
        forgetComposerImages(id);
        patch(id, (v) => ({ ...v, chat: [], activity: [], roadmap: [], processLog: [], composerImages: [] }));
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
      const content = await forge.fs.readFile(id, filePath);
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

    setModel: async (modelId, provider) => {
      // Optimistic: takes effect for the very next agent turn in every workspace.
      set({ currentModel: modelId, currentProvider: provider });
      await forge.models.setCurrent(modelId, provider);
    },

    selectProvider: async (provider) => {
      // Clear the model immediately rather than leave the OTHER provider's
      // model name on screen under the new provider's name, even briefly.
      set({ currentProvider: provider, currentModel: '' });
      const result = await forge.models.setProvider(provider);
      set({ currentProvider: result.provider, currentModel: result.model });
    },

    setReasoningLevel: async (level) => {
      // Optimistic, like setModel — takes effect on the next agent turn everywhere.
      set({ reasoningLevel: level });
      const applied = await forge.reasoning.setCurrent(level);
      set({ reasoningLevel: applied });
    },

    checkForUpdates: async () => {
      await forge.updates.check();
    },

    downloadUpdate: async () => {
      await forge.updates.download();
    },

    installUpdate: async () => {
      await forge.updates.install();
    },

    enablePortal: async () => {
      await forge.portal.enable();
    },

    disablePortal: async () => {
      await forge.portal.disable();
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
      // Only this session's own subagent approvals are affected server-side
      // (another session's subagent keeps running), so only clear those.
      patch(id, (v) => {
        const stoppedSessionId = v.summary.activeSessionId;
        const nextSubagent = { ...v.pendingSubagentApprovals };
        for (const [reqId, req] of Object.entries(nextSubagent)) {
          if (req.parentSessionId === stoppedSessionId) delete nextSubagent[reqId];
        }
        return { ...v, pendingApproval: null, pendingSubagentApprovals: nextSubagent };
      });
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
      const content = await forge.fs.readFile(id, filePath);
      patch(id, (v) => ({
        ...v,
        checkpoints,
        openFiles: v.openFiles.map((f) => (f.path === filePath ? { ...f, content, isDirty: false } : f)),
      }));
    },

    decideRoadmapItem: async (itemId, decision) => {
      const id = get().activeId;
      if (!id) return;
      // No optimistic patch — the authoritative roadmap:updated broadcast
      // does the real update, same convention as decideHunk.
      await forge.roadmap.decide(id, itemId, decision);
    },

    editRoadmapItem: async (itemId, fields) => {
      const id = get().activeId;
      if (!id) return;
      await forge.roadmap.edit(id, itemId, fields);
    },

    pushBackRoadmapItem: async (itemId, newDetail) => {
      const id = get().activeId;
      if (!id) return;
      await forge.roadmap.pushBack(id, itemId, newDetail);
    },

    setRoadmapItemStatus: async (itemId, status) => {
      const id = get().activeId;
      if (!id) return;
      await forge.roadmap.setStatus(id, itemId, status);
    },

    discussRoadmapItem: (item) => {
      const id = get().activeId;
      if (!id) return;
      const draft =
        `Let's talk through this roadmap item — I may want to re-outline or expand it.\n\n` +
        `## ${item.title}\n` +
        (item.summary ? `_${item.summary}_\n\n` : '\n') +
        `${item.detail.trim()}\n\n---\n`;
      patch(id, (v) => ({ ...v, composerDraft: draft, center: 'chat' }));
    },

    consumeComposerDraft: () => {
      const id = get().activeId;
      if (!id) return;
      patch(id, (v) => ({ ...v, composerDraft: null }));
    },

    createSchedule: async (label, prompt, schedule) => {
      const id = get().activeId;
      if (!id) return;
      await forge.scheduler.create(id, label, prompt, schedule);
    },

    updateSchedule: async (taskId, patch) => {
      const id = get().activeId;
      if (!id) return;
      await forge.scheduler.update(id, taskId, patch);
    },

    deleteSchedule: async (taskId) => {
      const id = get().activeId;
      if (!id) return;
      await forge.scheduler.remove(id, taskId);
    },

    runScheduleNow: async (taskId) => {
      const id = get().activeId;
      if (!id) return;
      await forge.scheduler.runNow(id, taskId);
    },

    startFocusAgent: async (task, label, budgetMinutes) => {
      const id = get().activeId;
      if (!id) return;
      await forge.focus.start(id, task, label, budgetMinutes);
    },

    stopFocusAgent: async (focusId) => {
      const id = get().activeId;
      if (!id) return;
      await forge.focus.stop(id, focusId);
    },

    answerFocusQuestion: async (requestId, answer) => {
      const id = get().activeId;
      if (!id) return;
      patch(id, (v) => {
        const next = { ...v.pendingFocusQuestions };
        delete next[requestId];
        return { ...v, pendingFocusQuestions: next };
      });
      await forge.focus.board.answer(id, requestId, answer);
    },

    openSettings: () => {
      set({ settingsOpen: true });
      // Loaded fresh on every open rather than cached at init — the .env file
      // is also editable by hand, so a stale renderer copy could clobber it.
      void forge.settings.get().then((providerSettings) => set({ providerSettings }));
      void forge.perms.get().then((permOverrides) => set({ permOverrides }));
      void forge.perms.getAllowlist().then((bashAllowlist) => set({ bashAllowlist }));
    },

    closeSettings: () => set({ settingsOpen: false }),

    openChangelog: () => set({ changelogOpen: true }),
    closeChangelog: () => set({ changelogOpen: false }),

    setTtsAutoSpeak: (enabled) => {
      try {
        localStorage.setItem('forge-tts-auto-speak', enabled ? '1' : '0');
      } catch {
        // localStorage can throw in a locked-down environment — the toggle still works for this session.
      }
      set({ ttsAutoSpeak: enabled });
    },

    saveSettings: async (values) => {
      set({ settingsSaving: true });
      const ok = await forge.settings.set(values);
      set((s) => ({
        settingsSaving: false,
        providerSettings: s.providerSettings ? { ...s.providerSettings, ...values } : s.providerSettings,
      }));
      return ok;
    },

    setPermOverride: async (category, level) => {
      set((s) => ({
        permOverrides: s.permOverrides ? { ...s.permOverrides, [category]: level } : s.permOverrides,
      }));
      await forge.perms.set({ [category]: level });
    },

    addAllowlistPattern: async (pattern) => {
      const trimmed = pattern.trim();
      if (!trimmed) return;
      const next = [...new Set([...get().bashAllowlist, trimmed])];
      set({ bashAllowlist: next });
      await forge.perms.setAllowlist(next);
    },

    removeAllowlistPattern: async (pattern) => {
      const next = get().bashAllowlist.filter((p) => p !== pattern);
      set({ bashAllowlist: next });
      await forge.perms.setAllowlist(next);
    },

    browserSetBounds: async (bounds) => {
      const id = get().activeId;
      if (id) await forge.browser.setBounds(id, bounds);
    },

    browserDetach: async () => {
      await forge.browser.detach();
    },

    browserNavigate: async (url) => {
      const id = get().activeId;
      if (id) await forge.browser.navigate(id, url);
    },

    browserBack: async () => {
      const id = get().activeId;
      if (id) await forge.browser.back(id);
    },

    browserForward: async () => {
      const id = get().activeId;
      if (id) await forge.browser.forward(id);
    },

    browserReload: async () => {
      const id = get().activeId;
      if (id) await forge.browser.reload(id);
    },

    browserSummarize: async () => {
      const id = get().activeId;
      if (id) await forge.browser.summarize(id);
    },

    browserSaveClip: async () => {
      const id = get().activeId;
      if (!id) return { ok: false as const, error: 'No active workspace.' };
      return forge.browser.saveClip(id);
    },

    setClipsFolder: async () => {
      const id = get().activeId;
      if (!id) return false;
      const summary = await forge.workspaces.setClipsFolder(id);
      if (!summary) return false;
      patch(id, (v) => ({ ...v, summary }));
      return true;
    },
  };
});

/** Convenience hook: the currently visible workspace slice. */
export function useActiveWorkspace(): WorkspaceView | null {
  return useForge((s) => (s.activeId ? s.workspaces[s.activeId] ?? null : null));
}
