import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * Loader for the Operator's ruleset (rules/00-09).
 *
 * The ruleset defines its own disclosure model in 09-RULE-INDEX: Tier 0 modules
 * are present in every session and never unloaded; Tier 1 modules are read from
 * disk only when a trigger matches, and one module can cascade into others.
 * This implements that literally rather than pasting all ten files into every
 * prompt, which the ruleset explicitly does not want.
 */

export type ModuleId = '00' | '01' | '02' | '03' | '04' | '05' | '06' | '07' | '08' | '09';

const TIER0: ModuleId[] = ['00', '01', '02', '09'];

/** Tier-1 triggers, transcribed from the catalog in 09-RULE-INDEX. */
const TRIGGERS: Record<string, { id: ModuleId; pattern: RegExp }> = {
  context: {
    id: '03',
    pattern: /\b(remember|memory|scratch|context|session|resume|continue|long|multi-?step|plan)\b/i,
  },
  security: {
    id: '04',
    pattern: /\b(secret|token|api[_ -]?key|credential|password|env|install|npm i\b|pip install|curl|wget|fetch|download|permission|sudo)\b/i,
  },
  governance: {
    id: '05',
    pattern: /\b(delete|remove|rm\b|drop|destroy|overwrite|deploy|publish|push|commit|migrate|reset|irreversible|force)\b/i,
  },
  coding: {
    id: '06',
    pattern: /\b(code|function|class|component|refactor|bug|fix|test|typescript|javascript|python|config|implement|write|edit|file)\b/i,
  },
  accessibility: {
    id: '07',
    pattern: /\b(explain|document|readme|ui|ux|accessib|plain language|writing|copy|voice|dictat)\b/i,
  },
  engineering: {
    id: '08',
    pattern: /\b(architect|design|refactor|plan|migrate|scale|performance|structure|approach|trade-?off)\b/i,
  },
};

/** Cascades from 09-RULE-INDEX §2 — loading one module pulls in others. */
const CASCADES: Partial<Record<ModuleId, ModuleId[]>> = {
  '06': ['08', '03'],
  '08': ['03'],
  '05': ['04'],
};

export interface LoadedModule {
  id: ModuleId;
  name: string;
  text: string;
}

export class RuleSet {
  private dir: string | null;
  private available = new Map<ModuleId, string>();
  private loaded = new Set<ModuleId>();

  constructor(dir: string | null) {
    this.dir = dir && fs.existsSync(dir) ? dir : null;
    if (this.dir) {
      for (const file of fs.readdirSync(this.dir)) {
        const m = /^(\d{2})-.*\.md$/i.exec(file);
        if (m) this.available.set(m[1] as ModuleId, path.join(this.dir, file));
      }
    }
  }

  get enabled() {
    return this.dir !== null && this.available.size > 0;
  }

  get directory() {
    return this.dir;
  }

  get loadedIds(): ModuleId[] {
    return [...this.loaded].sort();
  }

  private async read(id: ModuleId): Promise<LoadedModule | null> {
    const file = this.available.get(id);
    if (!file) return null;
    try {
      const text = await fsp.readFile(file, 'utf8');
      return { id, name: path.basename(file), text };
    } catch {
      return null;
    }
  }

  /** Tier 0 — always present, loaded once at session start. */
  async loadAlways(): Promise<LoadedModule[]> {
    const out: LoadedModule[] = [];
    for (const id of TIER0) {
      if (this.loaded.has(id)) continue;
      const mod = await this.read(id);
      if (mod) {
        this.loaded.add(id);
        out.push(mod);
      }
    }
    return out;
  }

  /**
   * Tier 1 — match the text against the trigger catalog and return only modules
   * not already in the window (09 §3: never reload).
   */
  async loadForText(text: string): Promise<LoadedModule[]> {
    const wanted = new Set<ModuleId>();
    for (const { id, pattern } of Object.values(TRIGGERS)) {
      if (pattern.test(text)) wanted.add(id);
    }
    for (const id of [...wanted]) {
      for (const extra of CASCADES[id] ?? []) wanted.add(extra);
    }

    const out: LoadedModule[] = [];
    for (const id of [...wanted].sort()) {
      if (this.loaded.has(id)) continue;
      const mod = await this.read(id);
      if (mod) {
        this.loaded.add(id);
        out.push(mod);
      }
    }
    return out;
  }
}

/**
 * The rule text is the Operator's own instruction set, but it is still read off
 * disk. Fence it so its contents cannot be mistaken for a live instruction from
 * some other source, per the conventions in 00-MASTER and 01-TRUST.
 */
export function formatModule(mod: LoadedModule): string {
  return `[TRUSTED: Operator ruleset — ${mod.name}]\n${mod.text}\n[/TRUSTED]`;
}
