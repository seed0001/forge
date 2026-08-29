import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { audit } from './audit-service';
import { SECRET_SETTINGS_KEYS } from './ipc-channels';
import type { ActivityEvent, TermDataEvent, ReasoningLevel } from './ipc-channels';

/**
 * Drives the OpenAI Codex CLI (`codex exec --json`) as a subprocess agent
 * provider. Unlike every other provider, Codex is not an HTTP chat-completions
 * endpoint — it runs its own tool loop, edits files on disk directly, and
 * streams JSONL events on stdout. This module owns the spawn, the event
 * parsing, and the mapping of those events onto Forge's activity/chat/usage
 * callbacks. See AgentSession.runCodexTurn for the caller.
 *
 * Auth is entirely the user's `codex login` (ChatGPT/Codex subscription,
 * ~/.codex/auth.json). Nothing is passed on the wire — and CODEX_API_KEY /
 * OPENAI_API_KEY are deliberately stripped from the child's environment so a
 * stray key can't silently switch billing to the pay-per-token API.
 */

const REASONING_EFFORT: Record<ReasoningLevel, 'low' | 'medium' | 'high'> = {
  flash: 'low',
  thinking: 'medium',
  deep: 'high',
};

let cachedBin: string | null | undefined;

/**
 * Resolves the Codex CLI binary: an explicit CODEX_BIN override, else `codex`
 * on PATH, else the default Windows install location. Returns null when none
 * works. Cached after the first successful resolution (a null result is not
 * cached, so installing Codex mid-session is picked up on the next attempt).
 */
export function resolveCodexBin(): string | null {
  if (cachedBin) return cachedBin;

  const override = (process.env.CODEX_BIN || '').trim();
  if (override) {
    if (fileRuns(override)) return (cachedBin = override);
    return null;
  }

  if (fileRuns('codex')) return (cachedBin = 'codex');

  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (local) {
      const guess = path.join(local, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
      if (fs.existsSync(guess) && fileRuns(guess)) return (cachedBin = guess);
    }
  }

  return null;
}

