import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';

/**
 * The Operator's running rules document — one global Markdown file the agent
 * reads at the start of every session and treats as authoritative.
 *
 * This replaces the old bundled `rules/00-09` module set. There are no shipped
 * rules: the file starts empty and only ever contains what the Operator has
 * explicitly asked to be remembered (via the `add_rule` tool, or by editing the
 * file by hand). Nothing here is inferred, generated, or seeded.
 */

function filePath(): string {
  return path.join(app.getPath('userData'), 'RULES.md');
}

export function rulesFilePath(): string {
  return filePath();
}

/** The whole document, trimmed. Empty string if it doesn't exist yet. */
export async function readRules(): Promise<string> {
  try {
    return (await fs.readFile(filePath(), 'utf8')).trim();
  } catch {
    return '';
  }
}

/**
 * Append one rule as a Markdown list item, in the Operator's own words.
 * Creates the file on first use. Returns the normalized rule text.
 */
export async function appendRule(rule: string): Promise<string> {
  const clean = rule.trim().replace(/\s+/g, ' ');
  if (!clean) throw new Error('add_rule: empty rule');

  const file = filePath();
  let existing = '';
  try {
    existing = await fs.readFile(file, 'utf8');
  } catch {
    /* first rule — file doesn't exist yet */
  }

  const body = existing.trim();
  const next = (body ? `${body}\n` : '') + `- ${clean}\n`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, next, 'utf8');
  return clean;
}
