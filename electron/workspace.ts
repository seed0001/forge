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
    };
    this.sessions.unshift(session);
    this.activeSessionId = session.id;
    this.agent = null; // fresh conversation
    void this.persist();
    return summarize(session);
  }

  selectSession(sessionId: string): boolean {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) return false;
    this.activeSessionId = sessionId;
    // Rebuild the agent against this session's stored conversation.
    this.agent = null;
    this.ensureAgent().restoreHistory(session.messages);
    return true;
  }

  deleteSession(sessionId: string) {
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
