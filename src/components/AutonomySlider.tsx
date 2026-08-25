import { useEffect, useRef, useState } from 'react';
import { useForge, useActiveWorkspace } from '../state/store';
import type { Autonomy } from '../../electron/ipc-channels';
import { IconBolt } from './icons';

const LEVELS: { id: Autonomy; label: string; blurb: string; color: string }[] = [
  {
    id: 'manual',
    label: 'Manual',
    blurb: 'Every command needs your yes before it runs. Edits still go through review.',
    color: 'var(--fg-3)',
  },
  {
    id: 'balanced',
    label: 'Balanced',
    blurb: 'Commands run on their own. Edits still wait in the review queue. (Default)',
    color: 'var(--amber)',
  },
  {
    id: 'auto',
    label: 'Auto',
    blurb: 'Commands run and edits are written to disk immediately — nothing waits for review.',
    color: 'var(--red)',
  },
];

export function AutonomySlider() {
  const view = useActiveWorkspace();
  const setAutonomy = useForge((s) => s.setAutonomy);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const level = view?.summary.autonomy ?? 'balanced';
  const idx = LEVELS.findIndex((l) => l.id === level);
  const current = LEVELS[idx] ?? LEVELS[1];

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

  function move(delta: number) {
    const next = LEVELS[Math.min(LEVELS.length - 1, Math.max(0, idx + delta))];
    if (next) setAutonomy(next.id);
  }

  if (!view) return null;

  return (
    <div className="autonomy" ref={ref}>
      <button className="autonomy-trigger" onClick={() => setOpen((o) => !o)} title="Autonomy level">
        <IconBolt className="icon-xs" style={{ color: current.color }} />
        <span>{current.label}</span>
      </button>

      {open && (
        <div className="autonomy-menu">
          <div className="autonomy-head">Autonomy</div>
          <div
            className="autonomy-track"
            role="slider"
            tabIndex={0}
            aria-label="Autonomy level"
            aria-valuemin={0}
            aria-valuemax={LEVELS.length - 1}
            aria-valuenow={idx}
            aria-valuetext={current.label}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); move(1); }
              if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); move(-1); }
              if (e.key === 'Home') { e.preventDefault(); setAutonomy(LEVELS[0].id); }
              if (e.key === 'End') { e.preventDefault(); setAutonomy(LEVELS[LEVELS.length - 1].id); }
            }}
          >
            <div className="autonomy-line" />
            <div
              className="autonomy-thumb"
              style={{ left: `${(idx / (LEVELS.length - 1)) * 100}%`, background: current.color }}
            />
            {LEVELS.map((l, i) => (
              <button
                key={l.id}
                className={`autonomy-stop${i === idx ? ' on' : ''}`}
                style={{ left: `${(i / (LEVELS.length - 1)) * 100}%` }}
                onClick={() => setAutonomy(l.id)}
                title={l.label}
              />
            ))}
          </div>
          <div className="autonomy-labels">
            {LEVELS.map((l) => (
              <span key={l.id} className={l.id === level ? 'on' : ''}>{l.label}</span>
            ))}
          </div>
          <div className="autonomy-blurb">{current.blurb}</div>
        </div>
      )}
    </div>
  );
}
