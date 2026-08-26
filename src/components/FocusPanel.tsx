import { useEffect, useRef, useState } from 'react';
import { useForge, useActiveWorkspace } from '../state/store';
import type { ActivityEvent, FocusAgentStatus, FocusAgentSummary } from '../../electron/ipc-channels';
import { IconAgent, IconCheckCircle, IconChevronRight, IconDot, IconMinusCircle, IconStop, IconXCircle } from './icons';

function fmtDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const STATUS_COLOR: Record<FocusAgentStatus, string> = {
  running: 'var(--amber)',
  done: 'var(--green)',
  stopped: 'var(--fg-3)',
  expired: 'var(--fg-3)',
  error: 'var(--red)',
};

const STATUS_LABEL: Record<FocusAgentStatus, string> = {
  running: 'Running',
  done: 'Done',
  stopped: 'Stopped',
  expired: 'Time expired',
  error: 'Error',
};

function FocusAgentCard({
  agent,
  activity,
  now,
  onStop,
}: {
  agent: FocusAgentSummary;
  activity: ActivityEvent[];
  now: number;
  onStop: () => void;
}) {
  const trailRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    trailRef.current?.scrollTo({ top: trailRef.current.scrollHeight, behavior: 'smooth' });
  }, [activity.length]);

  // The backend only recomputes elapsedMs when something actually happens
  // (start/stop/finish) — see electron/workspace.ts's listFocusAgents. Tick
  // locally off startedAt while running so the clock/progress bar actually
  // moves in between those events instead of sitting frozen.
  const elapsedMs = agent.status === 'running' ? now - agent.startedAt : agent.elapsedMs;
  const pct = Math.min(100, Math.round((elapsedMs / agent.budgetMs) * 100));

  return (
    <div className="focus-card">
      <div className="focus-card-head">
        <IconDot className="icon-sm" style={{ color: STATUS_COLOR[agent.status] }} />
        <div className="col" style={{ minWidth: 0, flex: 1 }}>
          <div className="focus-card-title">{agent.label}</div>
          <div className="focus-card-task" title={agent.task}>
            {agent.task}
          </div>
        </div>
        {agent.status === 'running' && (
          // "Stop" is a hard abort, not a pause — AgentSession has no
          // resumable pause/resume primitive today, so there is nothing
          // between "running" and "stopped for good". Labeling it plainly
          // as Stop rather than inventing a fake Pause.
          <button className="mini reject" onClick={onStop} title="Stop this Focus agent (cannot be resumed)">
            <IconStop className="icon-xs" />
            Stop
          </button>
        )}
      </div>

      <div className="focus-progress">
        <div className="focus-progress-fill" style={{ width: `${pct}%`, background: STATUS_COLOR[agent.status] }} />
      </div>
      <div className="focus-card-meta">
        <span>{STATUS_LABEL[agent.status]}</span>
        <span>
          {fmtDuration(elapsedMs)} / {fmtDuration(agent.budgetMs)}
        </span>
      </div>

      {activity.length > 0 ? (
        <div className="focus-card-trail" ref={trailRef}>
          {activity.map((a) => (
            <div className={`trail-row ${a.status}`} key={a.id}>
              {a.status === 'active' ? (
                <IconDot className="icon-xs" />
              ) : a.status === 'error' ? (
                <IconXCircle className="icon-xs" />
              ) : a.status === 'skipped' ? (
                <IconMinusCircle className="icon-xs" />
              ) : (
                <IconCheckCircle className="icon-xs" />
              )}
              <span className="trail-detail">{a.detail}</span>
              {a.added !== undefined && <span className="stat-add">+{a.added}</span>}
              {a.removed !== undefined && <span className="stat-del">−{a.removed}</span>}
            </div>
          ))}
        </div>
      ) : (
        agent.status === 'running' && <div className="focus-card-empty">Waiting for activity…</div>
      )}
    </div>
  );
}

/**
 * A dockable right-edge panel listing every Focus agent in the active
 * workspace — the only place the Operator can see that one is running at
 * all, or stop it, since a Focus agent runs on its own dedicated background
 * session that never becomes the workspace's activeSessionId (so the main
 * chat's Stop button, which only ever targets the on-screen session, cannot
 * reach it). Renders nothing when there are no Focus agents to show.
 */
export function FocusPanel() {
  const view = useActiveWorkspace();
  const stopFocusAgent = useForge((s) => s.stopFocusAgent);
  const [collapsed, setCollapsed] = useState(false);

  const agents = view?.focusAgents ?? [];
  const anyRunning = agents.some((a) => a.status === 'running');

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyRunning]);

  if (!view || agents.length === 0) return null;

  if (collapsed) {
    return (
      <button className="focus-panel-collapsed" onClick={() => setCollapsed(false)} title="Show Focus agents">
        <IconAgent className="icon-sm" />
        <span className="focus-panel-count">{agents.length}</span>
        {anyRunning && <span className="focus-panel-livedot" />}
      </button>
    );
  }

  return (
    <div className="focus-panel">
      <div className="focus-panel-head">
        <IconAgent className="icon-sm" />
        <div className="focus-panel-title">Focus Agents</div>
        <div className="spacer" />
        <button className="focus-panel-toggle" onClick={() => setCollapsed(true)} title="Collapse">
          <IconChevronRight className="icon-xs" />
        </button>
      </div>
      <div className="focus-panel-body">
        {agents.map((agent) => (
          <FocusAgentCard
            key={agent.id}
            agent={agent}
            activity={view.focusActivity[agent.id] ?? []}
            now={now}
            onStop={() => void stopFocusAgent(agent.id)}
          />
        ))}
      </div>
    </div>
  );
}
