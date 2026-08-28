export const IPC = {
  wsList: 'workspace:list',
  wsCreate: 'workspace:create',
  wsClose: 'workspace:close',
  wsSetRoot: 'workspace:set-root',
  wsHydrate: 'workspace:hydrate',
  wsMarkSeen: 'workspace:mark-seen',
  wsSetAutonomy: 'workspace:set-autonomy',
  wsUpdated: 'workspace:updated',

  // Real Workspace-level (the new top-level container) CRUD — not yet wired
  // into any UI control (the sidebar tree / splash / type picker are a later
  // phase), but fully implemented and callable over IPC. The channels above
  // (wsList/wsCreate/wsClose/wsSetRoot/wsHydrate/wsMarkSeen/wsSetAutonomy/
  // wsSetKind/wsSetClipsFolder/wsSetActive/wsGetInitialActive) keep their
  // existing renderer-facing meaning: one tab per Project, each Workspace
  // auto-created with exactly one Project under it for now.
  wsTreeList: 'workspace:tree-list',
  wsRename: 'workspace:rename',
  wsSetMeta: 'workspace:set-meta',
  projectAdd: 'project:add',
  projectList: 'project:list',
  projectRemove: 'project:remove',
  projectSetActive: 'project:set-active',

  sessList: 'session:list',
  sessNew: 'session:new',
  sessSelect: 'session:select',
  sessDelete: 'session:delete',
  sessUpdated: 'session:updated',

  fsListDir: 'fs:list-dir',
  fsListTree: 'fs:list-tree',
  fsReadFile: 'fs:read-file',
  fsWriteFile: 'fs:write-file',
  fsOpenInBrowser: 'fs:open-in-browser',

  termRun: 'terminal:run',
  termKill: 'terminal:kill',
  termData: 'terminal:data',

  agentSend: 'agent:send',
  agentStop: 'agent:stop',
  agentActivity: 'agent:activity',
  agentMessage: 'agent:message',

  diffProposed: 'diff:proposed',
  diffDecide: 'diff:decide',
  diffUpdated: 'diff:updated',

  roadmapUpdated: 'roadmap:updated',
  roadmapDecide: 'roadmap:decide',
  roadmapEdit: 'roadmap:edit',
  roadmapPushBack: 'roadmap:push-back',
  roadmapSetStatus: 'roadmap:set-status',

  wsSetKind: 'workspace:set-kind',
  wsSetClipsFolder: 'workspace:set-clips-folder',
  wsSetActive: 'workspace:set-active',
  wsGetInitialActive: 'workspace:get-initial-active',

  browserNavigate: 'browser:navigate',
  browserBack: 'browser:back',
  browserForward: 'browser:forward',
  browserReload: 'browser:reload',
  browserSetBounds: 'browser:set-bounds',
  browserSummarize: 'browser:summarize',
  browserSaveClip: 'browser:save-clip',
  browserDetach: 'browser:detach',
  browserNavState: 'browser:nav-state',

  checkpointUndo: 'checkpoint:undo',
  checkpointList: 'checkpoint:list',

  cmdApprovalRequest: 'command:approval-request',
  cmdApprovalDecide: 'command:approval-decide',

  subagentCmdApprovalRequest: 'subagent-command:approval-request',
  subagentCmdApprovalDecide: 'subagent-command:approval-decide',

  voiceTranscribe: 'voice:transcribe',

  ttsSynthesize: 'tts:synthesize',
  ttsListVoices: 'tts:list-voices',

  attachmentSave: 'attachment:save',
  imageRead: 'image:read',

  modelsList: 'models:list',
  modelsGetCurrent: 'models:get-current',
  modelsSetCurrent: 'models:set-current',
  providerSet: 'provider:set',
  reasoningGetCurrent: 'reasoning:get-current',
  reasoningSetCurrent: 'reasoning:set-current',

  auditRead: 'audit:read',

  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',
  updateStatus: 'update:status',

  portalGetStatus: 'portal:get-status',
  portalStatus: 'portal:status',
  portalEnable: 'portal:enable',
  portalDisable: 'portal:disable',

  settingsGet: 'settings:get',
  settingsSet: 'settings:set',

  permsGet: 'perms:get',
  permsSet: 'perms:set',
  permsGetAllowlist: 'perms:get-allowlist',
  permsSetAllowlist: 'perms:set-allowlist',

  schedList: 'scheduler:list',
  schedCreate: 'scheduler:create',
  schedUpdate: 'scheduler:update',
  schedDelete: 'scheduler:delete',
  schedRunNow: 'scheduler:run-now',
  schedUpdated: 'scheduler:updated',

  focusList: 'focus:list',
  focusStart: 'focus:start',
  focusStop: 'focus:stop',
  focusUpdated: 'focus:updated',
  focusBoardList: 'focus:board-list',
  focusBoardUpdated: 'focus:board-updated',
  focusQuestionRequest: 'focus:question-request',
  focusQuestionAnswer: 'focus:question-answer',
} as const;