/** True if `<bin> --version` starts successfully and exits 0. */
function fileRuns(bin: string): boolean {
  try {
    const r = spawnSync(bin, ['--version'], { windowsHide: true, timeout: 10_000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

export interface CodexLoginStatus {
  ok: boolean;
  /** Human-readable detail for the UI — "Logged in using ChatGPT", "Not logged in", or why the check couldn't run. */
  detail: string;
}

/** Runs `codex login status`; `ok` is true only when stdout says "Logged in". */
export function codexLoginStatus(): CodexLoginStatus {
  const bin = resolveCodexBin();
  if (!bin) {
    return {
      ok: false,
      detail: 'Codex CLI not found — install it or set CODEX_BIN in Settings.',
    };
  }
  try {
    const r = spawnSync(bin, ['login', 'status'], {
      windowsHide: true,
      timeout: 15_000,
      encoding: 'utf8',
      env: codexEnv(),
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    if (/Logged in/i.test(out)) return { ok: true, detail: out.split('\n')[0] || 'Logged in' };
    return { ok: false, detail: out.split('\n')[0] || 'Not logged in — run `codex login` in a terminal.' };
  } catch (err) {
    return { ok: false, detail: `Could not run Codex CLI: ${(err as Error).message}` };
  }
}

/**
 * The child's environment: the main process env minus every provider
 * credential (same list terminal-session.ts scrubs) and, critically, minus
 * CODEX_API_KEY / OPENAI_API_KEY so Codex always uses the logged-in
 * subscription rather than falling through to API billing.
 */
function codexEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of SECRET_SETTINGS_KEYS) delete env[key];
  delete env.CODEX_API_KEY;
  delete env.OPENAI_API_KEY;
  return env;
}

export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface CodexTurnOptions {
  rootPath: string;
  prompt: string;
  /** Existing Codex thread id to resume, or null to start a fresh thread. */
  threadId: string | null;
  sandbox: CodexSandbox;
  /** Optional `--model`; falls back to the Codex config default when omitted. */
  model?: string;
  reasoning: ReasoningLevel;
  /** Aborted before/at spawn — resolve immediately without running anything. */
  isAborted: () => boolean;
  onThreadId: (id: string) => void;
  onActivity: (evt: ActivityEvent) => void;
  onTerminal: (evt: TermDataEvent) => void;
}

export interface CodexTurnResult {
  /** Concatenated assistant text across every agent_message item. */
  text: string;
  /** Set when Codex reported a fatal error instead of finishing normally. */
  error: string | null;
  promptTokens: number | null;
}

export interface CodexHandle {
  kill(): void;
}

let actSeq = 0;
const actId = () => `codex-act-${Date.now().toString(36)}-${actSeq++}`;

/**
 * Codex sometimes reports an error whose `message` is itself a JSON blob
 * (`{"type":"error","status":400,"error":{"message":"…"}}`). Unwrap the human
 * sentence out of it when that's the case.
 */
function cleanCodexError(raw: string | undefined): string {
  if (!raw) return '';
  const t = raw.trim();
  if (t.startsWith('{')) {
    try {
      const o = JSON.parse(t);
      const inner = o?.error?.message ?? o?.message;
      if (typeof inner === 'string' && inner.trim()) return inner.trim();
    } catch {
      /* not JSON after all */
    }
  }
  return t;
}

/**
 * Runs one Codex turn to completion. Returns a promise for the result plus a
 * synchronous handle whose kill() terminates the child (used by
 * AgentSession.stop()).
 */
export function runCodexTurn(opts: CodexTurnOptions): { done: Promise<CodexTurnResult>; handle: CodexHandle } {
  const bin = resolveCodexBin();
  let handle: CodexHandle = { kill: () => {} };

  const done = new Promise<CodexTurnResult>((resolve) => {
    if (!bin) {
      resolve({
        text: '',
        error: 'Codex CLI not found. Install it, or set CODEX_BIN in Settings, then try again.',
        promptTokens: null,
      });
      return;
    }
    if (opts.isAborted()) {
      resolve({ text: '', error: null, promptTokens: null });
      return;
    }

    const args = opts.threadId
      ? ['exec', 'resume', opts.threadId, '--json', '--skip-git-repo-check']
      : ['exec', '--json', '--skip-git-repo-check'];
    // 'default'/'' means "let Codex choose" — a subscription login rejects
    // explicit slugs, so only forward a real one.
    if (opts.model && opts.model !== 'default') args.push('-m', opts.model);
    // Sandbox is passed as a `-c` override rather than the `--sandbox` flag:
    // `--sandbox` is rejected outright by `exec resume`, and even on a fresh
    // thread the flag's value would be baked into the thread so a later
    // permission change couldn't take effect on resume. `-c sandbox_mode=…`
    // works on both paths and is re-applied every turn, so flipping the File
    // edits permission is honoured on the very next message.
    args.push('-c', `sandbox_mode="${opts.sandbox}"`);
    args.push('-c', `model_reasoning_effort="${REASONING_EFFORT[opts.reasoning]}"`, '-');

    void audit(
      opts.rootPath,
      'request',
      `codex ${opts.threadId ? 'resume' : 'exec'}${opts.model ? ` · ${opts.model}` : ''}`,
      `sandbox ${opts.sandbox} · effort ${REASONING_EFFORT[opts.reasoning]}`
    );

    const child = spawn(bin, args, {
      cwd: fs.existsSync(opts.rootPath) ? opts.rootPath : process.cwd(),
      env: codexEnv(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    handle = {
      kill: () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        if (process.platform === 'win32' && child.pid) {
          try {
            spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
            return;
          } catch {
            /* fall through */
          }
        }
        try {
          child.kill('SIGINT');
        } catch {
          /* already gone */
        }
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }, 2000);
      },
    };

    let settled = false;
    const finish = (r: CodexTurnResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    const textParts: string[] = [];
    let fatalError: string | null = null;
    let promptTokens: number | null = null;
    const activeCommands = new Map<string, string>(); // item id -> command string
    let stderrTail = '';

    child.stdin.write(opts.prompt);
    child.stdin.end();

    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) handleEvent(line);
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
    });

    child.on('error', (err) => {
      finish({ text: '', error: `Could not start Codex CLI: ${err.message}`, promptTokens: null });
    });

    child.on('close', (code) => {
      // Any command still marked active when the process ends — close it out.
      for (const [, cmd] of activeCommands) {
        opts.onActivity({ id: actId(), kind: 'run', detail: cmd, status: 'done' });
      }
      activeCommands.clear();

      const text = textParts.join('\n\n');
      if (fatalError) {
        finish({ text, error: fatalError, promptTokens });
        return;
      }
      if (code !== 0 && !settled) {
        const detail = stderrTail.trim().split('\n').slice(-3).join(' ') || `Codex CLI exited with code ${code}.`;
        finish({ text, error: detail, promptTokens });
        return;
      }
      finish({ text, error: null, promptTokens });
    });

    function handleEvent(line: string) {
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(line);
      } catch {
        return; // non-JSON progress line — ignore
      }
      const type = evt.type as string | undefined;

      if (type === 'thread.started') {
        const id = evt.thread_id as string | undefined;
        if (id) opts.onThreadId(id);
        return;
      }
      if (type === 'turn.started') {
        opts.onActivity({ id: actId(), kind: 'thinking', detail: 'Codex working…', status: 'active' });
        return;
      }
      if (type === 'error' || type === 'turn.failed') {
        const raw =
          (evt.message as string | undefined) ??
          ((evt.error as Record<string, unknown> | undefined)?.message as string | undefined);
        fatalError = cleanCodexError(raw) || 'Codex reported an unspecified error.';
        return;
      }
      if (type === 'turn.completed') {
        const usage = evt.usage as Record<string, unknown> | undefined;
        if (typeof usage?.input_tokens === 'number') promptTokens = usage.input_tokens as number;
        return;
      }

      const item = evt.item as Record<string, unknown> | undefined;
      if (!item) return;
      const itemType = item.type as string | undefined;
      const itemId = String(item.id ?? '');

      if (type === 'item.started' || type === 'item.updated') {
        if (itemType === 'command_execution') {
          const cmd = String(item.command ?? '').trim() || '(command)';
          if (!activeCommands.has(itemId)) {
            activeCommands.set(itemId, cmd);
            opts.onActivity({ id: actId(), kind: 'run', detail: cmd, status: 'active' });
          }
        }
        return;
      }

      if (type !== 'item.completed') return;

      switch (itemType) {
        case 'agent_message': {
          const t = String(item.text ?? '').trim();
          if (t) textParts.push(t);
          break;
        }
        case 'reasoning': {
          const first = String(item.text ?? '').split('\n').find((l) => l.trim());
          if (first) {
            opts.onActivity({ id: actId(), kind: 'thinking', detail: first.slice(0, 200), status: 'done' });
          }
          break;
        }
        case 'command_execution': {
          const cmd = activeCommands.get(itemId) || String(item.command ?? '').trim() || '(command)';
          activeCommands.delete(itemId);
          const exit = typeof item.exit_code === 'number' ? (item.exit_code as number) : 0;
          opts.onActivity({
            id: actId(),
            kind: 'run',
            detail: cmd,
            status: exit === 0 ? 'done' : 'error',
          });
          const out = String(item.aggregated_output ?? '').trim();
          if (out) {
            const rid = `codex-${itemId}`;
            opts.onTerminal({ requestId: rid, source: 'agent', kind: 'cmd', text: cmd });
            opts.onTerminal({ requestId: rid, source: 'agent', kind: 'stdout', text: out.slice(-4000) });
            opts.onTerminal({ requestId: rid, source: 'agent', kind: 'exit', text: String(exit) });
          }
          void audit(opts.rootPath, 'command', `\`${cmd}\``, `exit ${exit} (codex)`);
          break;
        }
        case 'file_change': {
          const changes = (item.changes as Array<Record<string, unknown>> | undefined) ?? [];
          for (const ch of changes) {
            const p = String(ch.path ?? ch.file ?? 'file');
            opts.onActivity({
              id: actId(),
              kind: 'propose',
              detail: `Codex edited ${p}`,
              status: 'done',
            });
            void audit(opts.rootPath, 'write', p, 'codex (written directly to disk)');
          }
          break;
        }
        case 'error': {
          // An item-level error is often just a warning (e.g. "defaulting to
          // fallback metadata") and the turn still completes — surface it, but
          // only a top-level `error` / `turn.failed` is actually fatal.
          const msg = cleanCodexError(item.message as string | undefined);
          if (msg) opts.onActivity({ id: actId(), kind: 'thinking', detail: msg.slice(0, 200), status: 'error' });
          break;
        }
      }

    }
  });

  return { done, handle: { kill: () => handle.kill() } };
}
