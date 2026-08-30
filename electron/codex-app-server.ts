import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { applyPatch } from 'diff';
import { audit } from './audit-service';
import { computeHunks, countChanges } from './diff-service';
import { readFileSafe } from './fs-service';
import { nextId } from './diff-store';
import { resolveCodexBin, codexEnv, cleanCodexError } from './codex-runner';
import type { ActivityEvent, TermDataEvent, ReasoningLevel, PendingDiff, PermissionCategory, PermissionLevel } from './ipc-channels';

/**
 * Drives a single, persistent `codex app-server` JSON-RPC daemon (stdio,
 * newline-delimited JSON) shared by every workspace/session in this Forge
 * process — unlike the old `codex exec --json` transport, this protocol
 * genuinely pauses mid-turn and asks the caller for a decision before an
 * edit or command actually happens, which is what makes real per-action
 * approval possible at all. See COMPANION-ARCHITECTURE.md.
 *
 * IMPORTANT, confirmed empirically against Codex CLI 0.151.0 (not just from
 * docs): a thread's `sandbox` must be `read-only` for approval requests to
 * fire at all. Under `workspace-write`, Codex silently performs any action
 * the sandbox already permits — file writes and shell commands both run
 * with zero prompts, exactly like the sandbox itself and nothing else was
 * ever gating anything. Only `read-only` forces every mutating action to
 * hit the sandbox boundary first, at which point Codex offers to retry with
 * escalated permissions — an offer that surfaces to us as an approval
 * request (`item/fileChange/requestApproval` / `item/commandExecution/
 * requestApproval`). So every Codex thread this module starts is
 * `read-only`; there is no separate "workspace-write builder" sandbox any
 * more — Forge's own edit/bash permission levels (see project.ts's
 * resolvePermission) are what decide whether the bridge below auto-answers
 * or actually prompts the Operator.
 */

/** What a caller (AgentSession) supplies so this module can route Codex's approval requests into Forge's existing review/approval UI instead of inventing a new one. */
export interface CodexApprovalBridge {
  getPermission: (category: PermissionCategory) => PermissionLevel;
  /** The same yes/no popup run_command/git already use — see project.ts's requestApproval. */
  requestActionApproval: (category: PermissionCategory, description: string) => Promise<boolean>;
  /** Proposes a diff through the normal PendingDiff/ReviewOverlay path and resolves once every hunk is decided (auto-applied, or the Operator has answered). See project.ts's requestEditApproval. */
  requestEditApproval: (diff: PendingDiff) => Promise<PendingDiff>;
}

export interface CodexTurnOptions {
  rootPath: string;
  prompt: string;
  /** Existing Codex thread id to resume, or null to start a fresh thread. */
  threadId: string | null;
  /** Optional `model`; falls back to the Codex config default when omitted. */
  model?: string;
  reasoning: ReasoningLevel;
  /** Aborted before/at spawn — resolve immediately without running anything. */
  isAborted: () => boolean;
  onThreadId: (id: string) => void;
  onActivity: (evt: ActivityEvent) => void;
  onTerminal: (evt: TermDataEvent) => void;
  approvals: CodexApprovalBridge;
}

export interface CodexTurnResult {
  /** Concatenated assistant text across every agentMessage item. */
  text: string;
  /** Set when Codex reported a fatal error instead of finishing normally. */
  error: string | null;
  promptTokens: number | null;
}

export interface CodexHandle {
  kill(): void;
}

const REASONING_EFFORT: Record<ReasoningLevel, 'low' | 'medium' | 'high'> = {
  flash: 'low',
  thinking: 'medium',
  deep: 'high',
};

let actSeq = 0;
const actId = () => `codex-act-${Date.now().toString(36)}-${actSeq++}`;

interface RpcWaiter {
  resolve: (v: unknown) => void;
  reject: (err: Error) => void;
}