export type ProjectStatus = 'idle' | 'running' | 'review';

/** null means "not chosen yet" — drives the Coding/Browsing chooser screen. */
export type WorkspaceKind = 'coding' | 'browsing';

/**
 * A Workspace's type — required at creation, not changeable after (a fine
 * simplification for now). Orthogonal to a Project's `kind` above: `kind`
 * still drives the existing Coding/Browsing chooser at the PROJECT level;
 * `type` is a broader label on the WORKSPACE (the new top-level container)
 * that a later UI phase will use to pick which sidebar/tools a workspace shows.
 */
export type WorkspaceType = 'coding' | 'research' | 'music' | 'movie';

export const WORKSPACE_TYPES: { id: WorkspaceType; label: string }[] = [
  { id: 'coding', label: 'Coding' },
  { id: 'research', label: 'Research' },
  { id: 'music', label: 'Music' },
  { id: 'movie', label: 'Movie' },
];

/** Live navigation state of a Browsing workspace's embedded browser. */
export interface BrowserNavState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
}

/**
 * How much the agent may do without stopping to ask first. Manual gates every
 * shell command behind an explicit approval; Balanced (the historical default)
 * runs commands freely but still routes every file edit through the reviewable
 * diff queue; Auto additionally writes edits straight to disk (still logged to
 * AUDIT.md and still undoable via a checkpoint — just not held for review).
 */
export type Autonomy = 'manual' | 'balanced' | 'auto';

/** Which permission categories the agent's actions fall into. */
export type PermissionCategory = 'bash' | 'edit' | 'webfetch';

/**
 * How a category is resolved for the current turn:
 * - 'allow': the action proceeds without extra prompting (subject to other autonomy rules).
 * - 'ask': the action is held for the Operator's explicit approval.
 * - 'deny': the action is rejected with an error.
 */
export type PermissionLevel = 'allow' | 'ask' | 'deny';

/**
 * Permission overrides stored in forge-perms.json. A null value means "inherit
 * from the autonomy level's default mapping" — see workspace.ts's
 * resolvePermission for the exact fallback table.
 */
export type PermissionOverrides = Record<PermissionCategory, PermissionLevel | null>;

export const DEFAULT_PERMISSION_OVERRIDES: PermissionOverrides = {
  bash: null,
  edit: null,
  webfetch: null,
};

/**
 * A Project — one folder/rootPath, owning its own sessions/terminal/diffs/
 * context knowledge-base/scheduler/focus-agents. This is what the renderer
 * has always called a "workspace" (one tab in the TabStrip); the name
 * changed when a new, higher-level Workspace (see WorkspaceSummary below)
 * was inserted above it, but the shape and behavior here are unchanged.
 */
/**
 * A spending cap for a project, set conversationally ("we've got $5 for
 * this") and enforced by the agent: once `spentUsd` reaches `limitUsd` it
 * stops taking actions and only chats, until the Operator authorizes an
 * overage (`overridden`) or sets a new amount. Persisted with the project's
 * sessions. `limitUsd: null` means no cap.
 */
export interface ProjectBudget {
  limitUsd: number | null;
  spentUsd: number;
  overridden: boolean;
}

export interface ProjectSummary {
  id: string;
  name: string;
  rootPath: string | null;
  status: ProjectStatus;
  pendingDiffCount: number;
  /** True when the agent finished while the user was on another project. */
  unseenCompletion: boolean;
  activeSessionId: string | null;
  autonomy: Autonomy;
  /** The project's spending cap and running spend against it. */
  budget: ProjectBudget;
  /** Every session in this project whose agent is currently working — each session runs independently, so more than one can be live at once. */
  runningSessionIds: string[];
  /** null until the Operator picks Coding or Browsing from the chooser screen. */
  kind: WorkspaceKind | null;
  /** Where a Browsing project saves markdown clips — separate from rootPath, set the first time "Save as Markdown" is used, never touches sessions/chat. */
  clipsFolder: string | null;
}

