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
  /** Fire once, this many minutes from when the request is processed — e.g. "remind me in 10 minutes" (not a recurring schedule; see ScheduleSpec's 'once' kind). */
  in_minutes?: unknown;
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
  const inMinutesRaw = typeof input.in_minutes === 'number' ? input.in_minutes : Number(input.in_minutes);
  const hasCron = cron !== '';
  const hasInterval = Number.isFinite(intervalRaw) && intervalRaw > 0;
  const hasOnce = Number.isFinite(inMinutesRaw) && inMinutesRaw > 0;
  const optionCount = Number(hasCron) + Number(hasInterval) + Number(hasOnce);
  if (optionCount !== 1) {
    return { ok: false, error: 'requires EXACTLY ONE of "cron" (recurring), "interval_minutes" (recurring), or "in_minutes" (fires once)' };
  }
  if (hasCron && !isValidCronExpr(cron)) {
    return { ok: false, error: `"${cron}" is not a valid 5-field cron expression (minute hour day month weekday)` };
  }

  const schedule: ScheduleSpec = hasCron
    ? { kind: 'cron', expr: cron }
    : hasInterval
      ? { kind: 'interval', minutes: Math.round(intervalRaw) }
      : { kind: 'once', at: Date.now() + Math.round(inMinutesRaw) * 60_000 };
  return { ok: true, label, prompt, schedule };
}

/**
 * Well-known project-root filename Codex (which has no access to Forge's
 * function-calling tools, only read/write/shell) can write to instead of
 * telling the Operator to use the Scheduler panel by hand. Written through
 * Codex's normal file-edit path, so it's gated by the same edit
 * permission/review as any other Codex write. project.ts processes it the
 * instant that write is approved (not waiting for the next tick — see
 * requestEditApproval), and also on every scheduler tick as a fallback, and
 * deletes it once processed (success or not) — see buildCodexPreamble in
 * agent-service.ts for the exact contract Codex is told to follow.
 */
export const SCHEDULE_REQUEST_FILENAME = '.forge-schedule-request.json';

/**
 * Written by project.ts immediately after processing a schedule-request
 * file — {"ok":true,...} or {"ok":false,"error":"..."}. Codex is required
 * (buildCodexPreamble) to read this back and relay its actual content
 * before claiming a reminder was created, instead of assuming its own file
 * write succeeded — the whole point being that "I wrote the file" and "the
 * task was actually created" are two different, independently-verifiable
 * facts, and only the second one is true confirmation.
 */
export const SCHEDULE_RESULT_FILENAME = '.forge-schedule-result.json';

/**
 * Always reflects the CURRENT list of this project's scheduled tasks —
 * rewritten by project.ts every time the list actually changes (create,
 * update, delete, or fire). Codex has no way to query live scheduler state
 * (it can't call listSchedules() the way the native tool loop's
 * AgentCallbacks can) — this file is its only grounded way to answer
 * "how much time is left on X" or "did Y fire yet" instead of guessing from
 * how much wall-clock time has passed in the conversation, which is exactly
 * how it previously claimed a reminder had "already fired" when nothing had
 * ever been created at all.
 */
export const SCHEDULE_STATUS_FILENAME = '.forge-schedule-status.json';

/** The subset of ScheduledTask fields worth telling Codex about via SCHEDULE_STATUS_FILENAME — omits sessionId, which is internal. */
export function summarizeSchedulesForStatusFile(tasks: ScheduledTask[]): Array<Record<string, unknown>> {
  return tasks.map((t) => ({
    id: t.id,
    label: t.label,
    schedule: t.schedule,
    enabled: t.enabled,
    nextRunAt: t.nextRunAt,
    lastRunAt: t.lastRunAt,
    lastResult: t.lastResult,
  }));
}

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
  if (schedule.kind === 'once') return schedule.at > from ? schedule.at : null;
  return nextCronRun(schedule.expr, from + 60_000);
}

/** Human-readable schedule description — "cron ...", "every N minute(s)", or "once at <time>" — shared by the schedule_task tool result, the Codex schedule-request confirmation, and the Scheduler panel's list view, so they can never describe the same ScheduleSpec differently. */
export function describeScheduleSpec(schedule: ScheduleSpec): string {
  if (schedule.kind === 'cron') return `cron "${schedule.expr}"`;
  if (schedule.kind === 'interval') return `every ${schedule.minutes} minute(s)`;
  return `once at ${new Date(schedule.at).toLocaleString()}`;
}
