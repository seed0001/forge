/**
 * Remembers which workspaces (and which projects inside each) were open
 * across app restarts — labels, types, meta-file text, which root folders
 * (or blanks) with what kind, in what order, and which project/workspace was
 * active — so relaunching Forge reopens the same tab strip instead of always
 * starting with one fresh workspace. Per-project chat itself is already
 * persisted separately (session-store.ts, keyed by root folder); this is
 * just the index of which of those to reopen and how they're grouped.
 *
 * Ids are NOT persisted here (same as before the workspace/project split —
 * they were never stable across restarts either): WorkspaceManager mints
 * fresh workspace and project ids on every launch, restored into this same
 * shape (label/type/metaFile/projects/activeProjectIndex).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import type { WorkspaceKind, WorkspaceType } from './ipc-channels';

export interface WorkspaceIndexProjectEntry {
  rootPath: string | null;
  kind: WorkspaceKind | null;
}

export interface WorkspaceIndexEntry {
  label: string;
  type: WorkspaceType;
  metaFile: string;
  projects: WorkspaceIndexProjectEntry[];
  activeProjectIndex: number;
}

export interface WorkspaceIndex {
  workspaces: WorkspaceIndexEntry[];
  activeWorkspaceIndex: number;
}

function indexFile(): string {
  return path.join(app.getPath('userData'), 'workspaces.json');
}

function isProjectEntry(v: unknown): v is WorkspaceIndexProjectEntry {
  return !!v && typeof v === 'object';
}

export async function loadWorkspaceIndex(): Promise<WorkspaceIndex> {
  try {
    const raw = await fs.readFile(indexFile(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<WorkspaceIndex>;
    const workspaces = Array.isArray(parsed.workspaces)
      ? parsed.workspaces.map((w) => ({
          label: typeof w.label === 'string' ? w.label : 'Workspace',
          type: (w.type as WorkspaceType) ?? 'coding',
          metaFile: typeof w.metaFile === 'string' ? w.metaFile : '',
          projects: Array.isArray(w.projects) ? w.projects.filter(isProjectEntry) : [],
          activeProjectIndex: typeof w.activeProjectIndex === 'number' ? w.activeProjectIndex : 0,
        }))
      : [];
    return {
      workspaces,
      activeWorkspaceIndex: typeof parsed.activeWorkspaceIndex === 'number' ? parsed.activeWorkspaceIndex : 0,
    };
  } catch {
    return { workspaces: [], activeWorkspaceIndex: 0 };
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
