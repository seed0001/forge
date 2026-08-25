import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { app } from 'electron';
import { nextId } from './diff-store';
import { IMAGE_MIME_BY_EXT } from './media-types';

/**
 * Pasted/dropped/edited chat images live outside the project root entirely —
 * keyed by a hash of the workspace's folder, the same pattern session-store.ts
 * uses for its per-workspace JSON files. This keeps screenshots out of the
 * user's actual git repo and out of fs-service.ts's assertInside root-scoping,
 * which is deliberate: these are Operator-supplied attachments, a different
 * (always-trusted) channel from the agent's own root-scoped file tools.
 */
export function attachmentDirFor(rootPath: string | null, workspaceId: string): string {
  const key = rootPath ? crypto.createHash('sha256').update(path.resolve(rootPath)).digest('hex').slice(0, 16) : `ws-${workspaceId}`;
  return path.join(app.getPath('userData'), 'attachments', key);
}

function extForMime(mime: string): string {
  const match = Object.entries(IMAGE_MIME_BY_EXT).find(([, m]) => m === mime);
  return match ? match[0].slice(1) : 'png';
}

export async function saveAttachment(
  rootPath: string | null,
  workspaceId: string,
  data: Buffer,
  mimeType: string
): Promise<{ path: string; name: string }> {
  const dir = attachmentDirFor(rootPath, workspaceId);
  await fs.mkdir(dir, { recursive: true });
  const name = `${nextId('img')}.${extForMime(mimeType)}`;
  const file = path.join(dir, name);
  await fs.writeFile(file, data);
  return { path: file, name };
}

/** True if `target` resolves under `dir` — guards image:read against reaching outside its allowed roots. */
function isInside(dir: string, target: string): boolean {
  const rel = path.relative(dir, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export async function readImageAsDataUrl(
  filePath: string,
  allowedDirs: (string | null)[]
): Promise<string | null> {
  const resolved = path.resolve(filePath);
  const allowed = allowedDirs.some((dir) => dir && isInside(path.resolve(dir), resolved));
  if (!allowed) return null;
  try {
    const data = await fs.readFile(resolved);
    const mime = IMAGE_MIME_BY_EXT[path.extname(resolved).toLowerCase()] ?? 'image/png';
    return `data:${mime};base64,${data.toString('base64')}`;
  } catch {
    return null;
  }
}
