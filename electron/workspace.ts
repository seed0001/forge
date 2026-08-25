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
  activity: (workspaceId: string, evt: ActivityEvent) => void;
  message: (workspaceId: string, msg: ChatMessage) => void;
  status: (workspaceId: string) => void;
  diffProposed: (workspaceId: string, diff: PendingDiff) => void;
  /** A diff was applied (or otherwise settled) outside the normal decide-in-UI path. */
  diffUpdated: (workspaceId: string, diff: PendingDiff) => void;
  /** The session list changed — new session, rename, or a saved update. */
  sessions: (workspaceId: string) => void;
  /** A run_command call is waiting on the Operator at Manual autonomy. */
  commandApproval: (workspaceId: string, requestId: string, command: string) => void;
  /** The active session's whole roadmap, sent fresh on every change (propose/decide/edit/push-back/status). */
  roadmapUpdated: (workspaceId: string, sessionId: string, items: RoadmapItem[]) => void;
}

/**
 * A workspace is a self-contained unit of work: its own folder, terminal,
 * agent conversation and review queue.
 *
 * Everything here lives in the main process and is driven by the agent loop, so
 * a task keeps running after the user switches to a different workspace tab or
 * the renderer stops listening. The renderer is a view onto this state, never
 * its owner.
 */
export class Workspace {
  readonly id: string;
  name: string;
  rootPath: string | null;

  readonly terminal: TerminalSession;
  readonly diffs: DiffStore;
  private agent: AgentSession | null = null;

  /** Terminal is workspace-wide; chat and activity belong to the active session. */
  terminalLines: (TermDataEvent & { id: string })[] = [];

  private sessions: Session[] = [];
  private activeSessionId: string | null = null;
  private sessionSeq = 0;

  agentRunning = false;
  /** Set when the agent finishes while the user is looking at another workspace. */
  unseenCompletion = false;
  /** How much this workspace's agent may do before it must stop and ask. Defaults to today's behavior. */
  autonomy: Autonomy = 'balanced';

  private emit: WorkspaceEmit;
  private lineSeq = 0;
  private pendingApprovals = new Map<string, (approved: boolean) => void>();
  /** When the current agent run began, so its wall-clock duration can be folded into the session's total on completion. */
  private runStartedAt: number | null = null;
  /** Id of the roadmap item currently being worked on, if any — at most one at a time. */
  private activeRoadmapItemId: string | null = null;
  /**
   * Bumped every time a roadmap-item turn (re)starts. A push-back bumps this
   * BEFORE aborting the old turn, so the old turn's now-stale `.then()`
   * continuation (which can only run later, since abort() rejects the fetch
   * asynchronously) recognizes it's been superseded and does nothing.
   */
  private roadmapTurnSeq = 0;
  /** Set by pushBackRoadmapItem while waiting for the old turn to actually finish unwinding before restarting it. */
  private pendingRoadmapRestart: RoadmapItem | null = null;

  constructor(id: string, name: string, rootPath: string | null, emit: WorkspaceEmit) {
    this.id = id;
    this.name = name;
    this.rootPath = rootPath;
    this.emit = emit;
    this.terminal = new TerminalSession(rootPath ?? process.cwd());
    this.diffs = new DiffStore();
  }

  async setRoot(rootPath: string) {
    this.rootPath = rootPath;
    this.name = path.basename(rootPath);
    this.terminal.setCwd(rootPath);
    this.agent?.setRoot(rootPath);
    // Sessions are keyed to the folder, so opening a new one swaps the history.
    this.agent = null;
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
   * Switching sessions rebuilds `this.agent` from scratch (see selectSession/
   * newSession below) — doing that while a turn is still in flight would
   * orphan the running AgentSession's callbacks: they close over
   * `this.activeSession`, a live getter, so they'd keep firing and write
   * into whatever session is now active instead of the one they belong to.
   * Background roadmap execution makes this a routine scenario, not a rare
   * one, so every session mutator refuses while `agentRunning` is true.
   */
  newSession(): SessionSummary | null {
    if (this.agentRunning) return null;
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
    this.agent = null; // fresh conversation
    void this.persist();
    return summarize(session);
  }

  selectSession(sessionId: string): boolean {
    if (this.agentRunning) return false;
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) return false;
    this.activeSessionId = sessionId;
    // Rebuild the agent against this session's stored conversation.
    this.agent = null;
    this.ensureAgent().restoreHistory(session.messages);
    return true;
  }

