import fs from 'node:fs/promises';
import path from 'node:path';
import { listTree } from './fs-service';
import type { FileNode, CatalogModel } from './ipc-channels';

/** Escapes every regex-special character in a single literal glob segment. */
function escapeLiteral(c: string): string {
  return c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/** Converts a glob pattern (**, *, ?, {a,b,c}) into an anchored, case-insensitive RegExp matched against a forward-slash relative path. */
export function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      re += '.*';
      i++;
      if (pattern[i + 1] === '/') i++;
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const end = pattern.indexOf('}', i);
      if (end === -1) {
        re += '\\{';
        continue;
      }
      re += `(?:${pattern
        .slice(i + 1, end)
        .split(',')
        .map(escapeLiteral)
        .join('|')})`;
      i = end;
    } else {
      re += escapeLiteral(c);
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

function flattenFiles(nodes: FileNode[], rootPath: string, out: string[]) {
  for (const n of nodes) {
    if (n.type === 'file') out.push(n.path);
    else if (n.children) flattenFiles(n.children, rootPath, out);
  }
}

function toRel(rootPath: string, abs: string): string {
  return path.relative(rootPath, abs).split(path.sep).join('/');
}

/** Files matching a glob pattern, newest first. Reuses fs-service's own ignore-list and depth/entry caps via listTree. */
export async function globSearch(rootPath: string, pattern: string, maxResults = 200): Promise<string[]> {
  const tree = await listTree(rootPath, 10, 8000);
  const all: string[] = [];
  flattenFiles(tree, rootPath, all);
  const regex = globToRegExp(pattern);
  const matched = all.filter((abs) => regex.test(toRel(rootPath, abs)));
  const withMtime = await Promise.all(
    matched.map(async (abs) => ({ abs, mtimeMs: (await fs.stat(abs).catch(() => null))?.mtimeMs ?? 0 }))
  );
  return withMtime
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxResults)
    .map((f) => toRel(rootPath, f.abs));
}

export interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip', '.exe', '.dll',
  '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.mp4', '.mov', '.wav', '.bin', '.wasm',
]);

/** Regex content search across a project's text files, skipping binaries and anything past a per-file size cap. */
export async function grepSearch(
  rootPath: string,
  pattern: RegExp,
  includeGlob: string | undefined,
  maxMatches = 200,
  maxFileBytes = 500_000
): Promise<{ matches: GrepMatch[]; filesScanned: number; truncated: boolean }> {
  const tree = await listTree(rootPath, 10, 8000);
  const all: string[] = [];
  flattenFiles(tree, rootPath, all);
  const includeRe = includeGlob ? globToRegExp(includeGlob) : null;

  const candidates = all.filter((abs) => {
    if (BINARY_EXT.has(path.extname(abs).toLowerCase())) return false;
    if (includeRe && !includeRe.test(toRel(rootPath, abs))) return false;
    return true;
  });

  const matches: GrepMatch[] = [];
  let filesScanned = 0;
  for (const abs of candidates) {
    if (matches.length >= maxMatches) break;
    try {
      const stat = await fs.stat(abs);
      if (stat.size > maxFileBytes) continue;
      const content = await fs.readFile(abs, 'utf8');
      filesScanned++;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
        if (pattern.test(lines[i])) {
          matches.push({ file: toRel(rootPath, abs), line: i + 1, text: lines[i].trim().slice(0, 300) });
        }
        pattern.lastIndex = 0; // a global-flag pattern must not carry state across lines/files
      }
    } catch {
      // Unreadable file (permissions, race with a delete) — skipped, same tolerance list_files already has.
    }
  }
  return { matches, filesScanned, truncated: matches.length >= maxMatches };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', "#39": "'", apos: "'", nbsp: ' ' };

function decodeEntities(s: string): string {
  return s
    .replace(/&(#39|amp|lt|gt|quot|apos|nbsp);/g, (_, e) => ENTITIES[e] ?? '')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

/**
 * DOM-less HTML-to-text: no Readability/jsdom available outside a real
 * browser view, so this trades cleanliness for not needing one. Good enough
 * for "what does this page roughly say," not a replacement for Forge's
 * embedded-browser page extraction (electron/page-extract.ts).
 */
export function htmlToText(html: string, maxLinks = 20): { text: string; links: string[] } {
  const links: string[] = [];
  const linkRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) && links.length < maxLinks) {
    if (/^https?:\/\//i.test(m[1])) links.push(m[1]);
  }
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(stripped)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]*\n+/g, '\n\n')
    .trim();
  return { text, links };
}

