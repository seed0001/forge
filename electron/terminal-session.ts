import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import type { TermDataEvent } from './ipc-channels';
import { SECRET_SETTINGS_KEYS } from './ipc-channels';

/**
 * A spawned shell inherits process.env by default, which includes every
 * provider API key (loaded from forge/.env at startup). Nothing in Forge
 * legitimately needs those in a shelled-out command's environment — every
 * provider call is made directly via HTTP from the main process — so a
 * compromised renderer running terminal.run should not be able to pull them
 * out with `echo %OPENROUTER_API_KEY%`.
 */
function scrubbedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of SECRET_SETTINGS_KEYS) delete env[key];
  return env;
}

/**
 * Windows shells to try, in order, until one actually starts. `shell: true`
 * alone resolves via process.env.ComSpec (falling back to a bare 'cmd.exe'
 * looked up on PATH) with no fallback and no diagnostic if that resolution
 * is broken — this tries the well-known absolute System32 path too, since
 * that's correct even when ComSpec/PATH themselves are the problem.
 * Non-Windows platforms keep the single `true` (let Node pick /bin/sh).
 */
function candidateShells(): (string | boolean)[] {
  if (process.platform !== 'win32') return [true];
  const fromEnv = process.env.ComSpec;
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const hardcoded = path.join(systemRoot, 'System32', 'cmd.exe');
  const candidates = [fromEnv, hardcoded, 'cmd.exe'].filter((c): c is string => !!c);
  return Array.from(new Set(candidates));
}

type SpawnAttemptResult =
  | { ok: true; child: ChildProcessWithoutNullStreams; shellUsed: string | boolean }
  | { ok: false; error: NodeJS.ErrnoException; tried: (string | boolean)[] };

/**
 * Tries each shell candidate in turn, advancing only on ENOENT (any other
 * spawn error means the shell WAS found, so there's no point retrying a
 * different path). Uses the 'spawn' event — not just the absence of an
 * error — to know an attempt genuinely started.
 */
function spawnWithFallback(command: string, cwd: string): Promise<SpawnAttemptResult> {
  const candidates = candidateShells();
  return new Promise((resolve) => {
    function tryAt(i: number) {
      const shellOpt = candidates[i];
      const child = spawn(command, {
        shell: shellOpt,
        cwd,
        windowsHide: true,
        env: scrubbedEnv(),
      }) as ChildProcessWithoutNullStreams;
      let settled = false;
      child.once('spawn', () => {
        settled = true;
        resolve({ ok: true, child, shellUsed: shellOpt });
      });
      child.once('error', (err: NodeJS.ErrnoException) => {
        if (settled) return; // started fine; a later runtime error isn't a spawn failure
        if (err.code === 'ENOENT' && i + 1 < candidates.length) {
          tryAt(i + 1);
        } else {
          resolve({ ok: false, error: err, tried: candidates.slice(0, i + 1) });
        }
      });
    }
    tryAt(0);
  });
}

/**
 * One shell context per workspace. Each workspace keeps its own working
 * directory and its own in-flight child process, so a command running in one
 * workspace is unaffected by anything happening in another.
 */
export class TerminalSession {
  private cwd: string;
  private current: ChildProcessWithoutNullStreams | null = null;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  getCwd() {
    return this.cwd;
  }

  setCwd(next: string) {
    this.cwd = next;
  }

  kill() {
    if (this.current) {
      this.current.kill();
      this.current = null;
    }
  }

  async run(
    requestId: string,
    source: 'you' | 'agent',
    command: string,
    emit: (evt: TermDataEvent) => void
  ): Promise<{ exitCode: number; output: string }> {
    emit({ requestId, source, kind: 'cmd', text: command });

    const trimmed = command.trim();
    if (trimmed === 'cd' || trimmed.startsWith('cd ')) {
      const target = trimmed.slice(2).trim() || '.';
      this.cwd = path.resolve(this.cwd, target);
      emit({ requestId, source, kind: 'info', text: `cwd -> ${this.cwd}` });
      return { exitCode: 0, output: `cwd -> ${this.cwd}` };
    }

    // A cwd that no longer exists (a moved/deleted project folder) makes
    // spawn() fail with a bare, confusing ENOENT that looks identical to
    // "can't find the shell" — check explicitly so the real problem shows.
    if (!fs.existsSync(this.cwd)) {
      const text = `ERROR: working directory does not exist: ${this.cwd}`;
      emit({ requestId, source, kind: 'stderr', text });
      emit({ requestId, source, kind: 'exit', text: '1' });
      return { exitCode: 1, output: text };
    }

    const attempt = await spawnWithFallback(command, this.cwd);
    if (!attempt.ok) {
      const triedList = attempt.tried.map((s) => (s === true ? '(default shell)' : String(s))).join(', ');
      const code = attempt.error.code ? ` [${attempt.error.code}]` : '';
      const text = `ERROR: could not start a shell to run this command — tried: ${triedList} — ${attempt.error.message}${code}`;
      emit({ requestId, source, kind: 'stderr', text });
      emit({ requestId, source, kind: 'exit', text: '1' });
      return { exitCode: 1, output: text };
    }

    const { child } = attempt;
    this.current = child;
    let output = '';

    return new Promise((resolve) => {
      child.stdout.on('data', (buf) => {
        const text = buf.toString();
        output += text;
        emit({ requestId, source, kind: 'stdout', text });
      });
      child.stderr.on('data', (buf) => {
        const text = buf.toString();
        output += text;
        emit({ requestId, source, kind: 'stderr', text });
      });
      child.on('close', (code) => {
        this.current = null;
        emit({ requestId, source, kind: 'exit', text: String(code ?? 0) });
        resolve({ exitCode: code ?? 0, output });
      });
      child.on('error', (err) => {
        this.current = null;
        emit({ requestId, source, kind: 'stderr', text: String(err) });
        emit({ requestId, source, kind: 'exit', text: '1' });
        resolve({ exitCode: 1, output: String(err) });
      });
    });
  }
}
