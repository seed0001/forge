import { useEffect, useMemo, useRef, useState } from 'react';
import { useForge } from '../state/store';
import { IconCheck, IconCpu, IconRefresh, IconSearch } from './icons';

type Filter = 'all' | 'free' | 'paid';

/** "anthropic/claude-3.5-sonnet" -> "claude-3.5-sonnet" — the part that actually varies. */
function shortName(id: string): string {
  const slash = id.lastIndexOf('/');
  return slash === -1 ? id : id.slice(slash + 1);
}

function priceLabel(perTokenUsd: number): string {
  const perMillion = perTokenUsd * 1_000_000;
  if (perMillion === 0) return '$0';
  if (perMillion < 0.01) return '<$0.01';
  return `$${perMillion.toFixed(2)}`;
}

export function ModelSelector() {
  const currentModel = useForge((s) => s.currentModel);
  const models = useForge((s) => s.models);
  const modelsLoading = useForge((s) => s.modelsLoading);
  const modelsError = useForge((s) => s.modelsError);
  const loadModels = useForge((s) => s.loadModels);
  const setModel = useForge((s) => s.setModel);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) void loadModels();
  }, [open, loadModels]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) searchRef.current?.focus();
    else {
      setQuery('');
      setFilter('all');
    }
  }, [open]);

  const freeCount = useMemo(() => models.filter((m) => m.isFree).length, [models]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return models.filter((m) => {
      if (filter === 'free' && !m.isFree) return false;
      if (filter === 'paid' && m.isFree) return false;
      if (!q) return true;
      return m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q);
    });
  }, [models, filter, query]);

  const current = models.find((m) => m.id === currentModel);

  return (
    <div className="modelpick" ref={ref}>
      <button className="autonomy-trigger" onClick={() => setOpen((o) => !o)} title="Model">
        <IconCpu className="icon-xs" style={{ color: current?.isFree ? 'var(--green)' : 'var(--fg-3)' }} />
        <span>{shortName(currentModel) || 'Select model'}</span>
      </button>

      {open && (
        <div className="modelmenu">
          <div className="modelmenu-top">
            <div className="fontmenu-head" style={{ padding: 0 }}>
              Model
            </div>
            <button
              className="modelrefresh"
              onClick={() => loadModels(true)}
              title="Refresh model list"
              disabled={modelsLoading}
            >
              <IconRefresh className="icon-xs" />
            </button>
          </div>

          <div className="modelsearch">
            <IconSearch className="icon-xs" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models…"
            />
          </div>

          <div className="side-tabs" style={{ padding: 0, marginBottom: 'var(--s2)' }}>
            <button className={`side-tab${filter === 'all' ? ' on' : ''}`} onClick={() => setFilter('all')}>
              All
            </button>
            <button className={`side-tab${filter === 'free' ? ' on' : ''}`} onClick={() => setFilter('free')}>
              Free{freeCount ? ` (${freeCount})` : ''}
            </button>
            <button className={`side-tab${filter === 'paid' ? ' on' : ''}`} onClick={() => setFilter('paid')}>
              Paid
            </button>
          </div>

          <div className="modellist">
            {modelsLoading && models.length === 0 && <div className="modelmenu-note">Loading models…</div>}
            {modelsError && models.length === 0 && (
              <div className="modelmenu-note modelmenu-error">
                Could not reach OpenRouter — {modelsError}
              </div>
            )}
            {!modelsLoading && !modelsError && filtered.length === 0 && (
              <div className="modelmenu-note">No models match.</div>
            )}
            {filtered.map((m) => (
              <button
                key={m.id}
                className={`modelrow${m.id === currentModel ? ' on' : ''}`}
                onClick={() => {
                  setModel(m.id);
                  setOpen(false);
                }}
                title={m.id}
              >
                <div className="modelrow-top">
                  <span className="modelrow-name">{m.name}</span>
                  {m.id === currentModel && <IconCheck className="icon-xs" />}
                </div>
                <div className="modelrow-meta">
                  <span className="modelrow-id mono">{m.id}</span>
                  {m.isFree ? (
                    <span className="modelbadge free">Free</span>
                  ) : (
                    <span className="modelbadge">
                      {priceLabel(m.promptPrice)}/{priceLabel(m.completionPrice)} · 1M tok
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
