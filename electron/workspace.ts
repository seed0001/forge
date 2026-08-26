import path from 'node:path';
import { TerminalSession } from './terminal-session';
import { DiffStore, nextId } from './diff-store';
import { AgentSession } from './agent-service';
import { writeFile } from './fs-service';
import { isAuditLogPath } from './audit-service';
import { slugify, type ExtractedPage } from './page-extract';
import { oneOffCompletion } from './chat-provider';
import { getCachedPermissionOverrides, getCachedBashAllowlist } from './perm-store';
import { loadScheduledTasks, saveScheduledTasks, computeNextRun } from './scheduler-store';
import { loadFocusBoard, saveFocusBoard } from './focus-board';
import { fileBugReport as fileBugReportOnDisk, type BugReportInput } from './bug-store';
import {
  loadSessions,
  saveSessions,
  summarize,
  titleFrom,
  type Session,
  type SessionSummary,
} from './session-store';
import type {
  ActivityEvent,
  TermDataEvent,
  PendingDiff,
  ChatMessage,
  ChatImage,
  WorkspaceSummary,
  WorkspaceStatus,
  WorkspaceKind,
  Autonomy,
  RoadmapItem,
  RoadmapItemStatus,
  SubagentCommandApproval,
  PermissionCategory,
  PermissionLevel,
  ApprovalDecision,
  ScheduledTask,
  ScheduleSpec,
  FocusMessage,
  FocusAgentSummary,
  FocusQuestion,
} from './ipc-channels';

/**
 * Default resolution for each permission category at each autonomy level —
 * chosen to match Forge's pre-existing Manual/Balanced/Auto behavior exactly
 * when no override is set: Manual gates commands, Manual/Balanced hold edits
 * for review, Auto writes edits straight through. webfetch was previously
 * ungated at every level, so it defaults to 'allow' everywhere too — only an
 * explicit override changes that.
 */
const AUTONOMY_PERMISSION_DEFAULTS: Record<PermissionCategory, Record<Autonomy, PermissionLevel>> = {
  bash: { manual: 'ask', balanced: 'allow', auto: 'allow' },
  edit: { manual: 'ask', balanced: 'ask', auto: 'allow' },
  webfetch: { manual: 'allow', balanced: 'allow', auto: 'allow' },
};

/**
 * How a category resolves for the current turn: an explicit Operator
 * override (set in Settings) always wins; otherwise it falls back to the
 * table above, keyed by the workspace's own autonomy level.
 */
export function resolvePermission(category: PermissionCategory, autonomy: Autonomy): PermissionLevel {
  const override = getCachedPermissionOverrides()[category];
  return override ?? AUTONOMY_PERMISSION_DEFAULTS[category][autonomy];
}

export interface WorkspaceEmit {
  terminal: (workspaceId: string, evt: TermDataEvent) => void;
  activity: (workspaceId: string, sessionId: string, evt: ActivityEvent) => void;
  message: (workspaceId: string, sessionId: string, msg: ChatMessage) => void;
  status: (workspaceId: string) => void;
  diffProposed: (workspaceId: string, diff: PendingDiff) => void;
  /** A diff was applied (or otherwise settled) outside the normal decide-in-UI path. */
  diffUpdated: (workspaceId: string, diff: PendingDiff) => void;
  /** The session list changed — new session, rename, or a saved update. */
  sessions: (workspaceId: string) => void;
  /** A bash or webfetch-category action is waiting on the Operator because its category resolved to 'ask'. */
  commandApproval: (
    workspaceId: string,
    sessionId: string,
    requestId: string,
    command: string,
    category: PermissionCategory
  ) => void;
  /** A subagent's run_command call is waiting on the Operator — see requestSubagentApproval. */
  subagentCommandApproval: (workspaceId: string, req: SubagentCommandApproval) => void;
  /** A session's whole roadmap, sent fresh on every change (propose/decide/edit/push-back/status). */
  roadmapUpdated: (workspaceId: string, sessionId: string, items: RoadmapItem[]) => void;
  /** This workspace's whole scheduled-task list, sent fresh on every create/update/delete/fire. */
  schedulerUpdated: (workspaceId: string, tasks: ScheduledTask[]) => void;
  /** This workspace's whole Focus agent list, sent fresh whenever one starts, finishes, or is stopped. */
  focusUpdated: (workspaceId: string, agents: FocusAgentSummary[]) => void;
  /** The shared cross-agent message board, sent fresh on every post. */
  focusBoardUpdated: (workspaceId: string, messages: FocusMessage[]) => void;
  /** An ask_and_wait call is waiting on the Operator (or a peer agent's reply) — see requestFocusAnswer. */
  focusQuestion: (workspaceId: string, req: FocusQuestion) => void;
}

/**
 * How long a subagent's command approval waits for the Operator before
 * failing closed (denied, never approved) — bounds the "no one watching"
 * risk the hardcoded 'auto' autonomy used to sidestep entirely, without
 * reintroducing an unbounded hang if the Operator has stepped away.
 */
const SUBAGENT_APPROVAL_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Everything about "is this session's agent working right now" — one copy
 * PER SESSION, so switching which session is active can never orphan
 * another session's still-running turn. Each session's AgentCallbacks close
 * over a FIXED session id (never "whichever is active"), which is the actual
 * fix: before this, every session in a workspace shared one AgentSession/
 * running-flag/pendingApprovals/roadmap-turn-state, so a running turn's
 * callbacks kept writing into whatever session the Operator switched to.
 */
interface SessionRuntime {
  agent: AgentSession | null;
  running: boolean;
  runStartedAt: number | null;
  /** Tagged with the category it was raised for, so resolveApproval knows what 'always' should apply to. */
  pendingApprovals: Map<string, { resolve: (approved: boolean) => void; category: PermissionCategory }>;
  /**
   * Categories the Operator has answered "always allow" for, this session
   * only — in-memory, never persisted, cleared the moment this runtime is
   * gone (session deleted, workspace closed, app restarted). Checked before
   * ever raising a new approval for that category on this session again.
   */
  alwaysAllowed: Set<PermissionCategory>;
  /** This session's OWN shell for agent-run commands — never shared with another session's concurrent command. */
  terminal: TerminalSession;
  activeRoadmapItemId: string | null;
  roadmapTurnSeq: number;
  pendingRoadmapRestart: RoadmapItem | null;
}

/** One running (or finished) background Focus agent — see Workspace.startFocusAgent/runFocusLoop. */
interface FocusAgentRuntime {
  id: string;
  label: string;
  task: string;
  sessionId: string;
  agent: AgentSession;
  status: FocusAgentSummary['status'];
  startedAt: number;
  budgetMs: number;
}

