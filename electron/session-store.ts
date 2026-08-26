import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { app } from 'electron';
import type { ChatMessage, ActivityEvent, RoadmapItem } from './ipc-channels';

/** A provider message, stored verbatim so a session can resume with full context. */
export type StoredMessage = Record<string, unknown>;

export interface Session {
  id: string;
  title: string;
  /** True once the AI-generated title has landed, so it is only requested once. */
  titled: boolean;
  createdAt: number;
  updatedAt: number;
  chat: ChatMessage[];
  activity: ActivityEvent[];
  /** The agent's raw conversation, minus the system prompt (rebuilt on load). */
  messages: StoredMessage[];
  /** This session's project roadmap, if the agent has proposed one — see RoadmapItem. */
  roadmap: RoadmapItem[];
  /** Tokens the last completion sent as context, and the model's window size. */
  contextUsed?: number;
  contextWindow?: number;
  /** Total real dollar cost of every completion this session has caused. */
  costUsd?: number;
  /** Total wall-clock milliseconds the agent has spent actively running on this session. */
  elapsedMs?: number;
  /** How many times this session's conversation has been auto-compacted. */
  compactionCount?: number;
}

export interface SessionSummary {
  id: string;
  title: string;
  preview: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  contextUsed?: number;
  contextWindow?: number;
  costUsd?: number;
  elapsedMs?: number;
  compactionCount?: number;
}

function previewOf(m: ChatMessage | undefined): string {
  if (!m) return '';
  if (m.text.trim()) return m.text;
  return m.images?.length ? '[image]' : '';
}

export function summarize(s: Session): SessionSummary {
  const lastUser = [...s.chat].reverse().find((m) => m.role === 'user');
  const lastAny = s.chat[s.chat.length - 1];
  return {
    id: s.id,
    title: s.title,
    preview: (previewOf(lastAny) || previewOf(lastUser)).replace(/\s+/g, ' ').slice(0, 120),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    messageCount: s.chat.length,
    contextUsed: s.contextUsed,
    contextWindow: s.contextWindow,
    costUsd: s.costUsd,
    elapsedMs: s.elapsedMs,
    compactionCount: s.compactionCount,
  };
}

/** Derive a readable title from the first thing the user asked. */
export function titleFrom(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return 'New session';
  const cut = clean.length > 52 ? `${clean.slice(0, 52).replace(/\s+\S*$/, '')}…` : clean;
  return cut.charAt(0).toUpperCase() + cut.slice(1);
}

/**
 * A short, stable id for a project root, used to key per-project storage
 * outside the project itself (sessions here; context-store.ts's knowledge
 * base reuses this too) — so opening a folder never writes into the user's
 * own repo.
 */
export function hashRoot(rootPath: string): string {
  return crypto.createHash('sha256').update(path.resolve(rootPath)).digest('hex').slice(0, 16);
}

function fileForRoot(rootPath: string): string {
  return path.join(app.getPath('userData'), 'sessions', `${hashRoot(rootPath)}.json`);
}

export async function loadSessions(rootPath: string | null): Promise<Session[]> {
  if (!rootPath) return [];
  try {
    const raw = await fs.readFile(fileForRoot(rootPath), 'utf8');
    const parsed = JSON.parse(raw) as { sessions?: Session[] };
    const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
    // Backward compat: sessions saved before this field existed have no roadmap.
    return sessions.map((s) => ({ ...s, roadmap: s.roadmap ?? [] }));
  } catch {
    return [];
  }
}

export async function saveSessions(rootPath: string | null, sessions: Session[]): Promise<void> {
  if (!rootPath) return;
  const file = fileForRoot(rootPath);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ rootPath, sessions }, null, 2), 'utf8');
  } catch {
    // Persistence failing must not take the running session down with it.
  }
}
