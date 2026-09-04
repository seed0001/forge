import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_PERMISSION_OVERRIDES,
  type PermissionOverrides,
} from './ipc-channels';

/**
 * Both the category overrides and the bash allowlist live in one small JSON
 * file (forge-perms.json) — they're both "permission configuration," and
 * splitting them across two files would just be two places to keep in sync.
 */
interface PermFile {
  overrides: PermissionOverrides;
  bashAllowlist: string[];
}

let cached: PermFile | null = null;

function filePath(): string {
  return path.join(app.getPath('userData'), 'forge-perms.json');
}

function readFile(): PermFile {
  try {
    const raw = fs.readFileSync(filePath(), 'utf8');
    const parsed = JSON.parse(raw);
    const rawOverrides = parsed.overrides ?? parsed; // tolerate the pre-allowlist flat shape
    return {
      overrides: {
        bash: typeof rawOverrides.bash === 'string' ? rawOverrides.bash as PermissionOverrides['bash'] : null,
        edit: typeof rawOverrides.edit === 'string' ? rawOverrides.edit as PermissionOverrides['edit'] : null,
        webfetch: typeof rawOverrides.webfetch === 'string' ? rawOverrides.webfetch as PermissionOverrides['webfetch'] : null,
      },
      bashAllowlist: Array.isArray(parsed.bashAllowlist) ? parsed.bashAllowlist.filter((p: unknown) => typeof p === 'string') : [],
    };
  } catch {
    return { overrides: { ...DEFAULT_PERMISSION_OVERRIDES }, bashAllowlist: [] };
  }
}

function writeFile(next: PermFile): void {
  try {
    const dir = path.dirname(filePath());
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify(next, null, 2), 'utf8');
    cached = next;
  } catch {
    // best effort — permission config is a convenience, not essential
  }
}

function ensureLoaded(): PermFile {
  if (!cached) cached = readFile();
  return cached;
}

/** Reads forge-perms.json (if not already cached) and returns the category overrides. */
export function loadPermissionOverrides(): PermissionOverrides {
  return ensureLoaded().overrides;
}

/**
 * Writes a full PermissionOverrides map, preserving whatever bash allowlist
 * is already on disk. Synchronous since this is small and only ever called
 * from an IPC handler or session startup — never a hot path.
 */
export function savePermissionOverrides(overrides: PermissionOverrides): void {
  writeFile({ overrides, bashAllowlist: ensureLoaded().bashAllowlist });
}

/**
 * Returns the in-memory cache if it has been seeded, otherwise falls through
 * to loadPermissionOverrides. This is the hot-path accessor used by
 * project.ts's resolvePermission — never reads the file after the first call.
 */
export function getCachedPermissionOverrides(): PermissionOverrides {
  return ensureLoaded().overrides;
}

/** Reads forge-perms.json (if not already cached) and returns the bash allowlist patterns. */
export function loadBashAllowlist(): string[] {
  return ensureLoaded().bashAllowlist;
}

/** Writes the bash allowlist, preserving whatever category overrides are already on disk. */
export function saveBashAllowlist(patterns: string[]): void {
  writeFile({ overrides: ensureLoaded().overrides, bashAllowlist: patterns });
}

/** Hot-path accessor for the allowlist, mirroring getCachedPermissionOverrides. */
export function getCachedBashAllowlist(): string[] {
  return ensureLoaded().bashAllowlist;
}

/**
 * A pattern matches a command either as an exact string, or — if it ends in
 * "*" — as a prefix. Matching alone is not enough to auto-approve: see
 * isShellChained below, which the caller must also check.
 */
export function matchesAllowlist(command: string, patterns: string[]): boolean {
  const trimmed = command.trim();
  return patterns.some((raw) => {
    const pattern = raw.trim();
    if (!pattern) return false;
    if (pattern.endsWith('*')) return trimmed.startsWith(pattern.slice(0, -1));
    return trimmed === pattern;
  });
}

/**
 * True if `command` contains a shell metacharacter that could chain on or
 * substitute in another command — ; & | a backtick, $(...), a redirect, or a
 * line break (\n / \r / Unicode line separators). Newlines matter because
 * spawn({ shell: true }) runs each line; an allowlist prefix must never
 * auto-approve `ls\nrm ...`. Shared with terminal-session's plain-cd check.
 * An allowlist pattern matching only the FRONT of such a command (e.g. "git
 * status*" matching "git status && rm -rf /") must never be treated as a
 * match for the whole command, so callers check this before honoring any
 * allowlist match.
 */
export function isShellChained(command: string): boolean {
  // Also treat U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR as breaks.
  return /[;&|`\n\r\u2028\u2029]|\$\(|<|>/.test(command);
}
