import { useState } from 'react';
import { useForge, useActiveWorkspace } from '../state/store';
import type { Hunk, HunkDecision } from '../../electron/ipc-channels';
import { IconDiff, IconCheck, IconX, IconCheckCircle, IconXCircle, IconDot } from './icons';

function basename(p: string) {
  return p.split(/[\\/]/).pop() ?? p;
}

/** Walk a hunk's lines, tracking the real line number on each side. */
function walk(h: Hunk) {
  let oldLn = h.oldStart;
  let newLn = h.newStart;
  return h.lines.map((line, i) => {
    const p = line[0];
    const text = line.slice(1);
    if (p === '+') return { key: i, kind: 'add' as const, text, n: newLn++ };
    if (p === '-') return { key: i, kind: 'rem' as const, text, n: oldLn++ };
    oldLn++;
    return { key: i, kind: 'ctx' as const, text, n: newLn++ };
  });
}

export function ReviewOverlay() {
  const view = useActiveWorkspace();
  const closeReview = useForge((s) => s.closeReview);
  const decideHunk = useForge((s) => s.decideHunk);

  const diffs = Object.values(view?.pendingDiffs ?? {});
  const [selId, setSelId] = useState<string | null>(null);
  const selected = diffs.find((d) => d.id === selId) ?? diffs[0];

  if (diffs.length === 0) {
    return (
      <div className="overlay">
        <div className="rev-head">
          <IconDiff className="icon" />
          <div className="col">
            <div className="rev-title">Review</div>
            <div className="rev-sub">Everything has been decided</div>
          </div>
          <div className="spacer" />
          <button className="iconbtn" onClick={closeReview}><IconX className="icon-sm" /></button>
        </div>
        <div className="empty-pane">No changes are waiting for review.</div>
        <div className="rev-foot">
          <div className="spacer" />
          <button className="btn btn-outline" onClick={closeReview}>Done</button>
        </div>
      </div>
    );
  }

  const totalHunks = diffs.reduce((n, d) => n + d.hunks.length, 0);
  const decided = diffs.reduce(
    (n, d) => n + d.hunks.filter((h) => d.decisions[h.index] && d.decisions[h.index] !== 'pending').length,
    0
  );
  const added = diffs.reduce((n, d) => n + d.added, 0);
  const removed = diffs.reduce((n, d) => n + d.removed, 0);

  function statusOf(hunks: Hunk[], decisions: Record<number, HunkDecision>) {
    const vals = hunks.map((h) => decisions[h.index] ?? 'pending');
    if (vals.every((v) => v === 'accepted')) return 'accepted';
    if (vals.every((v) => v === 'rejected')) return 'rejected';
    return 'pending';
  }

  return (
    <div className="overlay">
      <div className="rev-head">
        <IconDiff className="icon" />
        <div className="col">
          <div className="rev-title">Review changes</div>
          <div className="rev-sub">
            {diffs.length} file{diffs.length === 1 ? '' : 's'} · <span className="stat-add">+{added}</span>{' '}
            <span className="stat-del">−{removed}</span> · nothing is on disk until you accept it
          </div>
        </div>
        <div className="spacer" />
        <button className="btn btn-outline" onClick={() => diffs.forEach((d) => decideHunk(d.id, 'all', 'rejected'))}>
          Reject all
        </button>
        <button className="btn btn-primary" onClick={() => diffs.forEach((d) => decideHunk(d.id, 'all', 'accepted'))}>
          <IconCheck className="icon-sm" />
          Accept all
        </button>
        <button className="iconbtn" onClick={closeReview}><IconX className="icon-sm" /></button>
      </div>

      <div className="rev-body">
        <div className="rev-files">
          {diffs.map((d) => {
            const st = statusOf(d.hunks, d.decisions);
            return (
              <div
                key={d.id}
                className={`rev-file${d.id === selected?.id ? ' sel' : ''}`}
                onClick={() => setSelId(d.id)}
              >
                {st === 'accepted' ? (
                  <IconCheckCircle className="icon-sm" style={{ color: 'var(--green)' }} />
                ) : st === 'rejected' ? (
                  <IconXCircle className="icon-sm" style={{ color: 'var(--red)' }} />
                ) : (
                  <IconDot className="icon-sm" style={{ color: 'var(--fg-3)' }} />
                )}
                <div className="col" style={{ minWidth: 0, flex: 1 }}>
                  <div className="rev-fname">{basename(d.path)}</div>
                  <div className="rev-fstat">
                    <span className="stat-add">+{d.added}</span>
                    <span className="stat-del">−{d.removed}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="rev-diff">
          {selected && (
            <>
              <div className="rev-dhead">
                <div className="rev-dname">{basename(selected.path)}</div>
                <div className="spacer" />
                <button className="mini reject" onClick={() => decideHunk(selected.id, 'all', 'rejected')}>
                  Reject file
                </button>
                <button className="mini accept" onClick={() => decideHunk(selected.id, 'all', 'accepted')}>
                  <IconCheck className="icon-xs" />
                  Accept file
                </button>
              </div>

              {selected.hunks.map((h) => {
                const d: HunkDecision = selected.decisions[h.index] ?? 'pending';
                return (
                  <div className="hunk" key={h.index}>
                    <div className="hunk-bar">
                      <span className="hunk-range">
                        @@ −{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
                      </span>
                      <div className="spacer" />
                      {d === 'pending' && (
                        <>
                          <button className="mini reject" onClick={() => decideHunk(selected.id, h.index, 'rejected')}>
                            Reject
                          </button>
                          <button className="mini accept" onClick={() => decideHunk(selected.id, h.index, 'accepted')}>
                            <IconCheck className="icon-xs" />
                            Accept
                          </button>
                        </>
                      )}
                      {d === 'accepted' && (
                        <>
                          <span className="state applied"><IconCheck className="icon-xs" />Applied</span>
                          <button className="mini flat" onClick={() => decideHunk(selected.id, h.index, 'accepted')}>
                            Undo
                          </button>
                        </>
                      )}
                      {d === 'rejected' && (
                        <>
                          <span className="state discarded"><IconX className="icon-xs" />Discarded</span>
                          <button className="mini flat" onClick={() => decideHunk(selected.id, h.index, 'rejected')}>
                            Undo
                          </button>
                        </>
                      )}
                    </div>
                    <div className={`dlines${d === 'rejected' ? ' muted' : ''}`}>
                      {walk(h).map((l) => (
                        <div className={`dline ${l.kind}`} key={l.key}>
                          <span className="dn">{l.n}</span>
                          <span className="ds">{l.kind === 'add' ? '+' : l.kind === 'rem' ? '−' : ' '}</span>
                          <span className="dt">{l.text || ' '}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>

      <div className="rev-foot">
        <span className="progress">{decided} / {totalHunks} decided</span>
        <div className="spacer" />
        <button className="btn btn-outline" onClick={closeReview}>Done</button>
      </div>
    </div>
  );
}