/**
 * A Workspace — the new top-level container above Project: a renameable,
 * typed group of Projects (plus a workspace-wide meta text and knowledge
 * base — see electron/workspace.ts). The renderer's TabStrip today still
 * shows one tab per Project (see ProjectSummary) rather than per Workspace;
 * this shape backs the newer workspace-level IPC surface (electron/
 * workspace-manager.ts's WorkspaceManager) that a later UI phase will
 * surface as a real sidebar tree.
 */
export interface WorkspaceSummary {
  id: string;
  label: string;
  type: WorkspaceType;
  /** Free-text workspace-wide notes, injected into every project's agent turns — see electron/workspace.ts. */
  metaFile: string;
  activeProjectId: string | null;
  projects: ProjectSummary[];
}

/**
 * A bash or webfetch-category action waiting on the Operator's yes/no/always
 * because its category resolved to 'ask' (see project.ts's resolvePermission).
 * `command` doubles as a plain description for a non-shell action (e.g. a
 * web_search query) when category is 'webfetch' — the renderer titles the
 * card differently per category, but the shape is the same either way.
 */
export interface CommandApproval {
  requestId: string;
  command: string;
  category: PermissionCategory;
  /** Which session raised it — a background session's approval card should only surface while that session is the one being viewed. */
  sessionId: string;
}

/** What the Operator can choose on a CommandApproval card. 'always' also allows the rest of that category for the remainder of the session — see workspace.ts's SessionRuntime.alwaysAllowed. */
export type ApprovalDecision = 'approved' | 'denied' | 'always';

/**
 * A run_command call from a SUBAGENT waiting on the Operator, structurally
 * distinct from CommandApproval so the two can never be confused in the
 * renderer: a subagent has no sessionId of its own (it isn't a session), and
 * this approval must stay visible regardless of which session tab is open,
 * unlike CommandApproval which is scoped to one. See electron/workspace.ts's
 * requestSubagentApproval — it fails closed (denied) if never answered.
 */
export interface SubagentCommandApproval {
  requestId: string;
  command: string;
  /** Short description of the delegated task, so the Operator has context for what's asking. */
  label: string;
  /** The primary session that spawned this subagent — used only to route cleanup on stop, not for display scoping. */
  parentSessionId: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  preview: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  contextUsed?: number;
  contextWindow?: number;
  /** Total real dollar cost of every completion this session has caused (main thread, subagents, title, compaction). */
  costUsd?: number;
  /** Total wall-clock milliseconds the agent has spent actively running on this session. */
  elapsedMs?: number;
  /** How many times this session's conversation has been auto-compacted to free up context. */
  compactionCount?: number;
  /** Epoch ms this session's current run started, or null/absent when idle — lets the sidebar tick elapsed time live. */
  runningSince?: number | null;
}

/** An image attached to a chat message — either a user paste/drop or something the agent generated. */
export interface ChatImage {
  /** Absolute path on disk — either under the attachment store or (for generated images) the project root. */
  path: string;
  name: string;
}

/** An audio clip the agent generated (generate_music) — always a project-root path, never a user upload. */
export interface ChatAudio {
  path: string;
  name: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  images?: ChatImage[];
  audio?: ChatAudio[];
  /**
   * Set on an interim "here's what I'm about to do" note flushed alongside a
   * batch of tool calls, as opposed to the turn's real final reply — lets the
   * UI show it as a lighter, transient-looking status rather than a normal
   * closing message.
   */
  note?: boolean;
}

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: FileNode[];
}

export interface TermDataEvent {
  requestId: string;
  source: 'you' | 'agent';
  kind: 'cmd' | 'stdout' | 'stderr' | 'exit' | 'info';
  text: string;
}

export interface ActivityEvent {
  id: string;
  kind: 'read' | 'list' | 'run' | 'propose' | 'search' | 'generate' | 'analyze' | 'thinking' | 'done' | 'stopped' | 'compact' | 'roadmap';
  detail: string;
  /**
   * 'skipped' is a benign non-result — a file that simply does not exist.
   * It is deliberately distinct from 'error', which means something actually
   * went wrong, so a normal look-around never reads as a failure.
   */
  status: 'active' | 'done' | 'skipped' | 'error';
  /** Optional diff stats, shown inline on edit rows. */
  added?: number;
  removed?: number;
  /**
   * Marks a run's one consolidated closing row (kind 'done', built by
   * flushMessage from the whole run's tally). The renderer replaces the
   * entire in-progress trail with just this event rather than appending it,
   * so a task with dozens of tool calls collapses to one line instead of
   * leaving every individual row stacked in the transcript.
   */
  summary?: true;
}

