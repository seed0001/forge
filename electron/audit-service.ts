import fs from 'node:fs/promises';
import path from 'node:path';
import { SECRET_SETTINGS_KEYS } from './ipc-channels';
import type { AuditEntry, AuditReadResult } from './ipc-channels';

/**
 * Append-only activity log required by 00-MASTER §6 and 02-TOOLCALL: every
 * command run, every file changed, every file read or listed, and every
 * model request (with its wire size) is recorded, so the Operator can
 * reconstruct exactly what happened — and how big each request got — without
 * trusting a summary.
 *
 * - command / write / revert / search: mutations and lookups (original set)
 * - read / list: what the agent looked at, even when it changed nothing
 * - request: one line per model call — bytes, message count, image count
 * - error: a provider error verbatim (e.g. the 8 MB payload rejection)
 */
export type AuditKind =
  | 'command'
  | 'write'
  | 'revert'
  | 'search'
  | 'read'
  | 'list'
  | 'request'
  | 'error';

/** The single AUDIT.md a workspace's audit() calls write to — the one source of truth for "is this path the audit log". */
export function auditLogPath(rootPath: string): string {
  return path.join(rootPath, 'AUDIT.md');
}

/** True when targetPath resolves to exactly this workspace's own AUDIT.md (case-insensitive, as Windows paths are). */
export function isAuditLogPath(rootPath: string, targetPath: string): boolean {
  return path.resolve(targetPath).toLowerCase() === path.resolve(auditLogPath(rootPath)).toLowerCase();
}

/** Real secret values not to be redacted unless at least this long, so short substrings can't false-positive-collide with ordinary text. */
const MIN_SECRET_LENGTH = 12;

/**
 * Redacts every live credential value out of text before it is ever written
 * to the (git-tracked) audit log — matched by exact current VALUE against
 * SECRET_SETTINGS_KEYS, not by guessed shape, so it can't miss a non-standard
 * token format and can't over-redact text that merely looks like a secret.
 * Fails closed: if scrubbing itself throws, the caller gets a safe
 * placeholder back, never the unscrubbed input.
 */
function scrubKnownSecrets(text: string): string {
  try {
    const secrets = SECRET_SETTINGS_KEYS.map((key) => ({ key, value: process.env[key] || '' }))
      .filter((s) => s.value.length >= MIN_SECRET_LENGTH)
      .sort((a, b) => b.value.length - a.value.length);
    let out = text;
    for (const { key, value } of secrets) {
      out = out.split(value).join(`[REDACTED:${key}]`);
    }
    return out;
  } catch {
    return '(audit line withheld — redaction failed)';
  }
}

export async function audit(
  rootPath: string | null,
  kind: AuditKind,
  detail: string,
  outcome?: string
): Promise<void> {
  if (!rootPath) return;
  const stamp = new Date().toISOString();
  const safeDetail = scrubKnownSecrets(detail);
  const safeOutcome = outcome !== undefined ? scrubKnownSecrets(outcome) : outcome;
  const line = safeOutcome
    ? `- ${stamp} **${kind}** ${safeDetail} — ${safeOutcome}\n`
    : `- ${stamp} **${kind}** ${safeDetail}\n`;
  const file = auditLogPath(rootPath);
  try {
    try {
      await fs.access(file);
    } catch {
      await fs.writeFile(
        file,
        '# AUDIT\n\nEverything the Forge agent did, in order: commands run, files written, ' +
          'files read or listed, searches, model requests (with wire size), and provider errors.\n\n',
        'utf8'
      );
    }
    await fs.appendFile(file, line, 'utf8');
  } catch {
    // Auditing must never break the task it is recording.
  }
}

/**
 * `- <ISO ts> **<kind>** <detail>` with an optional ` — <outcome>` tail —
 * the exact shape audit() writes. Header/blank lines and anything that
 * doesn't match are skipped.
 */
const AUDIT_LINE_RE = /^-\s+(\S+)\s+\*\*([^*]+)\*\*\s+([\s\S]*)$/;

export function parseAuditLog(raw: string): AuditEntry[] {
  const out: AuditEntry[] = [];
  for (const line of raw.split('\n')) {
    const m = AUDIT_LINE_RE.exec(line.trim());
    if (!m) continue;
    const [, ts, kind, rest] = m;
    const sep = rest.indexOf(' — ');
    out.push({
      ts,
      kind: kind.trim(),
      detail: (sep === -1 ? rest : rest.slice(0, sep)).trim(),
      outcome: sep === -1 ? null : rest.slice(sep + 3).trim() || null,
    });
  }
  return out;
}

/** Read + parse this workspace's AUDIT.md for the in-app Audit view. */
export async function readAuditLog(rootPath: string | null): Promise<AuditReadResult> {
  if (!rootPath) return { present: false };
  const file = auditLogPath(rootPath);
  try {
    const raw = await fs.readFile(file, 'utf8');
    return { present: true, path: file, entries: parseAuditLog(raw) };
  } catch {
    return { present: false };
  }
}
