import { useEffect, useRef, useState } from 'react';
import { useForge } from '../state/store';
import { REASONING_LEVELS } from '../../electron/ipc-channels';
import { IconBrain } from './icons';

/**
 * Global "how hard should the model think per turn" control — Flash /
 * Thinking / Deep Thinking. Sits next to the model picker in the top
 * toolbar; the choice is sent as the provider's unified `reasoning` field on
 * every agent turn. Not workspace-scoped, same as the model choice.
 */
export function ReasoningSelector() {
  const level = useForge((s) => s.reasoningLevel);
  const setLevel = useForge((s) => s.setReasoningLevel);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const current = REASONING_LEVELS.find((l) => l.id === level) ?? REASONING_LEVELS[0];

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

  return (
    <div className="autonomy" ref={ref}>
      <button
        className={`autonomy-trigger${open ? ' on' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title="Reasoning depth"
      >
        <IconBrain className="icon-xs" style={{ color: 'var(--fg-3)' }} />
        <span>{current.label}</span>
      </button>

      {open && (
        <div className="autonomy-menu" style={{ width: 300 }}>
          <div className="autonomy-head">Reasoning</div>
          <div className="side-tabs" style={{ marginBottom: 'var(--s2)' }}>
            {REASONING_LEVELS.map((l) => (
              <button
                key={l.id}
                className={`side-tab${l.id === level ? ' on' : ''}`}
                onClick={() => {
                  void setLevel(l.id);
                  setOpen(false);
                }}
              >
                {l.label}
              </button>
            ))}
          </div>
          <div className="autonomy-blurb">{current.blurb}</div>
        </div>
      )}
    </div>
  );
}