export interface Hunk {
  index: number;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export type HunkDecision = 'pending' | 'accepted' | 'rejected';

export interface PendingDiff {
  id: string;
  path: string;
  baseContent: string;
  hunks: Hunk[];
  decisions: Record<number, HunkDecision>;
  added: number;
  removed: number;
}

export interface Checkpoint {
  path: string;
  previousContent: string;
  timestamp: number;
}

/**
 * A project roadmap is an ordered checklist of milestones, each with its own
 * markdown "detail doc" describing the plan. The agent proposes one via the
 * propose_roadmap tool (electron/agent-service.ts); the Operator reviews,
 * edits, and approves/rejects each item, and the agent works through
 * approved items in order, one at a time, pausing whenever the next item
 * isn't yet approved.
 */
export type RoadmapItemStatus = 'pending' | 'approved' | 'in_progress' | 'done' | 'needs_revision' | 'rejected';

export interface RoadmapItem {
  id: string;
  order: number;
  title: string;
  /** One-line summary shown in the checklist row. */
  summary: string;
  /** Full markdown plan — the Operator-editable "detail doc". */
  detail: string;
  status: RoadmapItemStatus;
  /** Agent-written completion report, or a reason the item needs review. */
  notes?: string;
}

/** Which chat-completion backend a model/request belongs to. */
export type ChatProvider = 'openrouter' | 'fairrouter' | 'ollama' | 'llamacpp';

/**
 * Chat providers available in the provider/model pickers, in display order.
 * To add another, extend this list, the ChatProvider union above, the
 * per-provider maps just below, and models-service.ts's per-provider fetcher.
 */
export const CHAT_PROVIDERS: { id: ChatProvider; label: string }[] = [
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'fairrouter', label: 'FairRouter' },
  { id: 'ollama', label: 'Ollama' },
  { id: 'llamacpp', label: 'llama.cpp' },
];

/** Local runtimes on the machine's own hardware — no API key required, no per-token cost. */
export const LOCAL_CHAT_PROVIDERS = new Set<ChatProvider>(['ollama', 'llamacpp']);

/** Per-provider env var holding which model is currently selected for it — each provider remembers its own last pick independently. */
export const MODEL_ENV_KEY: Record<ChatProvider, string> = {
  openrouter: 'OPENROUTER_MODEL',
  fairrouter: 'FAIRROUTER_MODEL',
  ollama: 'OLLAMA_MODEL',
  llamacpp: 'LLAMACPP_MODEL',
};

/**
 * How hard the model should think before each reply. Sent to the provider as
 * the unified `reasoning` field (OpenRouter/FairRouter normalize it per
 * model — an `effort` for OpenAI-style models, a proportional token budget
 * for the rest). Local runtimes ignore it. Global, like the model choice.
 */
export type ReasoningLevel = 'flash' | 'thinking' | 'deep';

/** Env var holding the current reasoning level (persisted in forge/.env alongside PROVIDER and the *_MODEL vars). */
export const REASONING_ENV_KEY = 'REASONING_LEVEL';

export const DEFAULT_REASONING_LEVEL: ReasoningLevel = 'flash';

/** Level -> the `reasoning.effort` value sent on the wire. */
export const REASONING_EFFORT: Record<ReasoningLevel, 'low' | 'medium' | 'high'> = {
  flash: 'low',
  thinking: 'medium',
  deep: 'high',
};

export const REASONING_LEVELS: { id: ReasoningLevel; label: string; blurb: string }[] = [
  { id: 'flash', label: 'Flash', blurb: 'A quick think before replying — lowest latency and cost. (Default)' },
  { id: 'thinking', label: 'Thinking', blurb: 'A moderate reasoning budget — a balance of speed and depth.' },
  { id: 'deep', label: 'Deep Thinking', blurb: 'A large reasoning budget for hard problems — slower and more expensive.' },
];

/** Which text-to-speech backend a voice-output request goes through. */
export type TtsProvider = 'edge' | 'sapi' | 'xtts';