/** One file-change item Codex has told us about (via item/started), keyed by its item id, so the later approval request — which only carries the item id, not the diff itself — can look the content back up. */
interface TrackedFileChange {
  path: string;
  kind: string;
  diff: string;
}

/** Everything in flight for one active turn. */
interface TurnState {
  rootPath: string;
  onActivity: (evt: ActivityEvent) => void;
  onTerminal: (evt: TermDataEvent) => void;
  textParts: string[];
  fatalError: string | null;
  promptTokens: number | null;
  /** itemId -> command string, for commands still running when the turn ends. */
  activeCommands: Map<string, string>;
  /** itemId -> accumulated stdout, built from outputDelta notifications (the completed item's own aggregatedOutput field is unreliable — often null). */
  outputBuffers: Map<string, string>;
  settled: boolean;
  resolve: (r: CodexTurnResult) => void;
}

function legacyReviewDecision(approved: boolean, rejection = 'The Operator declined this.'): unknown {
  return approved ? 'approved' : { denied: { rejection } };
}

function modernDecision(approved: boolean): string {
  return approved ? 'accept' : 'decline';
}

/**
 * Builds a Forge PendingDiff from one Codex file-change entry, reusing the
 * exact same hunk-rendering path (`computeHunks`) as `propose_edit`/
 * `edit_file` — one diff-review UI regardless of source.
 *
 * Codex's `diff` field means something different per `kind`: for `add` it's
 * the raw new file content; for `update` it's a unified-diff HUNK BODY with
 * no `---`/`+++` header (confirmed empirically); for `delete` it's the raw
 * content being removed. `applyPatch` needs a synthetic header to accept an
 * update's hunk text.
 */
async function buildDiffFromChange(
  rootPath: string,
  absPath: string,
  kind: string,
  diffText: string
): Promise<PendingDiff> {
  const onDisk = await readFileSafe(rootPath, absPath);
  let oldContent: string;
  let newContent: string;
  if (kind === 'add') {
    oldContent = '';
    newContent = diffText;
  } else if (kind === 'delete') {
    oldContent = onDisk || diffText;
    newContent = '';
  } else {
    oldContent = onDisk;
    const patched = applyPatch(oldContent, `--- a\n+++ b\n${diffText}`);
    newContent = patched === false ? oldContent : patched;
  }
  const hunks = computeHunks(absPath, oldContent, newContent);
  const { added, removed } = countChanges(hunks);
  return { id: nextId('diff'), path: absPath, baseContent: oldContent, hunks, decisions: {}, added, removed };
}

/** True once every hunk in a resolved diff was accepted — the file-level accept/decline Codex's protocol expects, coarser than Forge's own per-hunk review. */
function diffFullyAccepted(diff: PendingDiff): boolean {
  return diff.hunks.length > 0 && diff.hunks.every((h) => diff.decisions[h.index] === 'accepted');
}

class CodexDaemon {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private nextReqId = 1;
  private pendingRpc = new Map<number, RpcWaiter>();
  private buf = '';
  /** threadId -> the approval bridge for whichever turn most recently ran on it. Re-registered on every runTurn call, so it always reflects the live caller. */
  private threadBridges = new Map<string, CodexApprovalBridge>();
  private threadRoots = new Map<string, string>();
  private fileChangeItems = new Map<string, TrackedFileChange[]>();
  private turns = new Map<string, TurnState>();

