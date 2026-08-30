import { useForge, useActiveWorkspace } from '../state/store';
import type { Mode } from '../../electron/ipc-channels';
import { IconBrain, IconCode } from './icons';

const MODES: { id: Mode; label: string; blurb: string }[] = [
  { id: 'plan', label: 'Plan', blurb: 'Read files and research only — no edits, commands, or generated files.' },
  { id: 'build', label: 'Build', blurb: 'Full tool access, governed by the autonomy level.' },
];

/**
 * Plan vs Build, the working stance for the project. Sits in the composer
 * chiprow next to the autonomy slider. A fresh project starts in Plan; the
 * agent can ask to switch but only the Operator flips it here.
 */
export function ModeToggle() {
  const view = useActiveWorkspace();
  const setMode = useForge((s) => s.setMode);
  if (!view) return null;

  const mode = view.summary.mode ?? 'plan';

  return (
    <div className="modetoggle" role="group" aria-label="Plan or Build mode">
      {MODES.map((m) => (
        <button
          key={m.id}
          className={`modetoggle-seg${mode === m.id ? ' on' : ''}`}
          onClick={() => mode !== m.id && setMode(m.id)}
          title={m.blurb}
          aria-pressed={mode === m.id}
        >
          {m.id === 'plan' ? <IconBrain className="icon-xs" /> : <IconCode className="icon-xs" />}
          <span>{m.label}</span>
        </button>
      ))}
    </div>
  );
}
