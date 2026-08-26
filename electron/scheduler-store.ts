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

function cronMatches(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [min, hour, day, month, weekday] = fields;
  return (
    fieldMatches(min, date.getMinutes(), 59) &&
    fieldMatches(hour, date.getHours(), 23) &&
    fieldMatches(day, date.getDate(), 31) &&
    fieldMatches(month, date.getMonth() + 1, 12) &&
    fieldMatches(weekday, date.getDay(), 6)
  );
}

/** True if `expr` parses as a plausible 5-field cron expression — used to validate before ever storing a task. */
export function isValidCronExpr(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  return fields.length === 5 && fields.every((f) => /^(\*|\*\/\d+|\d+(-\d+)?)(,(\*|\*\/\d+|\d+(-\d+)?))*$/.test(f));
}

/** Next minute-boundary timestamp at or after `from` matching a cron expression, searched forward up to ~2 years before giving up. */
export function nextCronRun(expr: string, from: number): number | null {
  const start = new Date(Math.ceil(from / 60_000) * 60_000);
  const cursor = new Date(start);
  for (let i = 0; i < 60 * 24 * 366 * 2; i++) {
    if (cronMatches(expr, cursor)) return cursor.getTime();
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

export function computeNextRun(schedule: ScheduleSpec, from: number): number | null {
  if (schedule.kind === 'interval') return from + schedule.minutes * 60_000;
  return nextCronRun(schedule.expr, from + 60_000);
}