export const TTS_PROVIDERS: { id: TtsProvider; label: string }[] = [
  { id: 'edge', label: 'Edge TTS' },
  { id: 'sapi', label: 'Windows SAPI' },
  { id: 'xtts', label: 'XTTS (Coqui)' },
];

/** One selectable voice from a TTS provider's catalog. */
export interface TtsVoice {
  id: string;
  label: string;
}

/** Every OpenAI-compatible endpoint's model listing lives at {baseUrl}/models, {baseUrl}/chat/completions. */
export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434/v1';
export const DEFAULT_LLAMACPP_BASE_URL = 'http://localhost:8080/v1';

/** One entry from a provider's model catalog (OpenRouter or FairRouter — both OpenAI-shaped). */
export interface CatalogModel {
  id: string;
  name: string;
  description?: string;
  contextLength: number;
  /** USD per token (not per million) — straight from the provider's pricing block, when it reports one. */
  promptPrice: number;
  completionPrice: number;
  /** Both prompt and completion pricing are zero — the provider's own definition of a free model. */
  isFree: boolean;
  provider: ChatProvider;
}

/** One parsed line of AUDIT.md, for the in-app Audit view. `kind` is one of audit-service.ts's AuditKind values (kept loose here so the renderer needn't import that node-only module). */
export interface AuditEntry {
  ts: string;
  kind: string;
  detail: string;
  outcome: string | null;
}

/** What audit:read returns — `present:false` when the workspace has no AUDIT.md yet. */
export type AuditReadResult =
  | { present: false }
  | { present: true; path: string; entries: AuditEntry[] };

/**
 * State of a manual update check. Nothing here happens without the Operator
 * clicking a button: 'checking' only follows an explicit check, 'downloading'
 * only follows an explicit download click, and installing is a separate
 * click again once 'downloaded'. See electron/updater.ts for why this is
 * manual-only rather than automatic.
 */
export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'not-available' }
  | { state: 'available'; version: string }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string };

/**
 * The phone portal's Cloudflare quick-tunnel — 'starting' from app launch
 * until cloudflared prints its assigned https://*.trycloudflare.com URL (a
 * few seconds), 'ready' with that URL once it does, or 'unavailable' if
 * cloudflared isn't installed/couldn't start (the portal server itself still
 * runs locally, just isn't reachable from outside the network without it).
 */
/**
 * 'disabled' is the default and only ever changes in direct response to the
 * Operator clicking "Enable"/"Disable" in Settings — nothing here starts a
 * server or a public tunnel on its own just because the app launched.
 */
export type PortalStatus =
  | { state: 'disabled' }
  | { state: 'starting' }
  | { state: 'ready'; url: string }
  | { state: 'unavailable'; reason: string };

/**
 * Every credential the Settings page can read and write, keyed by the exact
 * .env variable name — see setEnvValue in electron/env.ts, which is what
 * actually persists a change. Empty string means "not configured" rather
 * than absent, so the renderer never has to distinguish undefined from "".
 */
export interface ProviderSettings {
  OPENROUTER_API_KEY: string;
  FAIRROUTER_API_KEY: string;
  OLLAMA_BASE_URL: string;
  OLLAMA_API_KEY: string;
  LLAMACPP_BASE_URL: string;
  LLAMACPP_API_KEY: string;
  SEARCH_API: string;
  TRANSCRIBE_API_KEY: string;
  TRANSCRIBE_BASE_URL: string;
  TRANSCRIBE_MODEL: string;
  TTS_PROVIDER: string;
  TTS_EDGE_VOICE: string;
  TTS_SAPI_VOICE: string;
  TTS_XTTS_SERVER_URL: string;
  TTS_XTTS_VOICE: string;
  MAX_TOOL_CALLS: string;
  /** Blank means no limit. A soft warning fires once a task's own spend crosses this; a hard stop fires past 2x it. */
  MAX_COST_PER_TASK_USD: string;
}

export const SETTINGS_KEYS = [
  'OPENROUTER_API_KEY',
  'FAIRROUTER_API_KEY',
  'OLLAMA_BASE_URL',
  'OLLAMA_API_KEY',
  'LLAMACPP_BASE_URL',
  'LLAMACPP_API_KEY',
  'SEARCH_API',
  'TRANSCRIBE_API_KEY',
  'TRANSCRIBE_BASE_URL',
  'TRANSCRIBE_MODEL',
  'TTS_PROVIDER',
  'TTS_EDGE_VOICE',
  'TTS_SAPI_VOICE',
  'TTS_XTTS_SERVER_URL',
  'TTS_XTTS_VOICE',
  'MAX_TOOL_CALLS',
  'MAX_COST_PER_TASK_USD',
] as const satisfies readonly (keyof ProviderSettings)[];

