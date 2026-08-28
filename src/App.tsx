import { useEffect } from 'react';
import { useForge, useActiveWorkspace } from './state/store';
import { TabStrip } from './components/TabStrip';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { EditorPanel } from './components/EditorPanel';
import { TerminalPanel } from './components/TerminalPanel';
import { SchedulerPanel } from './components/SchedulerPanel';
import { AuditPanel } from './components/AuditPanel';
import { BrowserPanel } from './components/BrowserPanel';
import { FocusPanel } from './components/FocusPanel';
import { RoadmapSidePanel } from './components/RoadmapSidePanel';
import { ProcessPanel } from './components/ProcessPanel';
import { WorkspaceChooser } from './components/WorkspaceChooser';
import { ReviewOverlay } from './components/ReviewOverlay';
import { PaintEditorOverlay } from './components/PaintEditorOverlay';
import { FontPicker } from './components/FontPicker';
import { ProviderSelector } from './components/ProviderSelector';
import { ModelSelector } from './components/ModelSelector';
import { SettingsOverlay } from './components/SettingsOverlay';
import { ChangelogOverlay } from './components/ChangelogOverlay';
import { IconGear } from './components/icons';

const CODING_VIEWS = [
  { key: 'chat', label: 'Chat' },
  { key: 'editor', label: 'Editor' },
  { key: 'terminal', label: 'Terminal' },
  { key: 'scheduler', label: 'Scheduler' },
  { key: 'audit', label: 'Audit' },
] as const;

const BROWSING_VIEWS = [
  { key: 'browser', label: 'Browser' },
  { key: 'chat', label: 'Chat' },
  { key: 'audit', label: 'Audit' },
] as const;

export default function App() {
  const init = useForge((s) => s.init);
  const setCenter = useForge((s) => s.setCenter);
  const openSettings = useForge((s) => s.openSettings);
  const changelogOpen = useForge((s) => s.changelogOpen);
  const view = useActiveWorkspace();

  useEffect(() => {
    init();
  }, [init]);

  const kind = view?.summary.kind ?? null;
  const isBrowsing = kind === 'browsing';
  const VIEWS = isBrowsing ? BROWSING_VIEWS : CODING_VIEWS;
  // 'roadmap' used to be a center tab; it's a right-side panel now, so fall
  // back to chat for any session that had it selected.
  const rawCenter = view?.center ?? (isBrowsing ? 'browser' : 'chat');
  const center = rawCenter === 'roadmap' ? 'chat' : rawCenter;

  return (
    <div className="app">
      <TabStrip />
      <div className="shell">
        {kind === null ? (
          <WorkspaceChooser />
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
                <ProviderSelector />
                <ModelSelector />
                <FontPicker />
                <button className="seg-icon" onClick={openSettings} title="Settings">
                  <IconGear className="icon-sm" />
                </button>
              </div>

              <div className="center-body">
                {center === 'chat' && <ChatView />}
                {center === 'editor' && <EditorPanel />}
                {center === 'terminal' && <TerminalPanel />}
                {center === 'scheduler' && <SchedulerPanel />}
                {center === 'audit' && <AuditPanel />}
                {center === 'browser' && <BrowserPanel />}
              </div>
            </div>
            <ProcessPanel />
            <RoadmapSidePanel />
            <FocusPanel />
          </>
        )}
      </div>
      {view?.reviewing && <ReviewOverlay />}
      {view?.paintTarget && <PaintEditorOverlay />}
      {changelogOpen && <ChangelogOverlay />}
      <SettingsOverlay />
    </div>
  );
}
