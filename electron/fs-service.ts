import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileNode } from './ipc-channels';

/** Heavy or generated directories that are never useful to browse. */
const IGNORED = new Set([
  'node_modules', '.git', 'dist', 'dist-electron', 'build', 'out',
  '.next', '.nuxt', '.cache', '.turbo', 'target', '__pycache__',
  '.venv', 'venv', '.DS_Store', 'Thumbs.db',
]);

function sortEntries(a: { name: string; dir: boolean }, b: { name: string; dir: boolean }) {
  if (a.dir !== b.dir) return a.dir ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { numeric: true });
}

/**
 * One level of a directory. The tree loads lazily: eagerly walking a real
 * project is slow, and a single unreadable subdirectory (a Windows junction, a
 * permissions error) would otherwise fail the entire listing.
 */
export async function listDir(dirPath: string): Promise<FileNode[]> {
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((e) => !IGNORED.has(e.name))
    .map((e) => ({ name: e.name, dir: e.isDirectory() }))
    .sort(sortEntries)
    .map(({ name, dir }) => ({
      name,
      path: path.join(dirPath, name),
      type: dir ? ('dir' as const) : ('file' as const),
    }));
}

/**
 * Recursive listing used by the agent's list_files tool. Depth- and
 * count-capped, and unreadable directories are skipped rather than thrown.
 */
export async function listTree(rootPath: string, maxDepth = 4, maxEntries = 2000): Promise<FileNode[]> {
  let budget = maxEntries;

  async function walk(dir: string, depth: number): Promise<FileNode[]> {
    if (depth > maxDepth || budget <= 0) return [];
    const children = await listDir(dir);
    const out: FileNode[] = [];
    for (const node of children) {
      if (budget <= 0) break;
      budget -= 1;
      if (node.type === 'dir') out.push({ ...node, children: await walk(node.path, depth + 1) });
      else out.push(node);
    }
    return out;
  }

  return walk(rootPath, 0);
}

export async function readFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8');
}

export function assertInside(root: string, target: string) {
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing to write outside project root: ${target}`);
  }
}

export async function writeFile(rootPath: string, filePath: string, content: string): Promise<void> {
  assertInside(rootPath, filePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

/** Same contract as writeFile, for generated media (images, audio) instead of text. */
export async function writeBinaryFile(rootPath: string, filePath: string, data: Buffer): Promise<void> {
  assertInside(rootPath, filePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, data);
}

export type ReadBinaryResult =
  | { ok: true; data: Buffer }
  | { ok: false; reason: 'missing' | 'outside-root' | 'error'; detail: string };

/** Binary counterpart to readFileDetailed, for feeding images to a vision model. */
export async function readFileBinaryDetailed(rootPath: string, filePath: string): Promise<ReadBinaryResult> {
  try {
    assertInside(rootPath, filePath);
  } catch {
    return { ok: false, reason: 'outside-root', detail: `${filePath} is outside the project root` };
  }
  try {
    return { ok: true, data: await fs.readFile(filePath) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, reason: 'missing', detail: `${filePath} does not exist` };
    return { ok: false, reason: 'error', detail: `${filePath}: ${code ?? String(err)}` };
  }
}

export type ReadResult =
  | { ok: true; content: string }
  | { ok: false; reason: 'missing' | 'outside-root' | 'error'; detail: string };

/**
 * Read a file, reporting *why* it failed. The agent must be able to tell an
 * empty file apart from one it could not read — otherwise a failed read looks
 * like an empty file and it will confidently describe real code as a stub.
 */
export async function readFileDetailed(rootPath: string, filePath: string): Promise<ReadResult> {
  try {
    assertInside(rootPath, filePath);
  } catch {
    return { ok: false, reason: 'outside-root', detail: `${filePath} is outside the project root` };
  }
  try {
    return { ok: true, content: await fs.readFile(filePath, 'utf8') };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, reason: 'missing', detail: `${filePath} does not exist` };
    return { ok: false, reason: 'error', detail: `${filePath}: ${code ?? String(err)}` };
  }
}

export async function readFileSafe(rootPath: string, filePath: string): Promise<string> {
  const result = await readFileDetailed(rootPath, filePath);
  return result.ok ? result.content : '';
}
