import { Worker } from 'node:worker_threads';

/**
 * Guards that keep a single tool call from hanging a whole agent turn.
 *
 * Two hang classes are covered here:
 *
 *  1. Network calls with no timeout. Node's global `fetch` has NO default
 *     timeout — a server that accepts the connection and then never sends (or
 *     never finishes) a response leaves the caller awaiting forever, and the
 *     agent turn with it. Every non-chat tool fetch goes through
 *     `fetchJsonGuarded` / `fetchTextGuarded`, which abort on a deadline that
 *     stays armed through the body read, not just until headers arrive.
 *
 *  2. A model-supplied regex (the `grep` tool) run against repo contents.
 *     V8 has no regex-execution timeout, so a catastrophic-backtracking
 *     pattern pegs the event loop with no way to interrupt it from the same
 *     thread. `grepInWorker` runs the scan on a worker thread that is
 *     `terminate()`d on a deadline — the only reliable way to bound it.
 */

export const HTTP_TIMEOUT_MS = 20_000;
export const SEARCH_TIMEOUT_MS = 15_000;
export const GREP_TIMEOUT_MS = 4_000;

/** Cap on a fetched text body (bytes). Bounds both memory and the cost of the
 *  regex-based HTML/RSS extraction that runs over the result. */
export const MAX_FETCH_BYTES = 5_000_000;

async function withDeadline<T>(
  label: string,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await run(ctl.signal);
  } catch (err) {
    if (ctl.signal.aborted) {
      throw new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s and was aborted.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export interface GuardedJson {
  ok: boolean;
  status: number;
  data: unknown;
}

/** fetch + JSON parse under a single deadline. `data` is null on a parse failure. */
export async function fetchJsonGuarded(
  url: string,
  init: RequestInit = {},
  timeoutMs = HTTP_TIMEOUT_MS
): Promise<GuardedJson> {
  return withDeadline(`Request to ${url}`, timeoutMs, async (signal) => {
    const resp = await fetch(url, { ...init, signal });
    let data: unknown = null;
    try {
      data = await resp.json();
    } catch {
      data = null;
    }
    return { ok: resp.ok, status: resp.status, data };
  });
}

export interface GuardedText {
  ok: boolean;
  status: number;
  contentType: string;
  text: string;
  truncated: boolean;
}

/** fetch + body read under a single deadline, stopping at `maxBytes`. */
export async function fetchTextGuarded(
  url: string,
  init: RequestInit = {},
  opts: { timeoutMs?: number; maxBytes?: number } = {}
): Promise<GuardedText> {
  const { timeoutMs = HTTP_TIMEOUT_MS, maxBytes = MAX_FETCH_BYTES } = opts;
  return withDeadline(`Request to ${url}`, timeoutMs, async (signal) => {
    const resp = await fetch(url, { ...init, signal });
    const contentType = resp.headers.get('content-type') ?? '';

    if (!resp.body) {
      const whole = await resp.text();
      const truncated = whole.length > maxBytes;
      return {
        ok: resp.ok,
        status: resp.status,
        contentType,
        text: truncated ? whole.slice(0, maxBytes) : whole,
        truncated,
      };
    }

    const reader = resp.body.getReader();
    const chunks: Buffer[] = [];
    let received = 0;
    let truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(Buffer.from(value));
        received += value.byteLength;
      }
      if (received >= maxBytes) {
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
    }
    return {
      ok: resp.ok,
      status: resp.status,
      contentType,
      text: Buffer.concat(chunks).toString('utf8'),
      truncated,
    };
  });
}

/** Run `run` under a deadline that aborts the passed signal — for a streamed
 *  response (SSE) whose read loop would otherwise wait forever on a stalled
 *  connection. The caller wires `signal` into its own `fetch`. */
export function withAbortDeadline<T>(
  label: string,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  return withDeadline(label, timeoutMs, run);
}

export interface GrepWorkerInput {
  pattern: string;
  flags: string;
  files: string[];
  maxMatches: number;
  maxFileBytes: number;
}

export interface GrepWorkerOutput {
  matches: { file: string; line: number; text: string }[];
  filesScanned: number;
  truncated: boolean;
}

// Runs on a worker thread (see grepInWorker). Kept as an inline string so the
// esbuild single-file bundle needs no extra entry point — `eval: true` compiles
// this directly. Uses only Node builtins.
const GREP_WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
(function () {
  const { pattern, flags, files, maxMatches, maxFileBytes } = workerData;
  let regex;
  try {
    regex = new RegExp(pattern, flags);
  } catch (e) {
    parentPort.postMessage({ error: 'not a valid regular expression — ' + String(e) });
    return;
  }
  const matches = [];
  let filesScanned = 0;
  for (const abs of files) {
    if (matches.length >= maxMatches) break;
    try {
      const stat = fs.statSync(abs);
      if (stat.size > maxFileBytes) continue;
      const content = fs.readFileSync(abs, 'utf8');
      filesScanned++;
      const lines = content.split('\\n');
      for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
        if (regex.test(lines[i])) {
          matches.push({ file: abs, line: i + 1, text: lines[i].trim().slice(0, 300) });
        }
        regex.lastIndex = 0;
      }
    } catch (e) {
      // Unreadable file (permissions, race with a delete) — skipped.
    }
  }
  parentPort.postMessage({ matches, filesScanned, truncated: matches.length >= maxMatches });
})();
`;

/**
 * Run a `grep` scan on a worker thread, killed after `timeoutMs`. A
 * catastrophic-backtracking pattern (`(a+)+$` and friends) can wedge V8 with
 * no in-thread way to stop it, so the only real bound is terminating the
 * thread it runs on.
 */
export function grepInWorker(input: GrepWorkerInput, timeoutMs = GREP_TIMEOUT_MS): Promise<GrepWorkerOutput> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(GREP_WORKER_SRC, { eval: true, workerData: input });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `pattern took longer than ${Math.round(timeoutMs / 1000)}s and was stopped — it is too broad or a ` +
              'catastrophic-backtracking regex. Anchor it or make it more specific.'
          )
        )
      );
    }, timeoutMs);
    worker.on('message', (msg: { error?: string } & GrepWorkerOutput) => {
      if (msg && msg.error) finish(() => reject(new Error(msg.error!)));
      else finish(() => resolve(msg));
    });
    worker.on('error', (err) => finish(() => reject(err)));
    worker.on('exit', (code) => {
      if (code !== 0) finish(() => reject(new Error(`grep worker exited with code ${code}`)));
    });
  });
}