/**
 * A workspace is a self-contained unit of work: its own folder, terminal,
 * and review queue, shared across every session in it (they're all editing
 * the same project on disk) — but each session gets its own independent
 * agent conversation and running state (see SessionRuntime).
 *
 * Everything here lives in the main process and is driven by the agent loop, so
 * a task keeps running after the user switches to a different session, workspace
 * tab, or the renderer stops listening. The renderer is a view onto this state,
 * never its owner.
 */
export class Workspace {
  readonly id: string;
  name: string;
  rootPath: string | null;

  /** For the Operator's own typed commands in the Terminal tab — distinct from any session's agent-run commands. */
  readonly terminal: TerminalSession;
  readonly diffs: DiffStore;

  /** One merged log for the whole workspace — the Terminal tab shows everyone's commands (yours and every session's agent), tagged by source. */
  terminalLines: (TermDataEvent & { id: string })[] = [];

  private sessions: Session[] = [];
  private activeSessionId: string | null = null;
  private sessionSeq = 0;
  private runtimes = new Map<string, SessionRuntime>();
  /**
   * Workspace-scoped (not per-session) because subagents aren't sessions —
   * there is no SessionRuntime to hang a subagent's approval off of. Tagged
   * with parentSessionId purely so stopping/deleting that session can flush
   * its subagents' outstanding approvals too, same as pendingApprovals.
   */
  private pendingSubagentApprovals = new Map<string, { resolve: (approved: boolean) => void; parentSessionId: string }>();

  /** This workspace's scheduled tasks — persisted per rootPath via scheduler-store.ts, ticked by main.ts's global interval. */
  private schedules: ScheduledTask[] = [];
  /** Shared cross-agent message board — persisted per rootPath via focus-board.ts. */
  private board: FocusMessage[] = [];
  private focusAgents = new Map<string, FocusAgentRuntime>();
  private focusSeq = 0;
  /**
   * Outstanding ask_and_wait calls, keyed by the board message id of the
   * question itself — a reply's in_reply_to matching one of these keys is
   * what resolves it, whether that reply comes from the Operator (via
   * answerFocusQuestion) or another agent's plain post_message call.
   */
  private pendingFocusQuestions = new Map<string, { resolve: (answer: string | null) => void }>();

  /** Set when the agent finishes while the user is looking at another workspace. */
  unseenCompletion = false;
  /** How much this workspace's agents may do before they must stop and ask — shared across every session, since they all act on the same project on disk. */
  autonomy: Autonomy = 'balanced';
  /** null until the Operator picks Coding or Browsing from the chooser screen. */
  kind: WorkspaceKind | null = null;
  /** Where a Browsing workspace saves markdown clips — deliberately separate from rootPath (which reloads sessions when changed); picking this never touches chat/sessions. */
  clipsFolder: string | null = null;

  private emit: WorkspaceEmit;
  private lineSeq = 0;

  constructor(id: string, name: string, rootPath: string | null, emit: WorkspaceEmit) {
    this.id = id;
    this.name = name;
    this.rootPath = rootPath;
    this.emit = emit;
    this.terminal = new TerminalSession(rootPath ?? process.cwd());
    this.diffs = new DiffStore();
  }

  /** True if ANY session in this workspace has an agent actively working. */
  get agentRunning(): boolean {
    for (const rt of this.runtimes.values()) if (rt.running) return true;
    return false;
  }

  /** Ids of every session currently running — lets the renderer show exactly which session(s) are live, not just "something in this workspace." */
  get runningSessionIds(): string[] {
    return [...this.runtimes.entries()].filter(([, rt]) => rt.running).map(([sid]) => sid);
  }

  private runtime(sessionId: string): SessionRuntime {
    let rt = this.runtimes.get(sessionId);
    if (!rt) {
      rt = {
        agent: null,
        running: false,
        runStartedAt: null,
        pendingApprovals: new Map(),
        alwaysAllowed: new Set(),
        terminal: new TerminalSession(this.rootPath ?? process.cwd()),
        activeRoadmapItemId: null,
        roadmapTurnSeq: 0,
        pendingRoadmapRestart: null,
      };
      this.runtimes.set(sessionId, rt);
    }
    return rt;
  }

  async setRoot(rootPath: string) {
    this.rootPath = rootPath;
    this.name = path.basename(rootPath);
    this.terminal.setCwd(rootPath);
    // Sessions are keyed to the folder, so opening a new one swaps the history
    // entirely — stop whatever every old session's agent was doing first.
    for (const rt of this.runtimes.values()) rt.agent?.stop();
    this.runtimes.clear();
    for (const rt of this.focusAgents.values()) rt.agent.stop();
    this.focusAgents.clear();
    this.sessions = await loadSessions(rootPath);
    this.activeSessionId = this.sessions[0]?.id ?? null;
    if (!this.activeSessionId) this.newSession();
    this.schedules = await loadScheduledTasks(rootPath);
    this.board = await loadFocusBoard(rootPath);
  }

  /** Sessions newest-first, the order the sidebar lists them in. */
  listSessions(): SessionSummary[] {
    return [...this.sessions].sort((a, b) => b.updatedAt - a.updatedAt).map(summarize);
  }

  get activeSession(): Session | null {
    return this.sessions.find((s) => s.id === this.activeSessionId) ?? null;
  }

  get chat(): ChatMessage[] {
    return this.activeSession?.chat ?? [];
  }

  get activity(): ActivityEvent[] {
    return this.activeSession?.activity ?? [];
  }

  get roadmap(): RoadmapItem[] {
    return this.activeSession?.roadmap ?? [];
  }

  /**
   * Each session has its own isolated SessionRuntime/AgentSession — nothing
   * is torn down or rebuilt when you switch which one is active, so this is
   * always safe, even while other sessions (or this one) are mid-task.
   */
  newSession(): SessionSummary {
    this.sessionSeq += 1;
    const now = Date.now();
    const session: Session = {
      id: `${this.id}-s${this.sessionSeq}-${now.toString(36)}`,
      title: 'New session',
      titled: false,
      createdAt: now,
      updatedAt: now,
      chat: [],
      activity: [],
      messages: [],
      roadmap: [],
    };
    this.sessions.unshift(session);
    this.activeSessionId = session.id;
    void this.persist();
    return summarize(session);
  }