  private async ensureStarted(): Promise<void> {
    if (this.child) return;
    if (this.starting) return this.starting;
    this.starting = this.doStart();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async doStart(): Promise<void> {
    const bin = resolveCodexBin();
    if (!bin) {
      throw new Error('Codex CLI not found. Install it, or set CODEX_BIN in Settings, then try again.');
    }
    // shell: true on Windows because `bin` is usually the bare `codex` npm
    // shim (a .cmd) — spawning that directly without a shell fails outright
    // on this platform. `app-server` is a fixed literal, never interpolated,
    // so this carries none of the injection risk the option normally implies.
    const child = spawn(bin, ['app-server'], {
      env: codexEnv(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    this.child = child;
    this.buf = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onData(chunk));
    child.stderr.on('data', () => {
      /* Codex logs progress/debug noise to stderr; nothing actionable to surface here. */
    });
    child.on('exit', () => this.onExit());
    child.on('error', (err) => {
      this.failEverything(`Could not start Codex CLI: ${err.message}`);
    });

    await this.rpc('initialize', { clientInfo: { name: 'forge', version: '1' } });
  }

  private onExit() {
    this.child = null;
    this.failEverything('The Codex CLI process exited unexpectedly.');
  }

  /** The daemon died (or never started) — no in-flight RPC or turn can ever be answered, so settle them all rather than hang forever. */
  private failEverything(message: string) {
    for (const [, waiter] of this.pendingRpc) waiter.reject(new Error(message));
    this.pendingRpc.clear();
    for (const [, turn] of this.turns) {
      if (turn.settled) continue;
      turn.settled = true;
      turn.resolve({ text: turn.textParts.join('\n\n'), error: turn.fatalError ?? message, promptTokens: turn.promptTokens });
    }
    this.turns.clear();
  }

  private rpc<T = unknown>(method: string, params: unknown): Promise<T> {
    if (!this.child) return Promise.reject(new Error('Codex CLI is not running.'));
    const id = this.nextReqId++;
    const child = this.child;
    return new Promise<T>((resolve, reject) => {
      this.pendingRpc.set(id, { resolve: resolve as (v: unknown) => void, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  private respond(id: number, result: unknown) {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.handleLine(line);
    }
  }

  private handleLine(line: string) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // non-JSON noise — ignore
    }
    const method = msg.method as string | undefined;
    const id = msg.id as number | undefined;

    if (method && id != null) {
      void this.handleServerRequest(id, method, (msg.params ?? {}) as Record<string, unknown>);
      return;
    }
    if (method) {
      this.handleNotification(method, (msg.params ?? {}) as Record<string, unknown>);
      return;
    }
    if (id != null) {
      const waiter = this.pendingRpc.get(id);
      if (!waiter) return;
      this.pendingRpc.delete(id);
      if (msg.error) waiter.reject(new Error(((msg.error as Record<string, unknown>).message as string) || 'Codex app-server error'));
      else waiter.resolve(msg.result);
    }
  }

  /** Every server->client request Codex can send us that expects an answer. Never throws outward — any internal failure resolves to a safe "decline" so a bug here can't hang a live Codex turn forever. */
  private async handleServerRequest(id: number, method: string, params: Record<string, unknown>) {
    let result: unknown;
    try {
      result = await this.resolveServerRequest(method, params);
    } catch {
      result = this.declineShapeFor(method);
    }
    this.respond(id, result);
  }

  private declineShapeFor(method: string): unknown {
    if (method === 'applyPatchApproval' || method === 'execCommandApproval') return { decision: legacyReviewDecision(false) };
    if (method === 'item/permissions/requestApproval') return { permissions: {} };
    return { decision: 'decline' };
  }

  private async resolveServerRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const threadId = (params.threadId as string | undefined) ?? (params.conversationId as string | undefined);
    const bridge = threadId ? this.threadBridges.get(threadId) : undefined;
    const rootPath = threadId ? this.threadRoots.get(threadId) : undefined;

    switch (method) {
      case 'item/fileChange/requestApproval': {
        if (!bridge || !rootPath) return { decision: 'decline' };
        const itemId = params.itemId as string;
        const changes = this.fileChangeItems.get(itemId) ?? [];
        this.fileChangeItems.delete(itemId); // consumed — don't hold every edit's diff text for the life of the process
        if (!changes.length) return { decision: 'decline' };
        const diffs = await Promise.all(changes.map((c) => buildDiffFromChange(rootPath, c.path, c.kind, c.diff)));
        const resolved = await Promise.all(diffs.map((d) => bridge.requestEditApproval(d)));
        const allAccepted = resolved.every(diffFullyAccepted);
        return { decision: modernDecision(allAccepted) };
      }
      case 'applyPatchApproval': {
        if (!bridge || !rootPath) return { decision: legacyReviewDecision(false) };
        const fileChanges = (params.fileChanges as Record<string, { type: string; content?: string; unified_diff?: string }>) ?? {};
        const entries = Object.entries(fileChanges);
        if (!entries.length) return { decision: legacyReviewDecision(false) };
        const diffs = await Promise.all(
          entries.map(([p, fc]) => buildDiffFromChange(rootPath, p, fc.type, fc.unified_diff ?? fc.content ?? ''))
        );
        const resolved = await Promise.all(diffs.map((d) => bridge.requestEditApproval(d)));
        const allAccepted = resolved.every(diffFullyAccepted);
        return { decision: legacyReviewDecision(allAccepted) };
      }
      case 'item/commandExecution/requestApproval': {
        if (!bridge) return { decision: 'decline' };
        const desc = (params.command as string | undefined) || (params.reason as string | undefined) || 'a command';
        const approved = await bridge.requestActionApproval('bash', desc);
        return { decision: modernDecision(approved) };
      }
      case 'execCommandApproval': {
        if (!bridge) return { decision: legacyReviewDecision(false) };
        const cmdArr = params.command as string[] | undefined;
        const desc = Array.isArray(cmdArr) ? cmdArr.join(' ') : (params.reason as string | undefined) || 'a command';
        const approved = await bridge.requestActionApproval('bash', desc);
        return { decision: legacyReviewDecision(approved) };
      }
      case 'item/permissions/requestApproval': {
        if (!bridge) return { permissions: {} };
        const reason = (params.reason as string | undefined) || 'broader file/network access';
        const approved = await bridge.requestActionApproval('edit', reason);
        return approved ? { permissions: params.permissions ?? {}, scope: 'turn' } : { permissions: {} };
      }
      default:
        return {};
    }
  }

  private handleNotification(method: string, params: Record<string, unknown>) {
    if (method === 'item/started' && (params.item as Record<string, unknown> | undefined)?.type === 'fileChange') {
      const item = params.item as { id: string; changes?: Array<{ path: string; kind: { type: string }; diff: string }> };
      this.fileChangeItems.set(
        item.id,
        (item.changes ?? []).map((c) => ({ path: c.path, kind: c.kind.type, diff: c.diff }))
      );
    }

    // Most notifications carry a flat `turnId`; `turn/completed` (and
    // `turn/started`, unused here) instead nest it at `turn.id` — confirmed
    // empirically, not documented in the JSON Schema's property list.
    const turnId = (params.turnId as string | undefined) ?? ((params.turn as Record<string, unknown> | undefined)?.id as string | undefined);
    const turn = turnId ? this.turns.get(turnId) : undefined;

    switch (method) {
      case 'item/commandExecution/outputDelta': {
        if (!turn) return;
        const itemId = params.itemId as string;
        const delta = (params.delta as string) ?? '';
        turn.outputBuffers.set(itemId, (turn.outputBuffers.get(itemId) ?? '') + delta);
        return;
      }
      case 'item/started': {
        if (!turn) return;
        const item = params.item as Record<string, unknown>;
        if (item.type === 'commandExecution') {
          const itemId = item.id as string;
          const cmd = String(item.command ?? '').trim() || '(command)';
          turn.activeCommands.set(itemId, cmd);
          turn.onActivity({ id: actId(), kind: 'run', detail: cmd, status: 'active' });
        }
        return;
      }
      case 'item/completed': {
        if (!turn) return;
        const item = params.item as Record<string, unknown>;
        const itemType = item.type as string;
        if (itemType === 'agentMessage') {
          const t = String(item.text ?? '').trim();
          if (t && item.phase !== 'commentary') turn.textParts.push(t);
          return;
        }
        if (itemType === 'reasoning') {
          const first = String(item.text ?? '')
            .split('\n')
            .find((l) => l.trim());
          if (first) turn.onActivity({ id: actId(), kind: 'thinking', detail: first.slice(0, 200), status: 'done' });
          return;
        }
        if (itemType === 'commandExecution') {
          const itemId = item.id as string;
          const cmd = turn.activeCommands.get(itemId) || String(item.command ?? '').trim() || '(command)';
          turn.activeCommands.delete(itemId);
          const exit = typeof item.exitCode === 'number' ? (item.exitCode as number) : 0;
          turn.onActivity({ id: actId(), kind: 'run', detail: cmd, status: exit === 0 ? 'done' : 'error' });
          const out = (turn.outputBuffers.get(itemId) ?? String(item.aggregatedOutput ?? '')).trim();
          turn.outputBuffers.delete(itemId);
          if (out) {
            const rid = `codex-${itemId}`;
            turn.onTerminal({ requestId: rid, source: 'agent', kind: 'cmd', text: cmd });
            turn.onTerminal({ requestId: rid, source: 'agent', kind: 'stdout', text: out.slice(-4000) });
            turn.onTerminal({ requestId: rid, source: 'agent', kind: 'exit', text: String(exit) });
          }
          void audit(turn.rootPath, 'command', `\`${cmd}\``, `exit ${exit} (codex)`);
          return;
        }
        if (itemType === 'fileChange') {
          const changes = (item.changes as Array<{ path: string }> | undefined) ?? [];
          for (const ch of changes) {
            turn.onActivity({ id: actId(), kind: 'propose', detail: `Codex edited ${ch.path}`, status: 'done' });
          }
          return;
        }
        return;
      }
      case 'turn/completed': {
        if (!turn) return;
        const turnObj = params.turn as Record<string, unknown>;
        const usage = params.tokenUsage as Record<string, unknown> | undefined; // not always present on this notification
        if (usage) {
          const total = usage.total as Record<string, unknown> | undefined;
          if (typeof total?.inputTokens === 'number') turn.promptTokens = total.inputTokens as number;
        }
        if (turnObj?.status === 'failed') {
          const err = turnObj.error as Record<string, unknown> | undefined;
          turn.fatalError = cleanCodexError((err?.message as string) || 'Codex reported an unspecified error.');
        }
        this.finishTurn(turnId!, turn);
        return;
      }
      case 'thread/tokenUsage/updated': {
        if (!turn) return;
        const usage = params.tokenUsage as Record<string, unknown> | undefined;
        const total = usage?.total as Record<string, unknown> | undefined;
        if (typeof total?.inputTokens === 'number') turn.promptTokens = total.inputTokens as number;
        return;
      }
      case 'error': {
        // A connection-level error notification, not necessarily tied to a
        // single turn — best effort: attach it to every turn still running.
        const message = (params.message as string | undefined) || 'Codex reported an unspecified error.';
        for (const [tid, t] of this.turns) {
          if (t.settled) continue;
          t.fatalError = cleanCodexError(message);
          this.finishTurn(tid, t);
        }
        return;
      }
      default:
        return;
    }
  }

  private finishTurn(turnId: string, turn: TurnState) {
    if (turn.settled) return;
    turn.settled = true;
    for (const [, cmd] of turn.activeCommands) {
      turn.onActivity({ id: actId(), kind: 'run', detail: cmd, status: 'done' });
    }
    turn.activeCommands.clear();
    this.turns.delete(turnId);
    turn.resolve({ text: turn.textParts.join('\n\n'), error: turn.fatalError, promptTokens: turn.promptTokens });
  }

  async runTurn(opts: CodexTurnOptions): Promise<{ done: Promise<CodexTurnResult>; handle: CodexHandle }> {
    if (opts.isAborted()) {
      return { done: Promise.resolve({ text: '', error: null, promptTokens: null }), handle: { kill: () => {} } };
    }

    try {
      await this.ensureStarted();
    } catch (err) {
      return {
        done: Promise.resolve({ text: '', error: (err as Error).message, promptTokens: null }),
        handle: { kill: () => {} },
      };
    }

    let threadId = opts.threadId;
    try {
      if (threadId) {
        const res = await this.rpc<{ thread: { id: string } }>('thread/resume', {
          threadId,
          cwd: opts.rootPath,
          sandbox: 'read-only',
          approvalPolicy: 'on-request',
          approvalsReviewer: 'user',
          model: opts.model && opts.model !== 'default' ? opts.model : undefined,
        });
        threadId = res.thread.id;
      } else {
        const res = await this.rpc<{ thread: { id: string } }>('thread/start', {
          cwd: opts.rootPath,
          sandbox: 'read-only',
          approvalPolicy: 'on-request',
          approvalsReviewer: 'user',
          model: opts.model && opts.model !== 'default' ? opts.model : undefined,
        });
        threadId = res.thread.id;
      }
    } catch (err) {
      return {
        done: Promise.resolve({ text: '', error: `Could not start a Codex thread: ${(err as Error).message}`, promptTokens: null }),
        handle: { kill: () => {} },
      };
    }

    opts.onThreadId(threadId);
    this.threadBridges.set(threadId, opts.approvals);
    this.threadRoots.set(threadId, opts.rootPath);

    void audit(opts.rootPath, 'request', `codex ${opts.threadId ? 'resume' : 'start'}${opts.model ? ` · ${opts.model}` : ''}`, `read-only + on-request approval · effort ${REASONING_EFFORT[opts.reasoning]}`);

    let turnId: string | null = null;
    const done = new Promise<CodexTurnResult>((resolve) => {
      const turn: TurnState = {
        rootPath: opts.rootPath,
        onActivity: opts.onActivity,
        onTerminal: opts.onTerminal,
        textParts: [],
        fatalError: null,
        promptTokens: null,
        activeCommands: new Map(),
        outputBuffers: new Map(),
        settled: false,
        resolve,
      };

      this.rpc<{ turn: { id: string } }>('turn/start', {
        threadId,
        input: [{ type: 'text', text: opts.prompt }],
        effort: REASONING_EFFORT[opts.reasoning],
      })
        .then((res) => {
          turnId = res.turn.id;
          this.turns.set(turnId, turn);
          if (opts.isAborted()) this.interrupt(threadId as string, turnId);
        })
        .catch((err) => {
          turn.settled = true;
          resolve({ text: '', error: `Could not start a Codex turn: ${(err as Error).message}`, promptTokens: null });
        });
    });

    const handle: CodexHandle = {
      kill: () => {
        if (turnId) this.interrupt(threadId as string, turnId);
      },
    };

    return { done, handle };
  }

  private interrupt(threadId: string, turnId: string) {
    void this.rpc('turn/interrupt', { threadId, turnId }).catch(() => {
      /* best effort — if this fails the turn will still settle on its own eventually */
    });
  }
}

const daemon = new CodexDaemon();

/**
 * Runs one Codex turn to completion on the shared app-server daemon. Returns
 * a promise for the result plus a synchronous-ish handle whose kill() sends
 * turn/interrupt (used by AgentSession.stop()).
 */
export function runCodexTurn(opts: CodexTurnOptions): { done: Promise<CodexTurnResult>; handle: CodexHandle } {
  let handle: CodexHandle = { kill: () => {} };
  const done = daemon.runTurn(opts).then((r) => {
    handle.kill = r.handle.kill;
    return r.done;
  });
  // Give callers a handle they can call kill() on immediately, even before
  // runTurn's internal setup (thread start, turn/start) has resolved — it
  // just forwards to whatever handle.kill ends up being once that settles.
  const forwardingHandle: CodexHandle = {
    kill: () => handle.kill(),
  };
  return { done, handle: forwardingHandle };
}
