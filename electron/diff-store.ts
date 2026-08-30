import type { PendingDiff, Checkpoint, HunkDecision } from './ipc-channels';
import { applyDecidedHunks } from './diff-service';
import { writeFile, readFileSafe } from './fs-service';
import { audit } from './audit-service';

let idCounter = 0;
export function nextId(prefix: string) {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

/**
 * Pending agent edits and undo checkpoints for a single workspace. Each
 * workspace owns one of these, so reviewing changes in one tab never touches
 * another tab's queue.
 */
export class DiffStore {
  private pending = new Map<string, PendingDiff>();
  private checkpoints: Checkpoint[] = [];
  /** Resolvers registered by awaitDecision(), fired by decide() once every hunk of that diff is settled — see the Codex approval bridge (codex-app-server.ts), the only caller that needs to block on one specific diff's outcome. */
  private decisionWaiters = new Map<string, Array<(diff: PendingDiff) => void>>();

  add(diff: PendingDiff) {
    this.pending.set(diff.id, diff);
  }

  /** Resolves once every hunk of this diff has been decided (accepted or rejected), whether that happens via the Operator or an auto-apply. Register right after add() — before any await — so there's no window for the decision to land first. */
  awaitDecision(diffId: string): Promise<PendingDiff> {
    return new Promise((resolve) => {
      const arr = this.decisionWaiters.get(diffId) ?? [];
      arr.push(resolve);
      this.decisionWaiters.set(diffId, arr);
    });
  }

  get(id: string) {
    return this.pending.get(id);
  }

  list() {
    return Array.from(this.pending.values());
  }

  listCheckpoints() {
    return this.checkpoints;
  }

  private pushCheckpoint(cp: Checkpoint) {
    this.checkpoints.unshift(cp);
    if (this.checkpoints.length > 50) this.checkpoints.pop();
  }

  findLatestCheckpoint(filePath: string) {
    return this.checkpoints.find((c) => c.path === filePath);
  }

  removeCheckpoint(cp: Checkpoint) {
    const idx = this.checkpoints.indexOf(cp);
    if (idx >= 0) this.checkpoints.splice(idx, 1);
  }

  /**
   * Apply a decision to one hunk (or every hunk) of a pending diff, rewrite the
   * file to reflect the current decisions, and record what was on disk first so
   * the change can be undone.
   */
  async decide(
    rootPath: string,
    diffId: string,
    hunkIndex: number | 'all',
    decision: HunkDecision
  ): Promise<PendingDiff | undefined> {
    const diff = this.pending.get(diffId);
    if (!diff) return undefined;

    const onDiskBefore = await readFileSafe(rootPath, diff.path);

    if (hunkIndex === 'all') {
      for (const h of diff.hunks) {
        const cur = diff.decisions[h.index];
        diff.decisions[h.index] = cur === decision ? 'pending' : decision;
      }
    } else {
      const cur = diff.decisions[hunkIndex];
      diff.decisions[hunkIndex] = cur === decision ? 'pending' : decision;
    }

    const rebuilt = applyDecidedHunks(diff.baseContent, diff.hunks, diff.decisions);
    if (rebuilt !== onDiskBefore) {
      this.pushCheckpoint({ path: diff.path, previousContent: onDiskBefore, timestamp: Date.now() });
      await writeFile(rootPath, diff.path, rebuilt);
      const accepted = diff.hunks.filter((h) => diff.decisions[h.index] === 'accepted').length;
      await audit(
        rootPath,
        'write',
        diff.path,
        `${accepted}/${diff.hunks.length} hunks accepted by the Operator`
      );
    }

    const allDecided = diff.hunks.every((h) => diff.decisions[h.index] && diff.decisions[h.index] !== 'pending');
    if (allDecided) {
      this.pending.delete(diffId);
      const waiters = this.decisionWaiters.get(diffId);
      if (waiters) {
        this.decisionWaiters.delete(diffId);
        for (const w of waiters) w(diff);
      }
    } else {
      this.pending.set(diffId, diff);
    }

    return diff;
  }
}