  /**
   * Same as newSession, but never becomes the active one — used by the
   * scheduler so a background task's own dedicated session doesn't steal
   * focus from whatever the Operator is actually looking at.
   */
  newBackgroundSession(label: string): SessionSummary {
    this.sessionSeq += 1;
    const now = Date.now();
    const session: Session = {
      id: `${this.id}-bg${this.sessionSeq}-${now.toString(36)}`,
      title: label,
      titled: true, // the caller already named it — skip AI titling
      createdAt: now,
      updatedAt: now,
      chat: [],
      activity: [],
      messages: [],
      roadmap: [],
    };
    this.sessions.push(session);
    void this.persist();
    this.emit.sessions(this.id);
    return summarize(session);
  }

  /**
   * Sends into a SPECIFIC session regardless of which one is active — for
   * the scheduler, which must never touch the Operator's current session.
   * Refuses (returns false) if that session's agent is already mid-turn,
   * since calling send() again on the same AgentSession before the first
   * call returns would race on its shared message array; the caller just
   * tries again next poll.
   */
  async sendToSession(sessionId: string, text: string): Promise<boolean> {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) return false;
    if (this.runtimes.get(sessionId)?.running) return false;
    const msg: ChatMessage = { role: 'user', text };
    session.chat.push(msg);
    session.activity = [];
    session.updatedAt = Date.now();
    this.emit.message(this.id, sessionId, msg);
    this.emit.sessions(this.id);
    void this.ensureAgent(sessionId).send(text);
    return true;
  }

  selectSession(sessionId: string): boolean {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) return false;
    this.activeSessionId = sessionId;
    // That session's own agent (if it has one yet) is untouched — still
    // running, still idle, whatever it already was. ensureAgent() builds one
    // lazily on first real use if it doesn't exist yet.
    return true;
  }

  deleteSession(sessionId: string) {
    const rt = this.runtimes.get(sessionId);
    rt?.agent?.stop();
    for (const [, entry] of rt?.pendingApprovals ?? []) entry.resolve(false);
    this.flushSubagentApprovalsFor(sessionId);
    this.runtimes.delete(sessionId);

    this.sessions = this.sessions.filter((s) => s.id !== sessionId);
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = this.sessions[0]?.id ?? null;
      if (!this.activeSessionId) this.newSession();
    }
    void this.persist();
  }

  async restoreSessions() {
    this.sessions = await loadSessions(this.rootPath);
    this.activeSessionId = this.sessions[0]?.id ?? null;
    if (!this.activeSessionId) this.newSession();
    this.schedules = this.rootPath ? await loadScheduledTasks(this.rootPath) : [];
    this.board = this.rootPath ? await loadFocusBoard(this.rootPath) : [];
  }

  /** Exports every session that currently has a live agent, not just the active one — a background session's history must persist too. */
  private async persist() {
    for (const [sessionId, rt] of this.runtimes) {
      if (!rt.agent) continue;
      const session = this.sessions.find((s) => s.id === sessionId);
      if (session) {
        session.messages = rt.agent.exportHistory();
        session.updatedAt = Date.now();
      }
    }
    await saveSessions(this.rootPath, this.sessions);
  }

  get status(): WorkspaceStatus {
    if (this.agentRunning) return 'running';
    if (this.diffs.list().length > 0) return 'review';
    return 'idle';
  }

  summary(): WorkspaceSummary {
    return {
      id: this.id,
      name: this.name,
      rootPath: this.rootPath,
      status: this.status,
      pendingDiffCount: this.diffs.list().length,
      unseenCompletion: this.unseenCompletion,
      activeSessionId: this.activeSessionId,
      autonomy: this.autonomy,
      runningSessionIds: this.runningSessionIds,
      kind: this.kind,
      clipsFolder: this.clipsFolder,
    };
  }

  setAutonomy(level: Autonomy) {
    this.autonomy = level;
    this.emit.status(this.id);
  }

  setKind(kind: WorkspaceKind) {
    this.kind = kind;
    this.emit.status(this.id);
  }

  setClipsFolder(folder: string) {
    this.clipsFolder = folder;
    this.emit.status(this.id);
  }

  /**
   * Summarizes a browsed page and posts it straight into the active
   * session's chat — not a real agent turn (no tools, no model conversation
   * involved), just a one-off completion whose result becomes a normal chat
   * message so the Operator can keep discussing the page from there.
   */
  async summarizePage(extracted: ExtractedPage, url: string): Promise<void> {
    const sessionId = this.activeSessionId;
    const session = sessionId ? this.sessions.find((s) => s.id === sessionId) : null;
    if (!session) return;

    const { title, markdown, excerpt } = extracted;
    const prompt =
      'Summarize this web page in 3-6 sentences, capturing the key points a reader would want to ' +
      'know before deciding whether to read the whole thing. Do not just repeat the title.\n\n' +
      `Title: ${title}\nURL: ${url}\n\n${markdown.slice(0, 12_000)}`;

    const { text, costUsd } = await oneOffCompletion(prompt, { maxTokens: 400, temperature: 0.3 });
    if (costUsd) {
      session.costUsd = (session.costUsd ?? 0) + costUsd;
    }

    const summary = text || excerpt || 'Could not generate a summary — no AI provider is configured (check Settings).';
    const clipped =
      markdown.length > 4000
        ? `${markdown.slice(0, 4000)}\n\n…(clipped for chat — use "Save as Markdown" for the full page)`
        : markdown;
    const body = `📄 **${title}**\n${url}\n\n${summary}\n\n---\n\n**Full clipped content:**\n\n${clipped}`;

    // Mirror this into the agent's actual conversation, not just the chat
    // log — otherwise the model has no memory of the review on the next
    // real turn (session.chat is display-only; session.messages/this.messages
    // is what's actually sent to the provider).
    const clipNote = `[Operator clipped this page in the browser]\nTitle: ${title}\nURL: ${url}`;
    this.ensureAgent(session.id).recordClip(clipNote, body);

    const msg: ChatMessage = { role: 'assistant', text: body };
    session.chat.push(msg);
    session.updatedAt = Date.now();
    this.emit.message(this.id, session.id, msg);
    void this.persist();
    this.emit.sessions(this.id);
  }

  /** Saves a browsed page as a markdown clip under this workspace's clips folder — the Operator picks one the first time (never touches rootPath/sessions/chat). */
  async saveClip(extracted: ExtractedPage, url: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
    const folder = this.clipsFolder;
    if (!folder) return { ok: false, error: 'No folder set for this workspace yet.' };
    try {
      const { title, markdown } = extracted;
      const rel = path.join('clips', `${slugify(title)}.md`);
      const abs = path.resolve(folder, rel);
      const frontmatter =
        `---\ntitle: ${JSON.stringify(title)}\nsource: ${JSON.stringify(url)}\n` +
        `saved: ${JSON.stringify(new Date().toISOString())}\n---\n\n`;
      await writeFile(folder, abs, frontmatter + markdown + '\n');
      return { ok: true, path: rel };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * True if the Operator has already answered "always allow" for this
   * category on this session — lets a caller skip raising a new approval
   * entirely rather than prompt again just to have it auto-answered.
   */
  isAlwaysAllowed(sessionId: string, category: PermissionCategory): boolean {
    return this.runtime(sessionId).alwaysAllowed.has(category);
  }

  /** Blocks until the Operator decides, or resolves false if that session's run is stopped first. */
  requestApproval(sessionId: string, command: string, category: PermissionCategory): Promise<boolean> {
    const requestId = nextId('appr');
    this.emit.commandApproval(this.id, sessionId, requestId, command, category);
    return new Promise((resolve) => {
      this.runtime(sessionId).pendingApprovals.set(requestId, { resolve, category });
    });
  }

  /** requestId is globally unique, so no need to know which session it belongs to. */
  resolveApproval(requestId: string, decision: ApprovalDecision) {
    for (const rt of this.runtimes.values()) {
      const entry = rt.pendingApprovals.get(requestId);
      if (entry) {
        rt.pendingApprovals.delete(requestId);
        if (decision === 'always') rt.alwaysAllowed.add(entry.category);
        entry.resolve(decision !== 'denied');
        return;
      }
    }
  }

  /**
   * Same shape as requestApproval, for a subagent's run_command instead of a
   * session's own. Fails closed: if the Operator never answers within
   * SUBAGENT_APPROVAL_TIMEOUT_MS, this resolves false (denied), never true —
   * a stalled/incomplete subagent task is the acceptable worst case, an
   * unreviewed command execution is not.
   */
  requestSubagentApproval(parentSessionId: string, command: string, label: string): Promise<boolean> {
    const requestId = nextId('subappr');
    this.emit.subagentCommandApproval(this.id, { requestId, command, label, parentSessionId });
    return new Promise((resolve) => {
      this.pendingSubagentApprovals.set(requestId, { resolve, parentSessionId });
      setTimeout(() => {
        const entry = this.pendingSubagentApprovals.get(requestId);
        if (!entry) return; // Already answered or already flushed by a stop/delete.
        this.pendingSubagentApprovals.delete(requestId);
        entry.resolve(false);
      }, SUBAGENT_APPROVAL_TIMEOUT_MS);
    });
  }

  resolveSubagentApproval(requestId: string, approved: boolean) {
    const entry = this.pendingSubagentApprovals.get(requestId);
    if (!entry) return;
    this.pendingSubagentApprovals.delete(requestId);
    entry.resolve(approved);
  }

  /** Resolves every subagent approval tied to this session as denied — called wherever a session's own pendingApprovals are flushed. */
  private flushSubagentApprovalsFor(sessionId: string) {
    for (const [requestId, entry] of this.pendingSubagentApprovals) {
      if (entry.parentSessionId !== sessionId) continue;
      this.pendingSubagentApprovals.delete(requestId);
      entry.resolve(false);
    }
  }

  /**
   * Auto autonomy: accept every hunk immediately and write it, bypassing the
   * review queue — EXCEPT for the workspace's own AUDIT.md, which always goes
   * through the normal pending-review queue instead, regardless of autonomy.
   * Otherwise an agent (potentially steered by injected content) could
   * silently rewrite or truncate its own mutation history with nobody ever
   * looking.
   */
  async applyEditAuto(diff: PendingDiff) {
    if (!this.rootPath) return;
    if (isAuditLogPath(this.rootPath, diff.path)) {
      this.diffs.add(diff);
      this.emit.diffProposed(this.id, diff);
      this.emit.status(this.id);
      return;
    }
    this.diffs.add(diff);
    const settled = await this.diffs.decide(this.rootPath, diff.id, 'all', 'accepted');
    if (settled) this.emit.diffUpdated(this.id, settled);
    this.emit.status(this.id);
  }

  /**
   * propose_edit ends the agent's turn immediately ("waiting on review") so a
   * whole batch of files can be queued and reviewed together instead of one
   * at a time — but that means nothing ever tells the agent the review
   * happened. Call this once a review batch empties out; if the active
   * session's agent is sitting idle because of it, this is what wakes it
   * back up. Diffs are workspace-wide (every session edits the same project
   * on disk), so this always targets whichever session is currently active
   * — the one the Operator was actually looking at while reviewing.
   */
  resumeAfterReview() {
    const sessionId = this.activeSessionId;
    if (!sessionId || this.runtimes.get(sessionId)?.running) return;
    void this.ensureAgent(sessionId).send(
      "The Operator has finished reviewing your proposed edits. Some may have been accepted, " +
        'some rejected, or edited before accepting — do not assume the outcome. Check the files ' +
        'that matter with read_file, then continue the task.'
    );
  }

  // ── Roadmap ──────────────────────────────────────────────────────────────
  // Public methods below act on whichever session is currently active (the
  // renderer only ever shows/edits the displayed session's roadmap). The
  // private helpers take an explicit sessionId because they're also driven
  // by a specific session's AgentCallbacks, which may not be the active one.

  private findRoadmapItem(sessionId: string, itemId: string): RoadmapItem | undefined {
    return this.sessions.find((s) => s.id === sessionId)?.roadmap.find((it) => it.id === itemId);
  }

  private emitRoadmap(sessionId: string) {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    this.emit.roadmapUpdated(this.id, sessionId, session.roadmap);
  }

  /** propose_roadmap replaces that session's whole roadmap. */
  proposeRoadmap(sessionId: string, items: RoadmapItem[]) {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    session.roadmap = items;
    void this.persist();
    this.emitRoadmap(sessionId);
  }

  decideRoadmapItem(itemId: string, decision: 'approve' | 'reject') {
    const sessionId = this.activeSessionId;
    if (!sessionId) return;
    const item = this.findRoadmapItem(sessionId, itemId);
    if (!item) return;
    item.status = decision === 'approve' ? 'approved' : 'rejected';
    void this.persist();
    this.emitRoadmap(sessionId);
    this.maybeAdvanceRoadmap(sessionId);
  }

  /** Text-only edit — never touches status or interrupts a running turn. */
  editRoadmapItem(itemId: string, patch: { title?: string; summary?: string; detail?: string }) {
    const sessionId = this.activeSessionId;
    if (!sessionId) return;
    const item = this.findRoadmapItem(sessionId, itemId);
    if (!item) return;
    if (patch.title !== undefined) item.title = patch.title;
    if (patch.summary !== undefined) item.summary = patch.summary;
    if (patch.detail !== undefined) item.detail = patch.detail;
    void this.persist();
    this.emitRoadmap(sessionId);
  }

  /** Allowed manual status transitions the UI offers (revert/reopen/restore) — always back to 'pending'. */
  setRoadmapItemStatus(itemId: string, status: RoadmapItemStatus) {
    const sessionId = this.activeSessionId;
    if (!sessionId) return;
    const item = this.findRoadmapItem(sessionId, itemId);
    if (!item || item.status === 'in_progress') return; // never touch a running item this way — use pushBack
    item.status = status;
    void this.persist();
    this.emitRoadmap(sessionId);
    if (status === 'approved') this.maybeAdvanceRoadmap(sessionId);
  }

  /**
   * Edit + interrupt-and-redo. If the item isn't currently running, this is
   * just a text edit. If it IS running: `AgentSession.send()` is NOT safe to
   * call again on the same instance until the CURRENT call has actually
   * returned — abort() only rejects the in-flight fetch asynchronously, so
   * calling ensureAgent().send(...) again right after stop() would run two
   * send() invocations concurrently on the same object, racing on the same
   * shared this.messages array. So this does not restart the turn directly:
   * it records the restart, bumps roadmapTurnSeq (so the old turn's `.then()`
   * knows it's been superseded), and stop()s it — the OLD turn's `.then()`
   * (see startRoadmapTurn) is what actually starts the new one, because that
   * `.then()` firing IS the proof send() has really returned. Deliberately
   * leaves activeRoadmapItemId set the whole time, so maybeAdvanceRoadmap
   * can't sneak a DIFFERENT item's turn onto this same busy AgentSession
   * while we're waiting for it to be safe.
   */
  pushBackRoadmapItem(itemId: string, newDetail: string) {
    const sessionId = this.activeSessionId;
    if (!sessionId) return;
    const item = this.findRoadmapItem(sessionId, itemId);
    if (!item) return;
    item.detail = newDetail;
    if (item.status !== 'in_progress') {
      void this.persist();
      this.emitRoadmap(sessionId);
      return;
    }
    const rt = this.runtime(sessionId);
    rt.roadmapTurnSeq++;
    rt.pendingRoadmapRestart = item;
    item.status = 'approved'; // reflect "queued to restart", not stuck in_progress
    void this.persist();
    this.emitRoadmap(sessionId);
    rt.agent?.stop();
  }

  /** No-op if that session's turn is already active, or nothing is approved and waiting. */
  private maybeAdvanceRoadmap(sessionId: string) {
    const rt = this.runtime(sessionId);
    if (rt.activeRoadmapItemId) return;
    const roadmap = this.sessions.find((s) => s.id === sessionId)?.roadmap;
    if (!roadmap?.length) return;
    const next = roadmap.filter((it) => it.status === 'approved').sort((a, b) => a.order - b.order)[0];
    if (next) this.startRoadmapTurn(sessionId, next);
  }

  private startRoadmapTurn(sessionId: string, item: RoadmapItem) {
    const rt = this.runtime(sessionId);
    item.status = 'in_progress';
    item.notes = undefined; // clear any stale needs_revision/done note from a prior attempt
    void this.persist();
    this.emitRoadmap(sessionId);
    this.trackRoadmapActivity(sessionId, `Started roadmap item: "${item.title}"`);

    rt.activeRoadmapItemId = item.id;
    const seq = ++rt.roadmapTurnSeq;
    void this.ensureAgent(sessionId)
      .send(this.buildRoadmapItemPrompt(item))
      .then(() => {
        if (seq !== rt.roadmapTurnSeq) {
          // Superseded by a push-back. This firing is the actual proof that
          // send() has returned on this AgentSession — only now is it safe
          // to call it again, so this is what starts the restart, not
          // pushBackRoadmapItem itself.
          const restart = rt.pendingRoadmapRestart;
          rt.pendingRoadmapRestart = null;
          rt.activeRoadmapItemId = null;
          // Only restart if it's still queued for it — the Operator may have
          // rejected it (or otherwise changed its status) while we waited for
          // this old turn to actually finish unwinding.
          if (restart && restart.status === 'approved') this.startRoadmapTurn(sessionId, restart);
          else this.maybeAdvanceRoadmap(sessionId);
          return;
        }
        rt.activeRoadmapItemId = null;
        this.onRoadmapTurnEndedFor(sessionId, item.id);
      });
  }

  /** The AgentCallbacks hook for complete_roadmap_item — must answer synchronously so the model learns right away if it failed. */
  onRoadmapItemDone(sessionId: string, itemId: string, summary: string): { ok: boolean; error?: string } {
    const item = this.findRoadmapItem(sessionId, itemId);
    if (!item) return { ok: false, error: `No roadmap item with id "${itemId}".` };
    if (item.status !== 'in_progress') {
      return { ok: false, error: `Roadmap item "${itemId}" is not in progress (status: ${item.status}).` };
    }
    item.status = 'done';
    item.notes = summary;
    void this.persist();
    this.emitRoadmap(sessionId);
    // Do NOT advance here — the turn (send()) is still running; startRoadmapTurn's
    // .then() calls onRoadmapTurnEndedFor once it actually finishes, which advances.
    return { ok: true };
  }

  private onRoadmapTurnEndedFor(sessionId: string, itemId: string) {
    const item = this.findRoadmapItem(sessionId, itemId);
    if (!item) return;
    if (item.status === 'in_progress') {
      // The turn ended (naturally, or hit the turn limit) without the agent
      // ever calling complete_roadmap_item — flag it rather than silently
      // advancing past unfinished work.
      item.status = 'needs_revision';
      item.notes = "The agent's turn ended without marking this item done — review needed.";
      void this.persist();
      this.emitRoadmap(sessionId);
      return;
    }
    // status is 'done' (via complete_roadmap_item) — keep the queue moving.
    this.maybeAdvanceRoadmap(sessionId);
  }

  private buildRoadmapItemPrompt(item: RoadmapItem): string {
    return (
      `You are working on roadmap item ${item.id}: "${item.title}".\n\n` +
      `Plan:\n${item.detail}\n\n` +
      `When this item's work is genuinely complete, call complete_roadmap_item with item_id "${item.id}" ` +
      'and a short summary. If you get stuck or need the Operator\'s input, explain that in your reply ' +
      'instead of calling it.'
    );
  }

  private trackRoadmapActivity(sessionId: string, detail: string) {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    const evt: ActivityEvent = { id: nextId('act'), kind: 'roadmap', detail, status: 'done' };
    session.activity.push(evt);
    this.emit.activity(this.id, sessionId, evt);
  }

  // ── Scheduler ────────────────────────────────────────────────────────────
  // A scheduled task fires a fixed prompt into its own dedicated background
  // session on a cron or interval schedule. main.ts's global interval calls
  // tickScheduler() on every open workspace periodically; nothing in here
  // starts a timer of its own.

  listSchedules(): ScheduledTask[] {
    return this.schedules;
  }

  private emitSchedules() {
    this.emit.schedulerUpdated(this.id, this.schedules);
  }

  private persistSchedules() {
    return this.rootPath ? saveScheduledTasks(this.rootPath, this.schedules) : Promise.resolve();
  }

  createSchedule(label: string, prompt: string, schedule: ScheduleSpec): ScheduledTask {
    const task: ScheduledTask = {
      id: nextId('sched'),
      label,
      prompt,
      schedule,
      enabled: true,
      createdAt: Date.now(),
      lastRunAt: null,
      lastResult: null,
      nextRunAt: computeNextRun(schedule, Date.now()),
      sessionId: null,
    };
    this.schedules.push(task);
    void this.persistSchedules();
    this.emitSchedules();
    return task;
  }

  updateSchedule(id: string, patch: Partial<Pick<ScheduledTask, 'label' | 'prompt' | 'schedule' | 'enabled'>>) {
    const task = this.schedules.find((t) => t.id === id);
    if (!task) return;
    if (patch.label !== undefined) task.label = patch.label;
    if (patch.prompt !== undefined) task.prompt = patch.prompt;
    if (patch.schedule !== undefined) {
      task.schedule = patch.schedule;
      task.nextRunAt = computeNextRun(patch.schedule, Date.now());
    }
    if (patch.enabled !== undefined) {
      task.enabled = patch.enabled;
      // Re-enabling a task that ran out its cron window (nextRunAt gone null) needs a fresh one to ever fire again.
      if (task.enabled && task.nextRunAt === null) task.nextRunAt = computeNextRun(task.schedule, Date.now());
    }
    void this.persistSchedules();
    this.emitSchedules();
  }

  deleteSchedule(id: string) {
    this.schedules = this.schedules.filter((t) => t.id !== id);
    void this.persistSchedules();
    this.emitSchedules();
  }

  runScheduleNow(id: string) {
    const task = this.schedules.find((t) => t.id === id);
    if (task) void this.fireSchedule(task);
  }

  private async fireSchedule(task: ScheduledTask) {
    if (!task.sessionId || !this.sessions.some((s) => s.id === task.sessionId)) {
      task.sessionId = this.newBackgroundSession(`Scheduled: ${task.label}`).id;
    }
    task.lastRunAt = Date.now();
    task.lastResult = 'started';
    void this.persistSchedules();
    this.emitSchedules();
    const ok = await this.sendToSession(task.sessionId, task.prompt);
    task.lastResult = ok ? 'started' : 'skipped — its session was still busy from the last run; will retry next tick';
    void this.persistSchedules();
    this.emitSchedules();
  }

  /** Called periodically by main.ts's global interval — fires every enabled task whose nextRunAt has passed. */
  tickScheduler() {
    if (!this.rootPath) return;
    const now = Date.now();
    for (const task of this.schedules) {
      if (!task.enabled || task.nextRunAt === null || task.nextRunAt > now) continue;
      task.nextRunAt = computeNextRun(task.schedule, now);
      void this.fireSchedule(task);
    }
  }

  // ── Cross-agent message board ───────────────────────────────────────────
  // Shared by every agent in this workspace — the primary session(s), their
  // subagents, and any Focus agents — via the post_message/read_board/
  // ask_and_wait tools. See agent-service.ts's AgentCallbacks for how an
  // AgentSession reaches these.

  private persistBoard() {
    return this.rootPath ? saveFocusBoard(this.rootPath, this.board) : Promise.resolve();
  }

  /**
   * Records a post and, if it answers an outstanding ask_and_wait (inReplyTo
   * matches a pending question's own message id), resolves that wait too —
   * whether the reply came from the Operator (answerFocusQuestion) or another
   * agent's own post_message call.
   */
  postToBoard(from: string, text: string, opts?: { inReplyTo?: string; needsAnswer?: boolean }): FocusMessage {
    const msg: FocusMessage = {
      id: nextId('msg'),
      from,
      text,
      createdAt: Date.now(),
      inReplyTo: opts?.inReplyTo,
      needsAnswer: opts?.needsAnswer,
    };
    this.board.push(msg);
    if (this.board.length > 500) this.board.shift();
    void this.persistBoard();
    this.emit.focusBoardUpdated(this.id, this.board);

    if (opts?.inReplyTo) {
      const pending = this.pendingFocusQuestions.get(opts.inReplyTo);
      if (pending) {
        this.pendingFocusQuestions.delete(opts.inReplyTo);
        pending.resolve(text);
      }
    }
    return msg;
  }

  readBoard(sinceId?: string, limit = 50): FocusMessage[] {
    let list = this.board;
    if (sinceId) {
      const idx = list.findIndex((m) => m.id === sinceId);
      if (idx >= 0) list = list.slice(idx + 1);
    }
    return list.slice(-Math.max(1, Math.min(limit, 200)));
  }

  /**
   * ask_and_wait's implementation: posts the question (tagged needsAnswer),
   * notifies the UI, and blocks until postToBoard resolves it (a reply's
   * inReplyTo matching this question's id) or the timeout elapses — resolving
   * null in that case, never hanging forever.
   */
  requestFocusAnswer(from: string, question: string, timeoutMinutes = 10): Promise<string | null> {
    const msg = this.postToBoard(from, question, { needsAnswer: true });
    this.emit.focusQuestion(this.id, { requestId: msg.id, from, question });
    const timeoutMs = Math.min(Math.max(timeoutMinutes, 1), 60) * 60_000;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingFocusQuestions.delete(msg.id)) resolve(null);
      }, timeoutMs);
      this.pendingFocusQuestions.set(msg.id, {
        resolve: (answer) => {
          clearTimeout(timer);
          resolve(answer);
        },
      });
    });
  }

  /** The Operator answering an ask_and_wait question directly from the UI, rather than another agent replying via post_message. */
  answerFocusQuestion(requestId: string, answer: string) {
    const pending = this.pendingFocusQuestions.get(requestId);
    if (!pending) return;
    this.pendingFocusQuestions.delete(requestId);
    this.postToBoard('Operator', answer, { inReplyTo: requestId });
    pending.resolve(answer);
  }

  fileBugReport(report: BugReportInput): Promise<string> {
    if (!this.rootPath) return Promise.reject(new Error('No project folder open.'));
    return fileBugReportOnDisk(this.rootPath, report);
  }

  // ── Focus agents ─────────────────────────────────────────────────────────
  // spawn_focus_agent starts one of these: an independent AgentSession that
  // keeps looping turns, unattended, in its own dedicated background session
  // until it either replies with the FOCUS_DONE sentinel or its time budget
  // runs out. It shares the same tool set as a subagent (SUBAGENT_TOOLS,
  // which now includes the board/ask_and_wait tools) so it can coordinate
  // with whoever spawned it or with other Focus agents while it works.

  listFocusAgents(): FocusAgentSummary[] {
    return [...this.focusAgents.values()].map((f) => ({
      id: f.id,
      label: f.label,
      task: f.task,
      sessionId: f.sessionId,
      status: f.status,
      startedAt: f.startedAt,
      budgetMs: f.budgetMs,
      elapsedMs: Date.now() - f.startedAt,
    }));
  }

  private emitFocus() {
    this.emit.focusUpdated(this.id, this.listFocusAgents());
  }

  stopFocusAgent(id: string) {
    const rt = this.focusAgents.get(id);
    if (!rt) return;
    rt.agent.stop();
    rt.status = 'stopped';
    this.emitFocus();
  }

  startFocusAgent(task: string, label: string, budgetMinutes = 30): FocusAgentSummary {
    this.focusSeq += 1;
    const id = `${this.id}-focus${this.focusSeq}-${Date.now().toString(36)}`;
    const sessionId = this.newBackgroundSession(`Focus: ${label}`).id;
    const budgetMs = Math.round(Math.min(Math.max(budgetMinutes, 1), 240) * 60_000);
    const rulesDir = process.env.RULES_DIR?.trim() || null;
    const findSession = () => this.sessions.find((s) => s.id === sessionId);

    let lastReply = '';
    const agent = new AgentSession(
      this.rootPath ?? process.cwd(),
      {
        onActivity: (evt) => {
          const session = findSession();
          if (session) {
            session.activity.push(evt);
            if (session.activity.length > 200) session.activity.shift();
          }
          this.emit.activity(this.id, sessionId, evt);
        },
        onTerminal: (evt) => this.recordTerminal(evt),
        onMessage: (text, images, note) => {
          if (!note) lastReply = text; // Interim notes never overwrite the real last reply the focus loop reports back.
          const msg: ChatMessage = { role: 'assistant', text, images, note };
          const session = findSession();
          session?.chat.push(msg);
          this.emit.message(this.id, sessionId, msg);
        },
        onStatus: () => {}, // Focus agents aren't part of any session's running-indicator bracket.
        onDiffProposed: (diff) => {
          this.diffs.add(diff);
          this.emit.diffProposed(this.id, diff);
          this.emit.status(this.id);
        },
        onRoadmapProposed: () => {},
        onRoadmapItemDone: () => ({ ok: false, error: 'Focus agents cannot work on roadmap items.' }),
        onUsage: () => {},
        onCost: (usd) => {
          const session = findSession();
          if (!session) return;
          session.costUsd = (session.costUsd ?? 0) + usd;
          this.emit.sessions(this.id);
        },
        onCompaction: () => {},
        runShell: (requestId, command) =>
          this.runtime(sessionId).terminal.run(requestId, 'agent', command, (evt) => this.recordTerminal(evt)),
        getPermission: (category) => resolvePermission(category, this.autonomy),
        requestActionApproval: (category, description) => this.requestApproval(sessionId, description, category),
        getBashAllowlist: () => getCachedBashAllowlist(),
        requestSubagentCommandApproval: (command, subLabel) => this.requestSubagentApproval(sessionId, command, subLabel),
        applyEditAuto: (diff) => this.applyEditAuto(diff),
        getSessionCostUsd: () => findSession()?.costUsd ?? 0,
        postToBoard: (from, text, inReplyTo) => this.postToBoard(from, text, { inReplyTo }),
        readBoard: (sinceId, limit) => this.readBoard(sinceId, limit),
        askAndWait: (from, question, timeoutMinutes) => this.requestFocusAnswer(from, question, timeoutMinutes),
        fileBugReport: (report) => this.fileBugReport(report),
      },
      rulesDir,
      true,
      `Focus: ${label}`
    );

    const rt: FocusAgentRuntime = { id, label, task, sessionId, agent, status: 'running', startedAt: Date.now(), budgetMs };
    this.focusAgents.set(id, rt);
    this.emitFocus();
    void this.runFocusLoop(rt, () => lastReply);
    return { id, label, task, sessionId, status: 'running', startedAt: rt.startedAt, budgetMs, elapsedMs: 0 };
  }

  /**
   * Keeps sending turns to a Focus agent until it declares itself done
   * (FOCUS_DONE on its own line) or its time budget runs out — this is the
   * actual "keeps working unattended" mechanism; nothing else advances it.
   */
  private async runFocusLoop(rt: FocusAgentRuntime, getLastReply: () => string) {
    const deadline = rt.startedAt + rt.budgetMs;
    let prompt =
      `You are a background Focus agent with a total time budget of ${Math.round(rt.budgetMs / 60000)} ` +
      'minute(s). No one is watching this run live, so work autonomously toward the task below. You can ' +
      'coordinate with other agents via post_message/read_board, and use ask_and_wait only if you are ' +
      'genuinely blocked without an answer. When the task is fully and genuinely complete, end your reply ' +
      'with the exact line FOCUS_DONE — do not include it before that is true.\n\n' +
      `Task: ${rt.task}`;

    try {
      while (rt.status === 'running' && Date.now() < deadline) {
        await rt.agent.send(prompt);
        if (rt.status !== 'running') break; // Stopped externally mid-turn.
        if (getLastReply().includes('FOCUS_DONE')) {
          rt.status = 'done';
          break;
        }
        const remainingMin = Math.max(0, Math.round((deadline - Date.now()) / 60_000));
        if (remainingMin <= 0) break;
        prompt =
          `You have about ${remainingMin} minute(s) left in your budget. Continue the task, or if it is ` +
          'genuinely complete, end your reply with FOCUS_DONE.';
      }
    } catch {
      rt.status = 'error';
    }
    if (rt.status === 'running') rt.status = Date.now() >= deadline ? 'expired' : 'done';
    this.emitFocus();
  }

  /** Lazily builds — and only builds once — this session's own isolated AgentSession, restoring its persisted history the first time. */
  private ensureAgent(sessionId: string): AgentSession {
    const rt = this.runtime(sessionId);
    if (!rt.agent) {
      const rulesDir = process.env.RULES_DIR?.trim() || null;
      const findSession = () => this.sessions.find((s) => s.id === sessionId);
      rt.agent = new AgentSession(this.rootPath ?? process.cwd(), {
        onActivity: (evt) => {
          const session = findSession();
          if (session) {
            const existing = session.activity.findIndex((a) => a.id === evt.id);
            if (existing >= 0) session.activity[existing] = evt;
            else session.activity.push(evt);
            if (session.activity.length > 200) session.activity.shift();
          }
          this.emit.activity(this.id, sessionId, evt);
        },
        onTerminal: (evt) => this.recordTerminal(evt),
        onMessage: (text, images, note) => {
          const msg: ChatMessage = { role: 'assistant', text, images, note };
          const session = findSession();
          session?.chat.push(msg);
          this.emit.message(this.id, sessionId, msg);
          if (note) return; // An interim status note, not a real reply — no titling, no completion bookkeeping.

          // Name the session from its actual content, once, after the first
          // real exchange — never blocking the reply the user is reading.
          const isFirstReply = session && session.chat.filter((m) => m.role === 'assistant' && !m.note).length === 1;
          if (session && isFirstReply && !session.titled) {
            const sid = session.id;
            void rt.agent!.generateTitle().then((title) => {
              const target = this.sessions.find((s) => s.id === sid);
              if (!target || target.titled) return;
              target.titled = true;
              if (title) target.title = title;
              void this.persist();
              this.emit.sessions(this.id);
            });
          }
        },
        onStatus: (running) => {
          const session = findSession();
          if (running) {
            rt.runStartedAt = Date.now();
          } else if (rt.runStartedAt !== null) {
            if (session) session.elapsedMs = (session.elapsedMs ?? 0) + (Date.now() - rt.runStartedAt);
            rt.runStartedAt = null;
          }
          rt.running = running;
          if (!running) {
            this.unseenCompletion = true;
            // Checkpoint the conversation whenever this session's agent goes quiet.
            void this.persist().then(() => this.emit.sessions(this.id));
          }
          this.emit.status(this.id);
        },
        onDiffProposed: (diff) => {
          this.diffs.add(diff);
          this.emit.diffProposed(this.id, diff);
          this.emit.status(this.id);
        },
        onRoadmapProposed: (items) => this.proposeRoadmap(sessionId, items),
        onRoadmapItemDone: (itemId, summary) => this.onRoadmapItemDone(sessionId, itemId, summary),
        onUsage: ({ promptTokens, contextWindow }) => {
          const session = findSession();
          if (!session) return;
          session.contextUsed = promptTokens;
          session.contextWindow = contextWindow;
          this.emit.sessions(this.id);
        },
        onCost: (usd) => {
          const session = findSession();
          if (!session) return;
          session.costUsd = (session.costUsd ?? 0) + usd;
          this.emit.sessions(this.id);
        },
        onCompaction: () => {
          const session = findSession();
          if (!session) return;
          session.compactionCount = (session.compactionCount ?? 0) + 1;
          this.emit.sessions(this.id);
        },
        runShell: (requestId, command) =>
          rt.terminal.run(requestId, 'agent', command, (evt) => this.recordTerminal(evt)),
        getPermission: (category) => resolvePermission(category, this.autonomy),
        requestActionApproval: (category, description) =>
          this.isAlwaysAllowed(sessionId, category) ? Promise.resolve(true) : this.requestApproval(sessionId, description, category),
        getBashAllowlist: () => getCachedBashAllowlist(),
        requestSubagentCommandApproval: (command, label) => this.requestSubagentApproval(sessionId, command, label),
        applyEditAuto: (diff) => this.applyEditAuto(diff),
        getSessionCostUsd: () => findSession()?.costUsd ?? 0,
        postToBoard: (from, text, inReplyTo) => this.postToBoard(from, text, { inReplyTo }),
        readBoard: (sinceId, limit) => this.readBoard(sinceId, limit),
        askAndWait: (from, question, timeoutMinutes) => this.requestFocusAnswer(from, question, timeoutMinutes),
        fileBugReport: (report) => this.fileBugReport(report),
        startFocusAgent: (task, label, budgetMinutes) => this.startFocusAgent(task, label, budgetMinutes),
      }, rulesDir, false, findSession()?.title);
      const session = findSession();
      if (session) rt.agent.restoreHistory(session.messages);
    }
    return rt.agent;
  }

  recordTerminal(evt: TermDataEvent) {
    this.lineSeq += 1;
    const line = { ...evt, id: `${this.id}-line-${this.lineSeq}` };
    this.terminalLines.push(line);
    if (this.terminalLines.length > 1000) this.terminalLines.shift();
    this.emit.terminal(this.id, evt);
  }

  /** Always acts on whichever session is currently active — the renderer's composer only ever sends to the session it's displaying. */
  async sendToAgent(text: string, images?: ChatImage[]) {
    if (!this.activeSessionId) this.newSession();
    const sessionId = this.activeSessionId!;
    const session = this.sessions.find((s) => s.id === sessionId)!;

    const msg: ChatMessage = { role: 'user', text, images };
    session.chat.push(msg);
    // The first thing asked names the session.
    if (session.chat.filter((m) => m.role === 'user').length === 1) {
      session.title = titleFrom(text);
    }
    session.activity = [];
    session.updatedAt = Date.now();

    this.emit.message(this.id, sessionId, msg);
    this.emit.sessions(this.id);
    this.unseenCompletion = false;
    // Deliberately not awaited: the agent loop runs to completion in the
    // background so the user can switch sessions/tabs and come back to the result.
    void this.ensureAgent(sessionId).send(text, images);
  }

  /** Stops whichever session is currently active — same "acts on what's displayed" rule as sendToAgent. */
  stopAgent() {
    const sessionId = this.activeSessionId;
    if (!sessionId) return;
    const rt = this.runtimes.get(sessionId);
    rt?.agent?.stop();
    // A command stuck waiting on the Operator must not hang forever once the run itself is dead.
    if (rt) {
      for (const [, entry] of rt.pendingApprovals) entry.resolve(false);
      rt.pendingApprovals.clear();
    }
    this.flushSubagentApprovalsFor(sessionId);
  }

  markSeen() {
    this.unseenCompletion = false;
  }

  async runCommand(command: string) {
    const requestId = nextId('term');
    return this.terminal.run(requestId, 'you', command, (evt) => this.recordTerminal(evt));
  }

  dispose() {
    for (const rt of this.runtimes.values()) rt.agent?.stop();
    for (const rt of this.focusAgents.values()) rt.agent.stop();
    this.terminal.kill();
  }
}
