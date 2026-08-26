import fs from 'node:fs/promises';
import path from 'node:path';

export interface BugReportInput {
  title: string;
  description: string;
  severity?: string;
  steps?: string;
  expected?: string;
  actual?: string;
}

function slug(title: string): string {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return s || 'bug';
}

/** Writes a structured bug report as a markdown file under the project's bugs/ folder, numbered sequentially. Returns the path relative to rootPath. */
export async function fileBugReport(rootPath: string, input: BugReportInput): Promise<string> {
  const dir = path.join(rootPath, 'bugs');
  await fs.mkdir(dir, { recursive: true });
  const existing = await fs.readdir(dir).catch(() => [] as string[]);
  const nums = existing.map((f) => Number(/^BUG-(\d+)/.exec(f)?.[1])).filter((n) => Number.isFinite(n));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  const rel = path.join('bugs', `BUG-${next}-${slug(input.title)}.md`);
  const abs = path.join(rootPath, rel);

  const body = [
    `# BUG-${next}: ${input.title}`,
    '',
    `**Severity:** ${input.severity || 'unspecified'}`,
    `**Filed:** ${new Date().toISOString()}`,
    '',
    '## Description',
    input.description,
    input.steps ? `\n## Steps to reproduce\n${input.steps}` : '',
    input.expected ? `\n## Expected\n${input.expected}` : '',
    input.actual ? `\n## Actual\n${input.actual}` : '',
  ]
    .filter((line) => line !== '')
    .join('\n');

  await fs.writeFile(abs, `${body}\n`, 'utf8');
  return rel.split(path.sep).join('/');
}
