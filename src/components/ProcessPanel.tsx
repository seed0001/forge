import { useEffect, useMemo, useRef, useState } from 'react';
import { useForge, useActiveWorkspace, type ProcessTurn } from '../state/store';
import type { ActivityEvent } from '../../electron/ipc-channels';
import {
  IconAgent,
  IconChevronRight,
  IconChevronDown,
  IconDot,
  IconCheckCircle,
  IconXCircle,
  IconMinusCircle,
  IconFile,
  IconTerminal,
  IconSearch,
  IconEdit,
  IconRoadmap,
} from './icons';

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

function EventIcon({ e }: { e: ActivityEvent }) {
  if (e.status === 'error') return <IconXCircle className="icon-xs" style={{ color: 'var(--red)' }} />;
  if (e.status === 'skipped') return <IconMinusCircle className="icon-xs" style={{ color: 'var(--fg-3)' }} />;
  if (e.status === 'active') return <IconDot className="icon-xs" style={{ color: 'var(--amber)' }} />;
  switch (e.kind) {
    case 'read':
    case 'list':
    case 'analyze':
      return <IconFile className="icon-xs" style={{ color: 'var(--blue)' }} />;
    case 'run':
      return <IconTerminal className="icon-xs" style={{ color: 'var(--amber)' }} />;
    case 'search':
      return <IconSearch className="icon-xs" style={{ color: 'var(--fg-3)' }} />;
    case 'propose':
    case 'generate':
      return <IconEdit className="icon-xs" style={{ color: 'var(--green)' }} />;
    case 'roadmap':
      return <IconRoadmap className="icon-xs" style={{ color: 'var(--fg-2)' }} />;
    default:
      return <IconCheckCircle className="icon-xs" style={{ color: 'var(--fg-3)' }} />;
  }
}

function TurnStatusIcon({ turn }: { turn: ProcessTurn }) {
  if (turn.status === 'running') return <IconDot className="icon-xs proc-livedot" style={{ color: 'var(--amber)' }} />;
  if (turn.status === 'error') return <IconXCircle className="icon-xs" style={{ color: 'var(--red)' }} />;
  if (turn.status === 'stopped') return <IconMinusCircle className="icon-xs" style={{ color: 'var(--fg-3)' }} />;
  return <IconCheckCircle className="icon-xs" style={{ color: 'var(--green)' }} />;
}

function EventRow({ e }: { e: ActivityEvent }) {
  const [open, setOpen] = useState(false);
  const long = e.detail.length > 64;
  return (
    <div className={`proc-step ${e.status}`}>
      <button className="proc-step-head" onClick={() => long && setOpen((o) => !o)} style={{ cursor: long ? 'pointer' : 'default' }}>
        <EventIcon e={e} />
        <span className={`proc-step-detail${open ? ' open' : ''}`}>{e.detail}</span>
        {e.added !== undefined && <span className="stat-add">+{e.added}</span>}
        {e.removed !== undefined && <span className="stat-del">−{e.removed}</span>}
        {long && (open ? <IconChevronDown className="icon-xs proc-caret" /> : <IconChevronRight className="icon-xs proc-caret" />)}
      </button>
    </div>
  );
}

function TurnCard({ turn, forceOpen }: { turn: ProcessTurn; forceOpen: boolean }) {
  const [open, setOpen] = useState(forceOpen);
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);

  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open && turn.status === 'running') bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [turn.events.length, open, turn.status]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (turn.status !== 'running') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [turn.status]);

  const elapsed = (turn.endedAt ?? now) - turn.startedAt;

  return (
    <div className={`proc-turn ${turn.status}`}>
      <button className="proc-turn-head" onClick={() => setOpen((o) => !o)}>
        <TurnStatusIcon turn={turn} />
        <span className="proc-turn-label" title={turn.label}>
          {turn.label}
        </span>
        {open ? <IconChevronDown className="icon-xs proc-caret" /> : <IconChevronRight className="icon-xs proc-caret" />}
      </button>
      {open && (
        <div className="proc-turn-body" ref={bodyRef}>
          {turn.events.length === 0 ? (
            <div className="proc-empty">Waiting for the first step…</div>
          ) : (
            turn.events.map((e) => <EventRow key={e.id} e={e} />)
          )}
        </div>
      )}
      <div className="proc-turn-foot">
        <span>{fmtElapsed(elapsed)}</span>
        <span>·</span>
        <span>
          {turn.events.length} step{turn.events.length === 1 ? '' : 's'}
        </span>
        {turn.status === 'running' && (
          <>
            <span>·</span>
            <span className="proc-running">Running…</span>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Right-edge panel: a scrollable, expandable history of what the agent looked
 * at, reasoned about, and changed — grouped one card per run, newest last.
 * The active run is auto-expanded and ticks live. Renders nothing until
 * there's activity to show.
 */
export function ProcessPanel() {
  const view = useActiveWorkspace();
  const log = view?.processLog ?? [];
  const [collapsed, setCollapsed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const running = log.some((t) => t.status === 'running');
  const lastId = log[log.length - 1]?.id;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [lastId, running]);

  const totalSteps = useMemo(() => log.reduce((n, t) => n + t.events.length, 0), [log]);

  if (!view || log.length === 0) return null;

  if (collapsed) {
    return (
      <button className="proc-collapsed" onClick={() => setCollapsed(false)} title="Show activity">
        <IconAgent className="icon-sm" />
        <span className="proc-badge">{log.length}</span>
        {running && <span className="proc-panel-livedot" />}
      </button>
    );
  }

  return (
    <div className="proc-panel">
      <div className="proc-panel-head">
        <IconAgent className="icon-sm" />
        <div className="proc-panel-title">Activity</div>
        <span className="proc-panel-count">{totalSteps}</span>
        <div className="spacer" />
        <button className="focus-panel-toggle" onClick={() => setCollapsed(true)} title="Collapse">
          <IconChevronRight className="icon-xs" />
        </button>
      </div>
      <div className="proc-panel-body" ref={scrollRef}>
        {log.map((turn, i) => (
          <TurnCard key={turn.id} turn={turn} forceOpen={turn.status === 'running' || i === log.length - 1} />
        ))}
      </div>
    </div>
  );
}
