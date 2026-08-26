export const IPC = {
  wsList: 'workspace:list',
  wsCreate: 'workspace:create',
  wsClose: 'workspace:close',
  wsSetRoot: 'workspace:set-root',
  wsHydrate: 'workspace:hydrate',
  wsMarkSeen: 'workspace:mark-seen',
  wsSetAutonomy: 'workspace:set-autonomy',
  wsUpdated: 'workspace:updated',

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

  attachmentSave: 'attachment:save',
  imageRead: 'image:read',

  modelsList: 'models:list',
  modelsGetCurrent: 'models:get-current',
  modelsSetCurrent: 'models:set-current',
  providerSet: 'provider:set',

  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',
  updateStatus: 'update:status',

  settingsGet: 'settings:get',
  settingsSet: 'settings:set',

  permsGet: 'perms:get',
  permsSet: 'perms:set',
  permsGetAllowlist: 'perms:get-allowlist',
  permsSetAllowlist: 'perms:set-allowlist',
} as const;

export type WorkspaceStatus = 'idle' | 'running' | 'review';

/** null means "not chosen yet" — drives the Coding/Browsing chooser screen. */
export type WorkspaceKind = 'coding' | 'browsing';

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

export interface WorkspaceSummary {
  id: string;
  name: string;
  rootPath: string | null;
  status: WorkspaceStatus;
  pendingDiffCount: number;
  /** True when the agent finished while the user was on another workspace. */
  unseenCompletion: boolean;
  activeSessionId: string | null;
  autonomy: Autonomy;
  /** Every session in this workspace whose agent is currently working — each session runs independently, so more than one can be live at once. */
  runningSessionIds: string[];
  /** null until the Operator picks Coding or Browsing from the chooser screen. */
  kind: WorkspaceKind | null;
  /** Where a Browsing workspace saves markdown clips — separate from rootPath, set the first time "Save as Markdown" is used, never touches sessions/chat. */
  clipsFolder: string | null;
}

/**
 * A bash or webfetch-category action waiting on the Operator's yes/no/always
 * because its category resolved to 'ask' (see workspace.ts's resolvePermission).
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
}

/** An image attached to a chat message — either a user paste/drop or something the agent generated. */
export interface ChatImage {
  /** Absolute path on disk — either under the attachment store or (for generated images) the project root. */
  path: string;
  name: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  images?: ChatImage[];
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
export type ChatProvider = 'openrouter' | 'fairrouter';

/**
 * Chat providers available in the provider/model pickers, in display order.
 * To add another (e.g. a local Ollama or llama.cpp runtime), extend this
 * list, the ChatProvider union above, models-service.ts's per-provider
 * fetcher, and agent-service.ts's resolveChatProvider.
 */
export const CHAT_PROVIDERS: { id: ChatProvider; label: string }[] = [
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'fairrouter', label: 'FairRouter' },
];

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
 * Every credential the Settings page can read and write, keyed by the exact
 * .env variable name — see setEnvValue in electron/env.ts, which is what
 * actually persists a change. Empty string means "not configured" rather
 * than absent, so the renderer never has to distinguish undefined from "".
 */
export interface ProviderSettings {
  OPENROUTER_API_KEY: string;
  FAIRROUTER_API_KEY: string;
  SEARCH_API: string;
  TRANSCRIBE_API_KEY: string;
  TRANSCRIBE_BASE_URL: string;
  TRANSCRIBE_MODEL: string;
  MAX_TOOL_CALLS: string;
}

export const SETTINGS_KEYS = [
  'OPENROUTER_API_KEY',
  'FAIRROUTER_API_KEY',
  'SEARCH_API',
  'TRANSCRIBE_API_KEY',
  'TRANSCRIBE_BASE_URL',
  'TRANSCRIBE_MODEL',
  'MAX_TOOL_CALLS',
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

/** Everything the renderer needs to display a workspace it has switched to. */
export interface WorkspaceHydration {
  summary: WorkspaceSummary;
  sessions: SessionSummary[];
  tree: FileNode[];
  chat: ChatMessage[];
  activity: ActivityEvent[];
  terminalLines: (TermDataEvent & { id: string })[];
  pendingDiffs: PendingDiff[];
  checkpoints: Checkpoint[];
  roadmap: RoadmapItem[];
}