  deleteSession(sessionId: string) {
    if (this.agentRunning && sessionId === this.activeSessionId) return;
    this.sessions = this.sessions.filter((s) => s.id !== sessionId);
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = this.sessions[0]?.id ?? null;
      this.agent = null;
      if (!this.activeSessionId) this.newSession();
      else this.selectSession(this.activeSessionId);
    }
    void this.persist();
  }

  async restoreSessions() {
    this.sessions = await loadSessions(this.rootPath);
    this.activeSessionId = this.sessions[0]?.id ?? null;
    if (!this.activeSessionId) this.newSession();
    else this.selectSession(this.activeSessionId);
  }

  private async persist() {
    const session = this.activeSession;
    if (session && this.agent) {
      session.messages = this.agent.exportHistory();
      session.updatedAt = Date.now();
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
    };
  }

  setAutonomy(level: Autonomy) {
    this.autonomy = level;
    this.emit.status(this.id);
  }

  /** Blocks until the Operator decides, or resolves false if the run is stopped first. */
  requestApproval(command: string): Promise<boolean> {
    const requestId = nextId('appr');
    this.emit.commandApproval(this.id, requestId, command);
    return new Promise((resolve) => {
      this.pendingApprovals.set(requestId, resolve);
    });
  }

  resolveApproval(requestId: string, approved: boolean) {
    const resolve = this.pendingApprovals.get(requestId);
    if (!resolve) return;
    this.pendingApprovals.delete(requestId);
    resolve(approved);
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
   * happened. Call this once a review batch empties out; if the agent is
   * sitting idle because of it, this is what wakes it back up. A no-op if
   * the agent is already running (e.g. Auto autonomy, which settles diffs
   * mid-turn without ever leaving the loop).
   */
  resumeAfterReview() {
    if (this.agentRunning || !this.activeSession) return;
    void this.ensureAgent().send(
      "The Operator has finished reviewing your proposed edits. Some may have been accepted, " +
        'some rejected, or edited before accepting — do not assume the outcome. Check the files ' +
        'that matter with read_file, then continue the task.'
    );
  }

  // ── Roadmap ──────────────────────────────────────────────────────────────

  private findRoadmapItem(itemId: string): RoadmapItem | undefined {
    return this.activeSession?.roadmap.find((it) => it.id === itemId);
  }

  private emitRoadmap() {
    if (!this.activeSession) return;
    this.emit.roadmapUpdated(this.id, this.activeSession.id, this.activeSession.roadmap);
  }

  /** propose_roadmap replaces the active session's whole roadmap. */
  proposeRoadmap(items: RoadmapItem[]) {
    const session = this.activeSession;
    if (!session) return;
    session.roadmap = items;
    void this.persist();
    this.emitRoadmap();
  }

  decideRoadmapItem(itemId: string, decision: 'approve' | 'reject') {
    const item = this.findRoadmapItem(itemId);
    if (!item) return;
    item.status = decision === 'approve' ? 'approved' : 'rejected';
    void this.persist();
    this.emitRoadmap();
    this.maybeAdvanceRoadmap();
  }

  /** Text-only edit — never touches status or interrupts a running turn. */
  editRoadmapItem(itemId: string, patch: { title?: string; summary?: string; detail?: string }) {
    const item = this.findRoadmapItem(itemId);
    if (!item) return;
    if (patch.title !== undefined) item.title = patch.title;
    if (patch.summary !== undefined) item.summary = patch.summary;
    if (patch.detail !== undefined) item.detail = patch.detail;
    void this.persist();
    this.emitRoadmap();
  }

  /** Allowed manual status transitions the UI offers (revert/reopen/restore) — always back to 'pending'. */
  setRoadmapItemStatus(itemId: string, status: RoadmapItemStatus) {
    const item = this.findRoadmapItem(itemId);
    if (!item || item.status === 'in_progress') return; // never touch a running item this way — use pushBack
    item.status = status;
    void this.persist();
    this.emitRoadmap();
    if (status === 'approved') this.maybeAdvanceRoadmap();
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
    const item = this.findRoadmapItem(itemId);
    if (!item) return;
    item.detail = newDetail;
    if (item.status !== 'in_progress') {
      void this.persist();
      this.emitRoadmap();
      return;
    }
    this.roadmapTurnSeq++;
    this.pendingRoadmapRestart = item;
    item.status = 'approved'; // reflect "queued to restart", not stuck in_progress
    void this.persist();
    this.emitRoadmap();
    this.agent?.stop();
  }

  /** No-op if a turn is already active, or nothing is approved and waiting. */
  private maybeAdvanceRoadmap() {
    if (this.activeRoadmapItemId) return;
    const roadmap = this.activeSession?.roadmap;
    if (!roadmap?.length) return;
    const next = roadmap.filter((it) => it.status === 'approved').sort((a, b) => a.order - b.order)[0];
    if (next) this.startRoadmapTurn(next);
  }

  private startRoadmapTurn(item: RoadmapItem) {
    item.status = 'in_progress';
    item.notes = undefined; // clear any stale needs_revision/done note from a prior attempt
    void this.persist();
    this.emitRoadmap();
    this.trackRoadmapActivity(`Started roadmap item: "${item.title}"`);

    this.activeRoadmapItemId = item.id;
    const seq = ++this.roadmapTurnSeq;
    void this.ensureAgent()
      .send(this.buildRoadmapItemPrompt(item))
      .then(() => {
        if (seq !== this.roadmapTurnSeq) {
          // Superseded by a push-back. This firing is the actual proof that
          // send() has returned on this AgentSession — only now is it safe
          // to call it again, so this is what starts the restart, not
          // pushBackRoadmapItem itself.
          const restart = this.pendingRoadmapRestart;
          this.pendingRoadmapRestart = null;
          this.activeRoadmapItemId = null;
          // Only restart if it's still queued for it — the Operator may have
          // rejected it (or otherwise changed its status) while we waited for
          // this old turn to actually finish unwinding.
          if (restart && restart.status === 'approved') this.startRoadmapTurn(restart);
          else this.maybeAdvanceRoadmap();
          return;
        }
        this.activeRoadmapItemId = null;
        this.onRoadmapTurnEndedFor(item.id);
      });
  }

  /** The AgentCallbacks hook for complete_roadmap_item — must answer synchronously so the model learns right away if it failed. */
  onRoadmapItemDone(itemId: string, summary: string): { ok: boolean; error?: string } {
    const item = this.findRoadmapItem(itemId);
    if (!item) return { ok: false, error: `No roadmap item with id "${itemId}".` };
    if (item.status !== 'in_progress') {
      return { ok: false, error: `Roadmap item "${itemId}" is not in progress (status: ${item.status}).` };
    }
    item.status = 'done';
    item.notes = summary;
    void this.persist();
    this.emitRoadmap();
    // Do NOT advance here — the turn (send()) is still running; startRoadmapTurn's
    // .then() calls onRoadmapTurnEndedFor once it actually finishes, which advances.
    return { ok: true };
  }

  private onRoadmapTurnEndedFor(itemId: string) {
    const item = this.findRoadmapItem(itemId);
    if (!item) return;
    if (item.status === 'in_progress') {
      // The turn ended (naturally, or hit the turn limit) without the agent
      // ever calling complete_roadmap_item — flag it rather than silently
      // advancing past unfinished work.
      item.status = 'needs_revision';
      item.notes = "The agent's turn ended without marking this item done — review needed.";
      void this.persist();
      this.emitRoadmap();
      return;
    }
    // status is 'done' (via complete_roadmap_item) — keep the queue moving.
    this.maybeAdvanceRoadmap();
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

  private trackRoadmapActivity(detail: string) {
    const session = this.activeSession;
    if (!session) return;
    const evt: ActivityEvent = { id: nextId('act'), kind: 'roadmap', detail, status: 'done' };
    session.activity.push(evt);
    this.emit.activity(this.id, evt);
  }

  private ensureAgent(): AgentSession {
    if (!this.agent) {
      const rulesDir = process.env.RULES_DIR?.trim() || null;
      this.agent = new AgentSession(this.rootPath ?? process.cwd(), {
        onActivity: (evt) => {
          const session = this.activeSession;
          if (session) {
            const existing = session.activity.findIndex((a) => a.id === evt.id);
            if (existing >= 0) session.activity[existing] = evt;
            else session.activity.push(evt);
            if (session.activity.length > 200) session.activity.shift();
          }
          this.emit.activity(this.id, evt);
        },
        onTerminal: (evt) => this.recordTerminal(evt),
        onMessage: (text, images) => {
          const msg: ChatMessage = { role: 'assistant', text, images };
          const session = this.activeSession;
          session?.chat.push(msg);
          this.emit.message(this.id, msg);

          // Name the session from its actual content, once, after the first
          // real exchange — never blocking the reply the user is reading.
          const isFirstReply = session && session.chat.filter((m) => m.role === 'assistant').length === 1;
          if (session && isFirstReply && !session.titled) {
            const sessionId = session.id;
            void this.agent!.generateTitle().then((title) => {
              const target = this.sessions.find((s) => s.id === sessionId);
              if (!target || target.titled) return;
              target.titled = true;
              if (title) target.title = title;
              void this.persist();
              this.emit.sessions(this.id);
            });
          }
        },
        onStatus: (running) => {
          const session = this.activeSession;
          if (running) {
            this.runStartedAt = Date.now();
          } else if (this.runStartedAt !== null) {
            if (session) session.elapsedMs = (session.elapsedMs ?? 0) + (Date.now() - this.runStartedAt);
            this.runStartedAt = null;
          }
          this.agentRunning = running;
          if (!running) {
            this.unseenCompletion = true;
            // Checkpoint the conversation whenever the agent goes quiet.
            void this.persist().then(() => this.emit.sessions(this.id));
          }
          this.emit.status(this.id);
        },
        onDiffProposed: (diff) => {
          this.diffs.add(diff);
          this.emit.diffProposed(this.id, diff);
          this.emit.status(this.id);
        },
        onRoadmapProposed: (items) => this.proposeRoadmap(items),
        onRoadmapItemDone: (itemId, summary) => this.onRoadmapItemDone(itemId, summary),
        onUsage: ({ promptTokens, contextWindow }) => {
          const session = this.activeSession;
          if (!session) return;
          session.contextUsed = promptTokens;
          session.contextWindow = contextWindow;
          this.emit.sessions(this.id);
        },
        onCost: (usd) => {
          const session = this.activeSession;
          if (!session) return;
          session.costUsd = (session.costUsd ?? 0) + usd;
          this.emit.sessions(this.id);
        },
        onCompaction: () => {
          const session = this.activeSession;
          if (!session) return;
          session.compactionCount = (session.compactionCount ?? 0) + 1;
          this.emit.sessions(this.id);
        },
        runShell: (requestId, command) =>
          this.terminal.run(requestId, 'agent', command, (evt) => this.recordTerminal(evt)),
        getAutonomy: () => this.autonomy,
        requestCommandApproval: (command) => this.requestApproval(command),
        applyEditAuto: (diff) => this.applyEditAuto(diff),
      }, rulesDir);
    }
    return this.agent;
  }

  recordTerminal(evt: TermDataEvent) {
    this.lineSeq += 1;
    const line = { ...evt, id: `${this.id}-line-${this.lineSeq}` };
    this.terminalLines.push(line);
    if (this.terminalLines.length > 1000) this.terminalLines.shift();
    this.emit.terminal(this.id, evt);
  }

  async sendToAgent(text: string, images?: ChatImage[]) {
    if (!this.activeSession) this.newSession();
    const session = this.activeSession!;

    const msg: ChatMessage = { role: 'user', text, images };
    session.chat.push(msg);
    // The first thing asked names the session.
    if (session.chat.filter((m) => m.role === 'user').length === 1) {
      session.title = titleFrom(text);
    }
    session.activity = [];
    session.updatedAt = Date.now();

    this.emit.message(this.id, msg);
    this.emit.sessions(this.id);
    this.unseenCompletion = false;
    // Deliberately not awaited: the agent loop runs to completion in the
    // background so the user can switch tabs and come back to the result.
    void this.ensureAgent().send(text, images);
  }

  stopAgent() {
    this.agent?.stop();
    // A command stuck waiting on the Operator must not hang forever once the run itself is dead.
    for (const [requestId, resolve] of this.pendingApprovals) {
      resolve(false);
      this.pendingApprovals.delete(requestId);
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
    this.agent?.stop();
    this.terminal.kill();
  }
}
