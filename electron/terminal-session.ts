import { spawn, spawnSync, ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import path from 'node:path';
import fs from 'node:fs';
import type { TermDataEvent } from './ipc-channels';
import { SECRET_SETTINGS_KEYS } from './ipc-channels';
import { isShellChained } from './perm-store';

// stdin is 'ignore' (see the spawn call), stdout/stderr are pipes.
type ShellChild = ChildProcessByStdio<null, Readable, Readable>;

/**
 * How long a single command may run before it's killed. Nobody is watching
 * this shell live to notice a command that never returns (an interactive
 * prompt with no one to answer it, a dev server, a wedged compile), and a
 * hung command leaves the agent's whole turn stuck on an await that never
 * settles. Five minutes is generous for a build or a test run; anything
 * longer is almost certainly stuck. Override with FORGE_COMMAND_TIMEOUT_MS
 * (e.g. in forge/.env) if a project has legitimately long builds.
 */
const COMMAND_TIMEOUT_MS = Number(process.env.FORGE_COMMAND_TIMEOUT_MS) || 5 * 60_000;

/** Ceiling on the retained output string, so a runaway command that prints
 * without end grows memory in the main process only up to this bound. The
 * model is shown just the tail anyway. */
const MAX_RETAINED_OUTPUT = 512 * 1024;

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
  // These commands run unattended — there is no one to answer a "[y/N]" or a
  // credential prompt, so a tool that blocks on one would hang until the
  // timeout every time. Nudge the common toolchains into non-interactive
  // behaviour: fail fast, or proceed with defaults.
  env.CI ??= '1';
  env.GIT_TERMINAL_PROMPT = '0';
  env.npm_config_yes = 'true';
  env.PIP_NO_INPUT = '1';
  env.DEBIAN_FRONTEND ??= 'noninteractive';
  return env;
}

/**
 * SIGTERM to a shell child on Windows kills only the cmd.exe wrapper — the
 * node/python/etc. process it spawned is reparented and keeps running
 * (holding ports, writing files). `taskkill /T` walks the whole tree.
 * Elsewhere a SIGKILL to the process is enough for our purposes.
 */
function killTree(child: ShellChild): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      return;
    } catch {
      // fall through to a plain kill
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // already gone
  }
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
  | { ok: true; child: ShellChild; shellUsed: string | boolean }
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
        // stdin from /dev/null (not an open pipe): a command that reads stdin
        // gets EOF immediately and moves on, instead of blocking forever
        // waiting for input that will never come.
        stdio: ['ignore', 'pipe', 'pipe'],
      }) as ShellChild;
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
  private current: ShellChild | null = null;

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
      killTree(this.current);
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
    // Only a bare `cd` — no shell operators — is handled here as a state
    // change to this.cwd. `cd build && cmake ..` is left for the real shell:
    // grabbing it here would treat "build && cmake .." as the path (a
    // guaranteed failure) and the chained command would never run.
    const isPlainCd =
      (trimmed === 'cd' || trimmed.startsWith('cd ')) && !isShellChained(trimmed);
    if (isPlainCd) {
      let target = trimmed.slice(2).trim();
      // `cd /d X:\path` is the cmd.exe idiom for switching drive *and*
      // directory in one go. The /d is meaningless to us (we always resolve
      // to an absolute path anyway), but if it isn't stripped it becomes
      // part of the "path" and path.resolve produces a junk directory that
      // exists nowhere — wedging every later command on the existence check
      // below. Drop a leading /d (any case) on Windows.
      if (process.platform === 'win32') target = target.replace(/^\/d\b\s*/i, '').trim();
      // A quoted path ("cd \"C:\\Program Files\"") arrives with the quotes
      // still attached once we bypass the real shell — strip one layer.
      if (
        target.length >= 2 &&
        ((target.startsWith('"') && target.endsWith('"')) ||
          (target.startsWith("'") && target.endsWith("'")))
      ) {
        target = target.slice(1, -1);
      }
      const next = path.resolve(this.cwd, target || '.');
      // Only commit the change if it lands on a real directory. A bad `cd`
      // should report an error and leave the shell usable, never poison
      // this.cwd so that every subsequent command fails.
      let isDir = false;
      try {
        isDir = fs.statSync(next).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) {
        const text = `ERROR: not a directory: ${next}`;
        emit({ requestId, source, kind: 'stderr', text });
        emit({ requestId, source, kind: 'exit', text: '1' });
        return { exitCode: 1, output: text };
      }
      this.cwd = next;
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
    let truncated = false;
    const record = (text: string) => {
      if (output.length >= MAX_RETAINED_OUTPUT) {
        truncated = true;
        return;
      }
      output += text;
      if (output.length > MAX_RETAINED_OUTPUT) {
        output = output.slice(0, MAX_RETAINED_OUTPUT);
        truncated = true;
      }
    };

    return new Promise((resolve) => {
      let settled = false;
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, COMMAND_TIMEOUT_MS);

      const finish = (result: { exitCode: number; output: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.current = null;
        resolve(result);
      };

      const finalOutput = () =>
        truncated
          ? `${output}\n[output truncated at ${Math.round(MAX_RETAINED_OUTPUT / 1024)} KB]`
          : output;

      child.stdout.on('data', (buf) => {
        const text = buf.toString();
        record(text);
        emit({ requestId, source, kind: 'stdout', text });
      });
      child.stderr.on('data', (buf) => {
        const text = buf.toString();
        record(text);
        emit({ requestId, source, kind: 'stderr', text });
      });
      child.on('close', (code) => {
        if (timedOut) {
          const text = `ERROR: command exceeded the ${Math.round(
            COMMAND_TIMEOUT_MS / 1000
          )}s time limit and was killed. If it was a long-running process (a server, a watcher), it should not be run this way.`;
          emit({ requestId, source, kind: 'stderr', text });
          emit({ requestId, source, kind: 'exit', text: '124' });
          finish({ exitCode: 124, output: `${finalOutput()}\n${text}` });
          return;
        }
        emit({ requestId, source, kind: 'exit', text: String(code ?? 0) });
        finish({ exitCode: code ?? 0, output: finalOutput() });
      });
      child.on('error', (err) => {
        emit({ requestId, source, kind: 'stderr', text: String(err) });
        emit({ requestId, source, kind: 'exit', text: '1' });
        finish({ exitCode: 1, output: String(err) });
      });
    });
  }
}
