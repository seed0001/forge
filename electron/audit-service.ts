import fs from 'node:fs/promises';
import path from 'node:path';
import { SECRET_SETTINGS_KEYS } from './ipc-channels';

/**
 * Append-only mutation log required by 00-MASTER §6 and 02-TOOLCALL:
 * every command run and every file changed is recorded, so the Operator can
 * reconstruct what happened without trusting a summary.
 */
export type AuditKind = 'command' | 'write' | 'revert' | 'search';

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
      await fs.writeFile(file, '# AUDIT\n\nMutations made by the Forge agent.\n\n', 'utf8');
    }
    await fs.appendFile(file, line, 'utf8');
  } catch {
    // Auditing must never break the task it is recording.
  }
}
