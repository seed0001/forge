import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useActiveWorkspace } from '../state/store';
import { forge } from '../lib/forge-api';
import type { AuditEntry } from '../../electron/ipc-channels';
import { IconRefresh, IconSearch } from './icons';

type FilterKey = 'all' | 'request' | 'error' | 'command' | 'file' | 'search' | 'write';

const FILTERS: { key: FilterKey; label: string; kinds: string[] }[] = [
  { key: 'all', label: 'All', kinds: [] },
  { key: 'error', label: 'Errors', kinds: ['error'] },
  { key: 'request', label: 'Requests', kinds: ['request'] },
  { key: 'command', label: 'Commands', kinds: ['command'] },
  { key: 'file', label: 'Files', kinds: ['read', 'list'] },
  { key: 'search', label: 'Searches', kinds: ['search'] },
  { key: 'write', label: 'Writes', kinds: ['write', 'revert'] },
];

/** Kinds that get their own colour; everything else is muted. */
const KIND_TONE: Record<string, string> = {
  error: 'err',
  request: 'req',
  command: 'cmd',
  write: 'write',
  revert: 'write',
  read: 'muted',
  list: 'muted',
  search: 'muted',
};

function clockOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour12: false });
}

function dayOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function AuditPanel() {
  const view = useActiveWorkspace();
  const workspaceId = view?.summary.id ?? null;

  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [present, setPresent] = useState(true);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [query, setQuery] = useState('');
  const [newestFirst, setNewestFirst] = useState(true);
  const [auto, setAuto] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    const res = await forge.audit.read(workspaceId);
    setPresent(res.present);
    setEntries(res.present ? res.entries : []);
    setLoading(false);
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The log grows while the agent works — poll so this view stays live
  // without a manual refresh, but only while auto-refresh is on.
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [auto, load]);

  const activeKinds = FILTERS.find((f) => f.key === filter)?.kinds ?? [];
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of entries ?? []) c[e.kind] = (c[e.kind] ?? 0) + 1;
    return c;
  }, [entries]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = (entries ?? []).filter((e) => {
      if (activeKinds.length && !activeKinds.includes(e.kind)) return false;
      if (!q) return true;
      return (
        e.detail.toLowerCase().includes(q) ||
        (e.outcome ?? '').toLowerCase().includes(q) ||
        e.kind.toLowerCase().includes(q)
      );
    });
    // Parsed order is chronological; reverse for newest-first.
    if (newestFirst) list = [...list].reverse();
    return list;
  }, [entries, activeKinds, query, newestFirst]);

  if (!view) return <div className="empty-pane" />;

  if (entries !== null && !present) {
    return (
      <div className="empty-pane">
        <div>No audit log for this project yet.</div>
        <div style={{ fontSize: 'var(--t-xs)', color: 'var(--fg-3)', maxWidth: 380 }}>
          Once the agent runs a command, reads a file, or makes a model request, it's written to{' '}
          <code>AUDIT.md</code> in the project root and shows up here.
        </div>
        <button className="btn btn-outline" onClick={() => void load()}>
          <IconRefresh className="icon-sm" />
          Check again
        </button>
      </div>
    );
  }

  return (
    <div className="audit">
      <div className="audit-head">
        <div className="side-tabs audit-filters">
          {FILTERS.map((f) => {
            const n = f.kinds.length ? f.kinds.reduce((s, k) => s + (counts[k] ?? 0), 0) : (entries ?? []).length;
            return (
              <button
                key={f.key}
                className={`side-tab${filter === f.key ? ' on' : ''}`}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
                {n > 0 && <span className="audit-count">{n}</span>}
              </button>
            );
          })}
        </div>
        <div className="spacer" />
        <div className="audit-search">
          <IconSearch className="icon-xs" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter…" />
        </div>
        <button
          className={`autonomy-trigger${newestFirst ? ' on' : ''}`}
          onClick={() => setNewestFirst((v) => !v)}
          title={newestFirst ? 'Newest first' : 'Oldest first'}
        >
          <span>{newestFirst ? 'Newest' : 'Oldest'}</span>
        </button>
        <button
          className={`autonomy-trigger${auto ? ' on' : ''}`}
          onClick={() => setAuto((v) => !v)}
          title="Auto-refresh every 3s while the agent works"
        >
          <span>Live</span>
        </button>
        <button className="autonomy-trigger" onClick={() => void load()} title="Refresh now" disabled={loading}>
          <IconRefresh className={`icon-xs${loading ? ' spin' : ''}`} />
        </button>
      </div>

      <div className="audit-body" ref={bodyRef}>
        {shown.length === 0 ? (
          <div className="tree-note" style={{ padding: 'var(--s4)' }}>
            {(entries ?? []).length === 0 ? 'Nothing logged yet.' : 'Nothing matches this filter.'}
          </div>
        ) : (
          <table className="audit-table">
            <tbody>
              {shown.map((e, i) => {
                const tone = KIND_TONE[e.kind] ?? 'muted';
                const oversize = e.kind === 'request' && /OVERSIZE/i.test(e.detail);
                return (
                  <tr key={i} className={`audit-row ${tone}${oversize ? ' oversize' : ''}`}>
                    <td className="audit-time" title={e.ts}>
                      <span className="audit-clock">{clockOf(e.ts)}</span>
                      <span className="audit-day">{dayOf(e.ts)}</span>
                    </td>
                    <td className="audit-kind">
                      <span className={`audit-badge ${tone}`}>{e.kind}</span>
                    </td>
                    <td className="audit-detail">
                      <span className="audit-detail-main">{e.detail}</span>
                      {e.outcome && <span className="audit-outcome">{e.outcome}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="audit-foot">
        {present && (entries?.length ?? 0) > 0 && (
          <span>
            {shown.length === (entries?.length ?? 0)
              ? `${entries?.length} entries`
              : `${shown.length} of ${entries?.length} entries`}
            {' · '}AUDIT.md
          </span>
        )}
      </div>
    </div>
  );
}
