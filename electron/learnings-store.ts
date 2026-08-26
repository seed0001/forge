import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';

/**
 * A single, global (not per-project) list of "if X then Y" behavioral
 * lessons the agent has recorded about its own mistakes — the one thing this
 * gives the agent that a project's own knowledge base (context-store.ts)
 * can't: something it already learned on a DIFFERENT project applies here too.
 */
export interface Lesson {
  id: string;
  trigger: string;
  behavior: string;
  createdAt: number;
}

/** Oldest lessons drop off past this — a lesson list that only ever grows stops being skimmable, by the agent or the Operator. */
const MAX_LESSONS = 100;

let cache: Lesson[] | null = null;

function filePath(): string {
  return path.join(app.getPath('userData'), 'learnings.json');
}

async function load(): Promise<Lesson[]> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(filePath(), 'utf8');
    const parsed = JSON.parse(raw);
    cache = Array.isArray(parsed) ? parsed : [];
  } catch {
    cache = [];
  }
  return cache;
}

async function persist(lessons: Lesson[]): Promise<void> {
  cache = lessons;
  try {
    const file = filePath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(lessons, null, 2), 'utf8');
  } catch {
    // Best-effort — a failed write must not take down the agent turn that triggered it.
  }
}

export async function listLessons(): Promise<Lesson[]> {
  return load();
}

/** Adding a lesson with a trigger that already exists (case-insensitive) replaces it rather than duplicating it. */
export async function addLesson(trigger: string, behavior: string): Promise<Lesson> {
  const lessons = await load();
  const existingIdx = lessons.findIndex((l) => l.trigger.toLowerCase() === trigger.toLowerCase());
  const lesson: Lesson = {
    id: existingIdx >= 0 ? lessons[existingIdx].id : `lesson-${Date.now().toString(36)}`,
    trigger,
    behavior,
    createdAt: Date.now(),
  };
  const next = existingIdx >= 0 ? lessons.map((l, i) => (i === existingIdx ? lesson : l)) : [...lessons, lesson];
  await persist(next.slice(-MAX_LESSONS));
  return lesson;
}

/** Case-insensitive substring match of any lesson's trigger phrase against the given text — deliberately simple, no fuzzy matching. */
export async function matchLessons(text: string): Promise<Lesson[]> {
  const lessons = await load();
  const lower = text.toLowerCase();
  return lessons.filter((l) => lower.includes(l.trigger.toLowerCase()));
}
