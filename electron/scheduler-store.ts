import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { hashRoot } from './session-store';
import type { ScheduleSpec, ScheduledTask } from './ipc-channels';

export type { ScheduleSpec, ScheduledTask };

function fileForRoot(rootPath: string): string {
  return path.join(app.getPath('userData'), 'schedules', `${hashRoot(rootPath)}.json`);
}

export async function loadScheduledTasks(rootPath: string): Promise<ScheduledTask[]> {
  try {
    const raw = await fs.readFile(fileForRoot(rootPath), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.tasks) ? parsed.tasks : [];
  } catch {
    return [];
  }
}

export async function saveScheduledTasks(rootPath: string, tasks: ScheduledTask[]): Promise<void> {
  try {
    const file = fileForRoot(rootPath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ rootPath, tasks }, null, 2), 'utf8');
  } catch {
    // Best-effort — losing a scheduler write must not take the app down.
  }
}

/**
 * A compact 5-field cron matcher (minute hour day month weekday) supporting
 * `*`, plain numbers, comma lists, and step values (e.g. star-slash-N) — the
 * common subset real schedules use, not the full crontab spec (no combined
 * ranges+steps). Good enough for "every day at 9", "every 15 minutes during
 * business hours", without pulling in a cron library for it.
 */
function fieldMatches(field: string, value: number, max: number): boolean {
  return field.split(',').some((part) => {
    if (part === '*') return true;
    const stepMatch = /^\*\/(\d+)$/.exec(part);
    if (stepMatch) return value % Number(stepMatch[1]) === 0;
    const rangeMatch = /^(\d+)-(\d+)$/.exec(part);
    if (rangeMatch) return value >= Number(rangeMatch[1]) && value <= Number(rangeMatch[2]);
    const n = Number(part);
    return Number.isFinite(n) && n === value && value <= max;
  });
}

/** True if `expr` parses as a plausible 5-field cron expression — used to validate before ever storing a task. */
export function isValidCronExpr(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  return fields.length === 5 && fields.every((f) => /^(\*|\*\/\d+|\d+(-\d+)?)(,(\*|\*\/\d+|\d+(-\d+)?))*$/.test(f));
}

/**
 * Raw fields for a new scheduled task, as they arrive from either the
 * native tool loop's schedule_task call or a Codex schedule-request file
 * (SCHEDULE_REQUEST_FILENAME below) — untyped, since both sources are just
 * parsed JSON/tool-call args that haven't been validated yet.
 */
export interface ScheduleTaskInput {
  label?: unknown;
  prompt?: unknown;
  cron?: unknown;
  interval_minutes?: unknown;
}

export type ParsedScheduleTask =
  | { ok: true; label: string; prompt: string; schedule: ScheduleSpec }
  | { ok: false; error: string };

/**
 * Validates a new-task request from either source above into a real
 * ScheduleSpec, or a human-readable reason it can't be created — shared so
 * the two entry points (agent-service.ts's schedule_task tool, project.ts's
 * schedule-request-file check) can't drift into different validation rules.
 */
export function parseScheduleTaskInput(input: ScheduleTaskInput): ParsedScheduleTask {
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!label || !prompt) return { ok: false, error: 'requires both "label" and "prompt"' };

  const cron = typeof input.cron === 'string' ? input.cron.trim() : '';
  const intervalRaw = typeof input.interval_minutes === 'number' ? input.interval_minutes : Number(input.interval_minutes);
  const hasCron = cron !== '';
  const hasInterval = Number.isFinite(intervalRaw) && intervalRaw > 0;
  if (hasCron === hasInterval) return { ok: false, error: 'requires EXACTLY ONE of "cron" or "interval_minutes"' };
  if (hasCron && !isValidCronExpr(cron)) {
    return { ok: false, error: `"${cron}" is not a valid 5-field cron expression (minute hour day month weekday)` };
  }

  const schedule: ScheduleSpec = hasCron ? { kind: 'cron', expr: cron } : { kind: 'interval', minutes: Math.round(intervalRaw) };
  return { ok: true, label, prompt, schedule };
}

/**
 * Well-known project-root filename Codex (which has no access to Forge's
 * function-calling tools, only read/write/shell) can write to instead of
 * telling the Operator to use the Scheduler panel by hand. Written through
 * Codex's normal file-edit path, so it's gated by the same edit
 * permission/review as any other Codex write. project.ts's tickScheduler
 * polls for it every tick and deletes it once processed (success or not) —
 * see buildCodexPreamble in agent-service.ts for the exact contract Codex is
 * told to follow.
 */
export const SCHEDULE_REQUEST_FILENAME = '.forge-schedule-request.json';

/**
 * Next minute-boundary timestamp at or after `from` matching a cron
 * expression, or null if none falls within the search horizon.
 *
 * Searches day-by-day, only walking the 1,440 minutes of a day whose
 * date/month/weekday fields actually match. An impossible expression
 * (e.g. `0 0 30 2 *` — the 30th of February) then costs ~1,460 cheap
 * iterations instead of the ~1,000,000 a flat minute-by-minute scan took,
 * so a bad expression can't stall the scheduler tick that computes it.
 * The horizon is ~4 years so a Feb-29 schedule still resolves.
 */
export function nextCronRun(expr: string, from: number): number | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [min, hour, day, month, weekday] = fields;

  const cursor = new Date(Math.ceil(from / 60_000) * 60_000);
  const HORIZON_DAYS = 366 * 4;
  for (let d = 0; d < HORIZON_DAYS; d++) {
    const dateOk =
      fieldMatches(day, cursor.getDate(), 31) &&
      fieldMatches(month, cursor.getMonth() + 1, 12) &&
      fieldMatches(weekday, cursor.getDay(), 6);
    if (dateOk) {
      const dayOfMonth = cursor.getDate();
      for (let m = 0; m < 24 * 60; m++) {
        const t = new Date(cursor);
        t.setMinutes(t.getMinutes() + m);
        if (t.getDate() !== dayOfMonth) break; // crossed midnight — done with this day
        if (
          t.getTime() >= from &&
          fieldMatches(min, t.getMinutes(), 59) &&
          fieldMatches(hour, t.getHours(), 23)
        ) {
          return t.getTime();
        }
      }
    }
    cursor.setDate(cursor.getDate() + 1);
    cursor.setHours(0, 0, 0, 0);
  }
  return null;
}

export function computeNextRun(schedule: ScheduleSpec, from: number): number | null {
  if (schedule.kind === 'interval') return from + schedule.minutes * 60_000;
  return nextCronRun(schedule.expr, from + 60_000);
}
