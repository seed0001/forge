import type { SessionSummary } from '../../electron/ipc-channels';
import { useForge, useActiveWorkspace } from '../state/store';
import { relativeTime, formatDuration, formatCost } from '../lib/time';
import { IconPlus, IconX, IconDot } from './icons';

function formatTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);
}

/** Cool while there's plenty of room left, warm getting close, hot nearly out. */
function ctxClass(remaining: number): string {
  if (remaining <= 0.1) return 'hot';
  if (remaining <= 0.3) return 'warm';
  return 'cool';
}

const DAY = 86_400_000;

/** Group by recency the way the reference does: Today / This week / Older. */
function bucketOf(ts: number): string {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (ts >= start.getTime()) return 'Today';
  if (ts >= start.getTime() - DAY) return 'Yesterday';
  if (ts >= start.getTime() - 6 * DAY) return 'This week';
  return 'Older';
}

const ORDER = ['Today', 'Yesterday', 'This week', 'Older'];

export function SessionList() {
  const view = useActiveWorkspace();
  const newSession = useForge((s) => s.newSession);
  const selectSession = useForge((s) => s.selectSession);
  const deleteSession = useForge((s) => s.deleteSession);

  if (!view) return null;

  const groups = new Map<string, SessionSummary[]>();
  for (const s of view.sessions) {
    const key = bucketOf(s.updatedAt);
    const list = groups.get(key);
    if (list) list.push(s);
    else groups.set(key, [s]);
  }

  const activeId = view.summary.activeSessionId;
  const runningIds = view.summary.runningSessionIds;

  return (
    <>
      <button className="newsession" onClick={newSession}>
        <IconPlus className="icon-sm" />
        New session
      </button>

      <div className="sesslist">
        {view.sessions.length === 0 && <div className="tree-note" style={{ padding: '0 12px' }}>No sessions yet.</div>}

        {ORDER.filter((k) => groups.has(k)).map((key) => (
          <div key={key}>
            <div className="sessgroup">{key}</div>
            {groups.get(key)!.map((s) => {
              const hasContext = !!s.contextWindow && s.contextWindow > 0;
              const used = hasContext ? Math.min((s.contextUsed ?? 0) / s.contextWindow!, 1) : 0;
              const remaining = 1 - used;
              const remainingTokens = hasContext ? Math.max(s.contextWindow! - (s.contextUsed ?? 0), 0) : 0;
              const hasTime = !!s.elapsedMs && s.elapsedMs > 0;
              const hasCost = !!s.costUsd && s.costUsd > 0;
              return (
                <div
                  key={s.id}
                  className={`sessrow${s.id === activeId ? ' on' : ''}`}
                  onClick={() => selectSession(s.id)}
                >
                  <div className="sesstop">
                    {runningIds.includes(s.id) && (
                      <span title="Working">
                        <IconDot className="icon-xs sess-live" style={{ color: 'var(--amber)' }} />
                      </span>
                    )}
                    <div className="sesstitle">{s.title}</div>
                    <span className="sesstime">{relativeTime(s.updatedAt)}</span>
                    <button
                      className="sessdel"
                      title="Delete session"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteSession(s.id);
                      }}
                    >
                      <IconX className="icon-xs" />
                    </button>
                  </div>

                  {/* Always-on stat lines — context left, time spent, cost — so you can tell
                      at a glance how deep a session has gone without opening it. */}
                  {(hasContext || hasTime || hasCost) && (
                    <div className="sessstats">
                      {hasContext && (
                        <div
                          className="statrow"
                          title={`${formatTokens(remainingTokens)} tokens left of ${formatTokens(s.contextWindow!)} (${Math.round(used * 100)}% used)`}
                        >
                          <div className="ctxbar">
                            <div className={`ctxfill ${ctxClass(remaining)}`} style={{ width: `${Math.max(remaining * 100, 3)}%` }} />
                          </div>
                          <span className="statval">
                            {Math.round(used * 100)}% used
                            {s.compactionCount ? ` · compacted ${s.compactionCount}×` : ''}
                          </span>
                        </div>
                      )}
                      {hasTime && (
                        <div className="statrow statrow-plain">
                          <span className="statlabel">Time</span>
                          <span className="statval">{formatDuration(s.elapsedMs!)}</span>
                        </div>
                      )}
                      {hasCost && (
                        <div className="statrow statrow-plain">
                          <span className="statlabel">Cost</span>
                          <span className="statval">{formatCost(s.costUsd!)}</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </>
  );
}
