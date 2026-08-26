/**
 * Remembers which workspace tabs were open across app restarts — which root
 * folders (or blanks), in what order, with what kind, and which one was
 * active — so relaunching Forge reopens the same tab strip instead of
 * always starting with one fresh workspace. Per-workspace chat itself is
 * already persisted separately (session-store.ts, keyed by root folder);
 * this is just the index of which of those to reopen.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import type { WorkspaceKind } from './ipc-channels';

export interface WorkspaceIndexEntry {
  rootPath: string | null;
  kind: WorkspaceKind | null;
}

export interface WorkspaceIndex {
  entries: WorkspaceIndexEntry[];
  activeIndex: number;
}

function indexFile(): string {
  return path.join(app.getPath('userData'), 'workspaces.json');
}

export async function loadWorkspaceIndex(): Promise<WorkspaceIndex> {
  try {
    const raw = await fs.readFile(indexFile(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<WorkspaceIndex>;
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    return { entries, activeIndex: typeof parsed.activeIndex === 'number' ? parsed.activeIndex : 0 };
  } catch {
    return { entries: [], activeIndex: 0 };
  }
}

export async function saveWorkspaceIndex(index: WorkspaceIndex): Promise<void> {
  try {
    const file = indexFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(index, null, 2), 'utf8');
  } catch {
    // Persistence failing must not take the running app down with it.
  }
}
