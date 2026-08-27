import { useEffect } from 'react';
import { useForge, useActiveWorkspace } from './state/store';
import { TabStrip } from './components/TabStrip';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { EditorPanel } from './components/EditorPanel';
import { TerminalPanel } from './components/TerminalPanel';
import { RoadmapPanel } from './components/RoadmapPanel';
import { SchedulerPanel } from './components/SchedulerPanel';
import { BrowserPanel } from './components/BrowserPanel';
import { FocusPanel } from './components/FocusPanel';
import { ModeBar } from './components/ModeBar';
import { ReviewOverlay } from './components/ReviewOverlay';
import { PaintEditorOverlay } from './components/PaintEditorOverlay';
import { FontPicker } from './components/FontPicker';
import { AutonomySlider } from './components/AutonomySlider';
import { ProviderSelector } from './components/ProviderSelector';
import { ModelSelector } from './components/ModelSelector';
import { UpdateControl } from './components/UpdateControl';
import { SettingsOverlay } from './components/SettingsOverlay';
import { IconGear } from './components/icons';

const CHAT_VIEWS = [{ key: 'chat', label: 'Chat' }] as const;

const CODING_VIEWS = [
  { key: 'chat', label: 'Chat' },
  { key: 'editor', label: 'Editor' },
  { key: 'terminal', label: 'Terminal' },
  { key: 'roadmap', label: 'Roadmap' },
  { key: 'scheduler', label: 'Scheduler' },
] as const;

const BROWSING_VIEWS = [
  { key: 'browser', label: 'Browser' },
  { key: 'chat', label: 'Chat' },
] as const;

export default function App() {
  const init = useForge((s) => s.init);
  const setCenter = useForge((s) => s.setCenter);
  const openSettings = useForge((s) => s.openSettings);
  const view = useActiveWorkspace();

  useEffect(() => {
    init();
  }, [init]);

  // A brand-new workspace opens straight into chat; null is the legacy
  // "not chosen yet" state and behaves the same until the Operator picks.
  const kind = view?.summary.kind ?? null;
  const effectiveKind: 'chat' | 'coding' | 'browsing' = kind ?? 'chat';
  const VIEWS =
    effectiveKind === 'browsing' ? BROWSING_VIEWS : effectiveKind === 'coding' ? CODING_VIEWS : CHAT_VIEWS;
  const center = view?.center ?? (effectiveKind === 'browsing' ? 'browser' : 'chat');

  return (
    <div className="app">
      <TabStrip />
      <div className="shell">
        {!view ? (
          <div className="sidebar" />
        ) : (
          <>
            <Sidebar />
            <div className="center">
              <div className="center-head">
                <div className="segmented">
                  {VIEWS.map((v) => (
                    <button
                      key={v.key}
                      className={`seg${center === v.key ? ' on' : ''}`}
                      onClick={() => setCenter(v.key)}
                    >
                      {v.label}
                    </button>
                  ))}
                </div>
                <div className="spacer" />
                {view?.summary.rootPath && <div className="center-path">{view.summary.rootPath}</div>}
                <UpdateControl />
                <ProviderSelector />
                <ModelSelector />
                <AutonomySlider />
                <FontPicker />
                <button className="seg-icon" onClick={openSettings} title="Settings">
                  <IconGear className="icon-sm" />
                </button>
              </div>

              <div className="center-body">
                {center === 'chat' && <ChatView />}
                {center === 'editor' && <EditorPanel />}
                {center === 'terminal' && <TerminalPanel />}
                {center === 'roadmap' && <RoadmapPanel />}
                {center === 'scheduler' && <SchedulerPanel />}
                {center === 'browser' && <BrowserPanel />}
              </div>

              <ModeBar current={effectiveKind} chosen={kind !== null} />
            </div>
            <FocusPanel />
          </>
        )}
      </div>
      {view?.reviewing && <ReviewOverlay />}
      {view?.paintTarget && <PaintEditorOverlay />}
      <SettingsOverlay />
    </div>
  );
}
