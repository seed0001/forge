import { useEffect } from 'react';
import changelog from '../../CHANGELOG.md?raw';
import { useForge } from '../state/store';
import { Markdown } from './Markdown';
import { IconList, IconX } from './icons';

/**
 * The "What's New" view — the full changelog, baked into the build at compile
 * time from CHANGELOG.md, so it always describes exactly the version that's
 * installed (and everything before it). Opened from the version label in the
 * sidebar footer.
 */
export function ChangelogOverlay() {
  const close = useForge((s) => s.closeChangelog);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);

  return (
    <div className="overlay">
      <div className="settings-topbar">
        <IconList className="icon" />
        <div className="col">
          <div className="rev-title">What's New</div>
          <div className="rev-sub">Every release of Forge, newest first — v{__APP_VERSION__} installed</div>
        </div>
        <div className="spacer" />
        <button className="iconbtn" onClick={close} title="Close">
          <IconX className="icon-sm" />
        </button>
      </div>

      <div className="changelog-body">
        <div className="changelog-inner">
          <Markdown>{changelog}</Markdown>
        </div>
      </div>
    </div>
  );
}
