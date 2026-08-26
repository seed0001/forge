import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { hashRoot } from './session-store';
import type { FocusMessage } from './ipc-channels';

/** Most recent messages kept per workspace — old ones age out rather than growing the file forever. */
const MAX_MESSAGES = 500;

function fileForRoot(rootPath: string): string {
  return path.join(app.getPath('userData'), 'focus-board', `${hashRoot(rootPath)}.json`);
}

export async function loadFocusBoard(rootPath: string): Promise<FocusMessage[]> {
  try {
    const raw = await fs.readFile(fileForRoot(rootPath), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.messages) ? parsed.messages : [];
  } catch {
    return [];
  }
}

export async function saveFocusBoard(rootPath: string, messages: FocusMessage[]): Promise<void> {
  try {
    const file = fileForRoot(rootPath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const trimmed = messages.slice(-MAX_MESSAGES);
    await fs.writeFile(file, JSON.stringify({ rootPath, messages: trimmed }, null, 2), 'utf8');
  } catch {
    // Best-effort — losing a board write must not take the app down.
  }
}
