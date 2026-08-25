import path from 'node:path';
import { TerminalSession } from './terminal-session';
import { DiffStore, nextId } from './diff-store';
import { AgentSession } from './agent-service';
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
  Autonomy,
  RoadmapItem,
  RoadmapItemStatus,
} from './ipc-channels';

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
  /** A run_command call is waiting on the Operator at Manual autonomy. */
  commandApproval: (workspaceId: string, sessionId: string, requestId: string, command: string) => void;
  /** A session's whole roadmap, sent fresh on every change (propose/decide/edit/push-back/status). */
  roadmapUpdated: (workspaceId: string, sessionId: string, items: RoadmapItem[]) => void;
}

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
  pendingApprovals: Map<string, (approved: boolean) => void>;
  /** This session's OWN shell for agent-run commands — never shared with another session's concurrent command. */
  terminal: TerminalSession;
  activeRoadmapItemId: string | null;
  roadmapTurnSeq: number;
  pendingRoadmapRestart: RoadmapItem | null;
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

  /** Set when the agent finishes while the user is looking at another workspace. */
  unseenCompletion = false;
  /** How much this workspace's agents may do before they must stop and ask — shared across every session, since they all act on the same project on disk. */
  autonomy: Autonomy = 'balanced';

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
    this.sessions = await loadSessions(rootPath);
    this.activeSessionId = this.sessions[0]?.id ?? null;
    if (!this.activeSessionId) this.newSession();
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
    for (const [, resolve] of rt?.pendingApprovals ?? []) resolve(false);
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
    };
  }

  setAutonomy(level: Autonomy) {
    this.autonomy = level;
    this.emit.status(this.id);
  }

  /** Blocks until the Operator decides, or resolves false if that session's run is stopped first. */
  requestApproval(sessionId: string, command: string): Promise<boolean> {
    const requestId = nextId('appr');
    this.emit.commandApproval(this.id, sessionId, requestId, command);
    return new Promise((resolve) => {
      this.runtime(sessionId).pendingApprovals.set(requestId, resolve);
    });
  }

  /** requestId is globally unique, so no need to know which session it belongs to. */
  resolveApproval(requestId: string, approved: boolean) {
    for (const rt of this.runtimes.values()) {
      const resolve = rt.pendingApprovals.get(requestId);
      if (resolve) {
        rt.pendingApprovals.delete(requestId);
        resolve(approved);
        return;
      }
    }
  }

  /** Auto autonomy: accept every hunk immediately and write it, bypassing the review queue. */
  async applyEditAuto(diff: PendingDiff) {
    if (!this.rootPath) return;
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
        onMessage: (text, images) => {
          const msg: ChatMessage = { role: 'assistant', text, images };
          const session = findSession();
          session?.chat.push(msg);
          this.emit.message(this.id, sessionId, msg);

          // Name the session from its actual content, once, after the first
          // real exchange — never blocking the reply the user is reading.
          const isFirstReply = session && session.chat.filter((m) => m.role === 'assistant').length === 1;
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
        getAutonomy: () => this.autonomy,
        requestCommandApproval: (command) => this.requestApproval(sessionId, command),
        applyEditAuto: (diff) => this.applyEditAuto(diff),
      }, rulesDir);
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
      for (const [, resolve] of rt.pendingApprovals) resolve(false);
      rt.pendingApprovals.clear();
    }
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
    this.terminal.kill();
  }
}
