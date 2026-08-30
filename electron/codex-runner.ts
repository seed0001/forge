import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { SECRET_SETTINGS_KEYS } from './ipc-channels';

/**
 * Shared low-level Codex CLI infrastructure: locating the binary and checking
 * login status. The actual turn-execution transport lives in
 * `codex-app-server.ts` (a persistent `codex app-server` JSON-RPC connection)
 * — this file no longer drives `codex exec` directly.
 */

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
export function codexEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of SECRET_SETTINGS_KEYS) delete env[key];
  delete env.CODEX_API_KEY;
  delete env.OPENAI_API_KEY;
  return env;
}

/**
 * Codex sometimes reports an error whose `message` is itself a JSON blob
 * (`{"type":"error","status":400,"error":{"message":"…"}}`). Unwrap the human
 * sentence out of it when that's the case.
 */
export function cleanCodexError(raw: string | undefined): string {
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
