import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { hashRoot } from './session-store';

/**
 * A project's durable, structured knowledge base — distinct from SCRATCH.md
 * (free-form prose the model rewrites as it works) and from the conversation
 * itself (which compaction eventually summarizes away). A record here
 * survives forever, across every future session, and is re-injected into
 * context automatically within a budget (see resolveForPrompt) rather than
 * relying on the model remembering to read a file.
 */
export type RecordKind = 'fact' | 'rule' | 'procedure' | 'knowledge';

export interface ContextRecord {
  id: string;
  topicId: string;
  kind: RecordKind;
  title: string;
  content: string;
  tags: string[];
  /** 0-10, higher surfaces first once the context budget is tight. */
  priority: number;
  /** Always included regardless of budget — meant to be rare. */
  mandatory: boolean;
  /** id of an older record this replaces, if any. The old one is kept (for history) but excluded from context/search. */
  supersedes: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ContextTopic {
  id: string;
  name: string;
  description: string;
  createdAt: number;
}

export interface ContextRelationship {
  fromId: string;
  toId: string;
  note: string;
}

interface ContextStoreData {
  topics: ContextTopic[];
  records: ContextRecord[];
  relationships: ContextRelationship[];
}

function empty(): ContextStoreData {
  return { topics: [], records: [], relationships: [] };
}

/**
 * A ContextStore is keyed either by a project's root folder (hashed, as
 * before) or by a workspace's own id (workspaces have no folder to hash).
 * The two live under distinct sub-namespaces on disk so a project id and a
 * workspace id can never collide even if their raw strings happened to match.
 */
export type ContextScope = { kind: 'project'; rootPath: string } | { kind: 'workspace'; id: string };

function cacheKeyFor(scope: ContextScope): string {
  return scope.kind === 'project' ? `project:${hashRoot(scope.rootPath)}` : `workspace:${scope.id}`;
}

function fileForScope(scope: ContextScope): string {
  const sub =
    scope.kind === 'project' ? path.join('project', `${hashRoot(scope.rootPath)}.json`) : path.join('workspace', `${scope.id}.json`);
  return path.join(app.getPath('userData'), 'context', sub);
}

/** Keyed by cacheKeyFor(scope), so every ContextStore instance for the same project/workspace (primary session, its subagents) shares one in-memory copy. */
const cache = new Map<string, ContextStoreData>();

async function load(scope: ContextScope): Promise<ContextStoreData> {
  const key = cacheKeyFor(scope);
  const cached = cache.get(key);
  if (cached) return cached;
  let data: ContextStoreData;
  try {
    const raw = await fs.readFile(fileForScope(scope), 'utf8');
    const parsed = JSON.parse(raw) as Partial<ContextStoreData>;
    data = {
      topics: Array.isArray(parsed.topics) ? parsed.topics : [],
      records: Array.isArray(parsed.records) ? parsed.records : [],
      relationships: Array.isArray(parsed.relationships) ? parsed.relationships : [],
    };
  } catch {
    data = empty();
  }
  cache.set(key, data);
  return data;
}

async function persist(scope: ContextScope, data: ContextStoreData): Promise<void> {
  cache.set(cacheKeyFor(scope), data);
  try {
    const file = fileForScope(scope);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
  } catch {
    // Best-effort — a failed write must not take down the agent turn that triggered it.
  }
}

let idSeq = 0;
function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${idSeq}`;
}

function liveRecords(data: ContextStoreData): ContextRecord[] {
  const superseded = new Set(data.records.map((r) => r.supersedes).filter((id): id is string => !!id));
  return data.records.filter((r) => !superseded.has(r.id));
}

export class ContextStore {
  constructor(private scope: ContextScope) {}

  async listTopics(): Promise<ContextTopic[]> {
    return (await load(this.scope)).topics;
  }

  async createTopic(name: string, description: string): Promise<ContextTopic> {
    const data = await load(this.scope);
    const existing = data.topics.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (existing) return existing;
    const topic: ContextTopic = { id: nextId('topic'), name, description, createdAt: Date.now() };
    data.topics.push(topic);
    await persist(this.scope, data);
    return topic;
  }

  async deleteTopic(topicId: string): Promise<boolean> {
    const data = await load(this.scope);
    const before = data.topics.length;
    data.topics = data.topics.filter((t) => t.id !== topicId);
    data.records = data.records.filter((r) => r.topicId !== topicId);
    const remainingIds = new Set(data.records.map((r) => r.id));
    data.relationships = data.relationships.filter((rel) => remainingIds.has(rel.fromId) && remainingIds.has(rel.toId));
    await persist(this.scope, data);
    return data.topics.length < before;
  }

  async addRecord(input: {
    topicId: string;
    kind: RecordKind;
    title: string;
    content: string;
    tags?: string[];
    priority?: number;
    mandatory?: boolean;
    supersedes?: string;
  }): Promise<ContextRecord | { error: string }> {
    const data = await load(this.scope);
    if (!data.topics.some((t) => t.id === input.topicId)) {
      return { error: `No topic with id "${input.topicId}". Create one first with memory_topic.` };
    }
    if (input.supersedes && !data.records.some((r) => r.id === input.supersedes)) {
      return { error: `No record with id "${input.supersedes}" to supersede.` };
    }
    const now = Date.now();
    const record: ContextRecord = {
      id: nextId('rec'),
      topicId: input.topicId,
      kind: input.kind,
      title: input.title,
      content: input.content,
      tags: input.tags ?? [],
      priority: Math.min(10, Math.max(0, input.priority ?? 5)),
      mandatory: !!input.mandatory,
      supersedes: input.supersedes ?? null,
      createdAt: now,
      updatedAt: now,
    };
    data.records.push(record);
    await persist(this.scope, data);
    return record;
  }

  async updateRecord(
    id: string,
    patch: Partial<Pick<ContextRecord, 'title' | 'content' | 'tags' | 'priority' | 'mandatory'>>
  ): Promise<ContextRecord | { error: string }> {
    const data = await load(this.scope);
    const record = data.records.find((r) => r.id === id);
    if (!record) return { error: `No record with id "${id}".` };
    if (patch.title !== undefined) record.title = patch.title;
    if (patch.content !== undefined) record.content = patch.content;
    if (patch.tags !== undefined) record.tags = patch.tags;
    if (patch.priority !== undefined) record.priority = Math.min(10, Math.max(0, patch.priority));
    if (patch.mandatory !== undefined) record.mandatory = patch.mandatory;
    record.updatedAt = Date.now();
    await persist(this.scope, data);
    return record;
  }

  async deleteRecord(id: string): Promise<boolean> {
    const data = await load(this.scope);
    const before = data.records.length;
    data.records = data.records.filter((r) => r.id !== id);
    data.relationships = data.relationships.filter((rel) => rel.fromId !== id && rel.toId !== id);
    await persist(this.scope, data);
    return data.records.length < before;
  }

  /** Free-text search across title/content/tags. Superseded records never surface — only the latest version of a fact should. */
  async search(query: string, topicId?: string): Promise<ContextRecord[]> {
    const data = await load(this.scope);
    const q = query.trim().toLowerCase();
    return liveRecords(data)
      .filter((r) => !topicId || r.topicId === topicId)
      .filter(
        (r) =>
          !q ||
          r.title.toLowerCase().includes(q) ||
          r.content.toLowerCase().includes(q) ||
          r.tags.some((t) => t.toLowerCase().includes(q))
      )
      .sort((a, b) => Number(b.mandatory) - Number(a.mandatory) || b.priority - a.priority);
  }

  /**
   * Assembles a system-prompt-ready package within a rough character budget
   * (no real tokenizer available here, so this trades exactness for
   * simplicity) — every mandatory record first regardless of budget, then
   * the rest by priority until it runs out. Called fresh every turn (see
   * agent-service.ts's send()) since a record can change mid-task, so this
   * is deliberately cheap: an in-memory read, no disk I/O once cached.
   */
  async resolveForPrompt(charBudget: number): Promise<{ text: string | null; included: number; omitted: number }> {
    const data = await load(this.scope);
    const live = liveRecords(data);
    const mandatory = live.filter((r) => r.mandatory);
    const optional = live.filter((r) => !r.mandatory).sort((a, b) => b.priority - a.priority);

    const chosen: ContextRecord[] = [];
    let used = 0;
    for (const r of [...mandatory, ...optional]) {
      const size = r.title.length + r.content.length + 24;
      if (r.mandatory || used + size <= charBudget) {
        chosen.push(r);
        used += size;
      }
    }
    if (!chosen.length) return { text: null, included: 0, omitted: live.length };

    const byTopic = new Map<string, ContextRecord[]>();
    for (const r of chosen) {
      if (!byTopic.has(r.topicId)) byTopic.set(r.topicId, []);
      byTopic.get(r.topicId)!.push(r);
    }
    const lines: string[] = [];
    for (const [topicId, records] of byTopic) {
      const topic = data.topics.find((t) => t.id === topicId);
      lines.push(`### ${topic?.name ?? topicId}`);
      for (const r of records) lines.push(`- [${r.kind}${r.mandatory ? ', mandatory' : ''}] ${r.title}: ${r.content}`);
    }
    return { text: lines.join('\n'), included: chosen.length, omitted: live.length - chosen.length };
  }
}