/**
 * The subset of SETTINGS_KEYS that are actual credentials, as opposed to
 * plain config (TRANSCRIBE_BASE_URL/MODEL, MAX_TOOL_CALLS). settingsGet masks
 * these instead of returning them verbatim, terminal-session.ts scrubs them
 * out of spawned shell environments, and audit-service.ts redacts their live
 * values out of anything written to AUDIT.md — all three read from this one
 * list so a newly added credential key only needs to be added here once.
 */
export const SECRET_SETTINGS_KEYS = [
  'OPENROUTER_API_KEY',
  'FAIRROUTER_API_KEY',
  'OLLAMA_API_KEY',
  'LLAMACPP_API_KEY',
  'SEARCH_API',
  'TRANSCRIBE_API_KEY',
] as const satisfies readonly (keyof ProviderSettings)[];

/**
 * What settingsGet returns for a SECRET_SETTINGS_KEYS field that is
 * configured, instead of its real value — shared between main.ts (which
 * emits it) and the Settings UI (which recognizes it to render "configured,
 * retype to change" rather than showing the literal sentinel as if typed).
 */
export const SECRET_SENTINEL = '••••••••';

/** Bounds enforced wherever MAX_TOOL_CALLS is read or written. */
export const MAX_TOOL_CALLS_DEFAULT = 24;
export const MAX_TOOL_CALLS_LIMIT = 1000;

/** Everything the renderer needs to display a project (tab) it has switched to. */
export interface ProjectHydration {
  summary: ProjectSummary;
  sessions: SessionSummary[];
  tree: FileNode[];
  chat: ChatMessage[];
  activity: ActivityEvent[];
  terminalLines: (TermDataEvent & { id: string })[];
  pendingDiffs: PendingDiff[];
  checkpoints: Checkpoint[];
  roadmap: RoadmapItem[];
  schedules: ScheduledTask[];
  focusAgents: FocusAgentSummary[];
  board: FocusMessage[];
}

/**
 * A scheduled task fires a fixed prompt into its own dedicated background
 * session on a cron or interval schedule — see electron/scheduler-store.ts
 * for the cron matcher and next-run computation, and workspace.ts's
 * tickScheduler for what actually fires it.
 */
export type ScheduleSpec = { kind: 'cron'; expr: string } | { kind: 'interval'; minutes: number };

export interface ScheduledTask {
  id: string;
  label: string;
  prompt: string;
  schedule: ScheduleSpec;
  enabled: boolean;
  createdAt: number;
  lastRunAt: number | null;
  /** Truncated report of what happened last time this fired — "started" for a run still in flight, an error, or a skip reason. */
  lastResult: string | null;
  nextRunAt: number | null;
  /** The dedicated session this task's runs are sent into, created lazily on first dispatch — never the Operator's active session, so a firing task can't collide with whatever they're doing. */
  sessionId: string | null;
}

/**
 * One post on a workspace's shared cross-agent message board — the primary
 * agent, any subagent, and any Focus background agent can all read and post
 * here via the post_message/read_board tools, which is how they coordinate
 * without sharing a conversation. `needsAnswer` marks a post made through
 * ask_and_wait, which pauses the asking agent until a reply arrives whose
 * `inReplyTo` matches this message's id (or the Operator answers directly).
 */
export interface FocusMessage {
  id: string;
  from: string;
  text: string;
  createdAt: number;
  inReplyTo?: string;
  needsAnswer?: boolean;
}

/** A Focus agent's run_command call waiting on the Operator or a peer agent's post_message reply. */
export interface FocusQuestion {
  requestId: string;
  from: string;
  question: string;
}

export type FocusAgentStatus = 'running' | 'done' | 'expired' | 'stopped' | 'error';

/**
 * A background "Focus" agent — spawned via spawn_focus_agent, it runs
 * unattended in its own dedicated session for up to `budgetMs`, looping
 * turns until it either replies with the FOCUS_DONE sentinel or its time
 * budget runs out. See workspace.ts's runFocusLoop.
 */
export interface FocusAgentSummary {
  id: string;
  label: string;
  task: string;
  sessionId: string;
  status: FocusAgentStatus;
  startedAt: number;
  budgetMs: number;
  elapsedMs: number;
}
