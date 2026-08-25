import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Append-only mutation log required by 00-MASTER §6 and 02-TOOLCALL:
 * every command run and every file changed is recorded, so the Operator can
 * reconstruct what happened without trusting a summary.
 */
export type AuditKind = 'command' | 'write' | 'revert' | 'search';

export async function audit(
  rootPath: string | null,
  kind: AuditKind,
  detail: string,
  outcome?: string
): Promise<void> {
  if (!rootPath) return;
  const stamp = new Date().toISOString();
  const line = outcome
    ? `- ${stamp} **${kind}** ${detail} — ${outcome}\n`
    : `- ${stamp} **${kind}** ${detail}\n`;
  const file = path.join(rootPath, 'AUDIT.md');
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