export interface DevSearchResult {
  title: string;
  url: string;
  detail: string;
}

export async function searchGithubRepos(query: string): Promise<DevSearchResult[]> {
  const res = await fetch(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=8`,
    { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Forge' } }
  );
  if (!res.ok) throw new Error(`GitHub search failed (${res.status})`);
  const data = (await res.json()) as { items?: Array<Record<string, unknown>> };
  return (data.items ?? []).map((r) => ({
    title: String(r.full_name),
    url: String(r.html_url),
    detail: `★${r.stargazers_count} · ${r.language ?? 'unknown language'} · ${r.description ?? ''}`.trim(),
  }));
}

export async function searchNpmPackages(query: string): Promise<DevSearchResult[]> {
  const res = await fetch(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=8`);
  if (!res.ok) throw new Error(`npm search failed (${res.status})`);
  const data = (await res.json()) as { objects?: Array<{ package: Record<string, any> }> };
  return (data.objects ?? []).map((o) => ({
    title: String(o.package.name),
    url: o.package.links?.npm ?? `https://www.npmjs.com/package/${o.package.name}`,
    detail: `v${o.package.version} · ${o.package.description ?? ''}`,
  }));
}

export async function searchHackerNews(query: string): Promise<DevSearchResult[]> {
  const res = await fetch(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=8`);
  if (!res.ok) throw new Error(`Hacker News search failed (${res.status})`);
  const data = (await res.json()) as { hits?: Array<Record<string, unknown>> };
  return (data.hits ?? []).map((h) => ({
    title: String(h.title),
    url: (h.url as string) || `https://news.ycombinator.com/item?id=${h.objectID}`,
    detail: `${h.points ?? 0} points · ${h.num_comments ?? 0} comments`,
  }));
}

export async function fetchRssFeed(url: string, maxItems = 10): Promise<DevSearchResult[]> {
  const res = await fetch(url, { headers: { 'User-Agent': 'Forge' } });
  if (!res.ok) throw new Error(`RSS/Atom fetch failed (${res.status})`);
  const xml = await res.text();
  const items: DevSearchResult[] = [];
  const itemRe = /<(item|entry)\b[\s\S]*?<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) && items.length < maxItems) {
    const block = m[0];
    const title =
      /<title[^>]*>([\s\S]*?)<\/title>/i.exec(block)?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, '').trim() ?? '(no title)';
    const link =
      /<link[^>]*>([\s\S]*?)<\/link>/i.exec(block)?.[1]?.trim() ||
      /<link\b[^>]*href=["']([^"']+)["']/i.exec(block)?.[1] ||
      '';
    const pubDate = /<(pubDate|published|updated)>([\s\S]*?)<\/\1>/i.exec(block)?.[2]?.trim();
    items.push({ title: decodeEntities(title), url: link, detail: pubDate ?? '' });
  }
  return items;
}

export type PriceTier = 'free' | 'economy' | 'balanced' | 'premium';

/** Free/economy/balanced/premium, by prompt price per million tokens — the same rough bands VoidCoder's catalog uses. */
export function classifyTier(model: CatalogModel): PriceTier {
  if (model.isFree || model.promptPrice === 0) return 'free';
  const perMillion = model.promptPrice * 1_000_000;
  if (perMillion < 1) return 'economy';
  if (perMillion < 5) return 'balanced';
  return 'premium';
}

/** Exact id match wins outright; otherwise a case-insensitive substring match against id or name — ambiguous when more than one hits. */
export function resolveModelRef(query: string, models: CatalogModel[]): { exact?: CatalogModel; candidates: CatalogModel[] } {
  const q = query.trim().toLowerCase();
  const exactId = models.find((m) => m.id.toLowerCase() === q);
  if (exactId) return { exact: exactId, candidates: [] };
  const candidates = models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
  if (candidates.length === 1) return { exact: candidates[0], candidates: [] };
  return { candidates };
}
