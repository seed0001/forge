import { structuredPatch } from 'diff';
import type { Hunk, HunkDecision } from './ipc-channels';

export function computeHunks(filePath: string, oldContent: string, newContent: string): Hunk[] {
  const patch = structuredPatch(filePath, filePath, oldContent, newContent, '', '', { context: 3 });
  return patch.hunks.map((h, index) => ({
    index,
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
    lines: h.lines,
  }));
}

export function countChanges(hunks: Hunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    for (const line of h.lines) {
      if (line[0] === '+') added++;
      else if (line[0] === '-') removed++;
    }
  }
  return { added, removed };
}

/**
 * Rebuild file content honoring per-hunk accept/reject decisions.
 * Hunks marked 'accepted' contribute their new (context + added) lines;
 * hunks left 'pending' or 'rejected' fall back to the original (context + removed) lines.
 */
export function applyDecidedHunks(
  oldContent: string,
  hunks: Hunk[],
  decisions: Record<number, HunkDecision>
): string {
  const oldLines = oldContent.split('\n');
  const result: string[] = [];
  let cursor = 0;

  const sorted = [...hunks].sort((a, b) => a.oldStart - b.oldStart);
  for (const h of sorted) {
    const oldStartIdx = Math.max(h.oldStart - 1, 0);
    result.push(...oldLines.slice(cursor, oldStartIdx));

    const accepted = decisions[h.index] === 'accepted';
    for (const line of h.lines) {
      const prefix = line[0];
      const text = line.slice(1);
      if (accepted) {
        if (prefix === ' ' || prefix === '+') result.push(text);
      } else {
        if (prefix === ' ' || prefix === '-') result.push(text);
      }
    }
    cursor = oldStartIdx + h.oldLines;
  }
  result.push(...oldLines.slice(cursor));
  return result.join('\n');
}
