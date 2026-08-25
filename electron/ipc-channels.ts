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

  checkpointUndo: 'checkpoint:undo',
  checkpointList: 'checkpoint:list',

  cmdApprovalRequest: 'command:approval-request',
  cmdApprovalDecide: 'command:approval-decide',

  voiceTranscribe: 'voice:transcribe',

  attachmentSave: 'attachment:save',
  imageRead: 'image:read',

  modelsList: 'models:list',
  modelsGetCurrent: 'models:get-current',
  modelsSetCurrent: 'models:set-current',

  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',
  updateStatus: 'update:status',

  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
} as const;

export type WorkspaceStatus = 'idle' | 'running' | 'review';

/**
 * How much the agent may do without stopping to ask first. Manual gates every
 * shell command behind an explicit approval; Balanced (the historical default)
 * runs commands freely but still routes every file edit through the reviewable
 * diff queue; Auto additionally writes edits straight to disk (still logged to
 * AUDIT.md and still undoable via a checkpoint — just not held for review).
 */
export type Autonomy = 'manual' | 'balanced' | 'auto';

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
}

/** A run_command call waiting on the Operator's yes/no at Manual autonomy. */
export interface CommandApproval {
  requestId: string;
  command: string;
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
  kind: 'read' | 'list' | 'run' | 'propose' | 'search' | 'generate' | 'analyze' | 'thinking' | 'done' | 'stopped' | 'compact';
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

/** One entry from OpenRouter's public model catalog. */
export interface OpenRouterModel {
  id: string;
  name: string;
  description?: string;
  contextLength: number;
  /** USD per token (not per million) — straight from OpenRouter's pricing block. */
  promptPrice: number;
  completionPrice: number;
  /** Both prompt and completion pricing are zero — OpenRouter's own definition of a free model. */
  isFree: boolean;
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
  SEARCH_API: string;
  TRANSCRIBE_API_KEY: string;
  TRANSCRIBE_BASE_URL: string;
  TRANSCRIBE_MODEL: string;
  MAX_TOOL_CALLS: string;
}

export const SETTINGS_KEYS = [
  'OPENROUTER_API_KEY',
  'SEARCH_API',
  'TRANSCRIBE_API_KEY',
  'TRANSCRIBE_BASE_URL',
  'TRANSCRIBE_MODEL',
  'MAX_TOOL_CALLS',
] as const satisfies readonly (keyof ProviderSettings)[];

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
}
