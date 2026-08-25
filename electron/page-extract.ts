import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ExtractedPage {
  title: string;
  /** Cleaned article content as markdown — nav/ads/boilerplate stripped by Readability before conversion. */
  markdown: string;
  /** Readability's own short description/excerpt, when it found one. */
  excerpt: string | null;
}

/**
 * Extraction runs INSIDE the live browsed page (via WebContentsView.
 * executeJavaScript), not against a reconstructed DOM in the main process —
 * the page already has a real, live DOM, so there's no need for a Node DOM
 * emulator (jsdom) here at all, which also sidesteps jsdom's well-known
 * esbuild-bundling problems. Readability and Turndown's browser bundle are
 * small, dependency-free scripts, copied next to the built app at
 * dist-electron/vendor/ (see scripts/dev.mjs / build-main.mjs) and injected
 * as plain text — cached after the first read.
 */
let cachedScript: string | null = null;

function readVendor(name: string): string {
  return fs.readFileSync(path.join(__dirname, 'vendor', name), 'utf8');
}

/**
 * The script to hand to `webContents.executeJavaScript()`. Its completion
 * value (the IIFE's return value) is what comes back — structured-cloned
 * automatically, no JSON.stringify needed on either side.
 */
export function buildExtractionScript(): string {
  if (cachedScript) return cachedScript;
  const readability = readVendor('Readability.js');
  const turndown = readVendor('turndown.umd.js');
  cachedScript = `
(function () {
  ${readability}
  ${turndown}
  try {
    var article = new Readability(document.cloneNode(true)).parse();
    var td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    if (article && article.content) {
      return {
        title: article.title || document.title || location.href,
        markdown: td.turndown(article.content).trim(),
        excerpt: article.excerpt || null,
      };
    }
    var fallbackHtml = document.body ? document.body.innerHTML : document.documentElement.innerHTML;
    return { title: document.title || location.href, markdown: td.turndown(fallbackHtml).trim(), excerpt: null };
  } catch (err) {
    return { title: document.title || location.href, markdown: '', excerpt: null, error: String(err && err.message || err) };
  }
})()`;
  return cachedScript;
}

/** A filesystem-safe slug for naming a clip file, derived from its title. */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'page';
}
