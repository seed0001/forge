import { useForge } from '../state/store';
import { IconMessages, IconCode, IconGlobe } from './icons';
import type { WorkspaceKind } from '../../electron/ipc-channels';

const MODES: { key: Exclude<WorkspaceKind, null>; label: string; Icon: typeof IconCode; hint: string }[] = [
  { key: 'chat', label: 'Chat', Icon: IconMessages, hint: 'Just talk — no project folder.' },
  { key: 'coding', label: 'Coding', Icon: IconCode, hint: 'Open a folder: read files, run commands, review edits.' },
  { key: 'browsing', label: 'Browsing', Icon: IconGlobe, hint: 'An embedded browser you can clip pages from.' },
];

/**
 * The little mode switcher at the bottom of the workspace. A fresh workspace
 * opens in chat; this is how you turn it into a coding or browsing workspace
 * (or back), without a full-screen chooser in the way.
 */
export function ModeBar({ current, chosen }: { current: 'chat' | 'coding' | 'browsing'; chosen: boolean }) {
  const setWorkspaceKind = useForge((s) => s.setWorkspaceKind);
  const active = MODES.find((m) => m.key === current);

  return (
    <div className={`modebar${chosen ? '' : ' modebar-fresh'}`}>
      <div className="modebar-seg">
        {MODES.map(({ key, label, Icon }) => (
          <button
            key={key}
            className={`modebar-opt${current === key ? ' on' : ''}`}
            onClick={() => current !== key && setWorkspaceKind(key)}
            title={MODES.find((m) => m.key === key)!.hint}
          >
            <Icon className="icon-xs" />
            {label}
          </button>
        ))}
      </div>
      {active && <span className="modebar-hint">{active.hint}</span>}
    </div>
  );
}
