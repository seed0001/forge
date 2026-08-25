import { useEffect } from 'react';
import { useForge, useActiveWorkspace } from './state/store';
import { TabStrip } from './components/TabStrip';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { EditorPanel } from './components/EditorPanel';
import { TerminalPanel } from './components/TerminalPanel';
import { ReviewOverlay } from './components/ReviewOverlay';
import { PaintEditorOverlay } from './components/PaintEditorOverlay';
import { FontPicker } from './components/FontPicker';
import { AutonomySlider } from './components/AutonomySlider';
import { ModelSelector } from './components/ModelSelector';

const VIEWS = [
  { key: 'chat', label: 'Chat' },
  { key: 'editor', label: 'Editor' },
  { key: 'terminal', label: 'Terminal' },
] as const;

export default function App() {
  const init = useForge((s) => s.init);
  const setCenter = useForge((s) => s.setCenter);
  const view = useActiveWorkspace();

  useEffect(() => {
    init();
  }, [init]);

  const center = view?.center ?? 'chat';

  return (
    <div className="app">
      <TabStrip />
      <div className="shell">
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
            <ModelSelector />
            <AutonomySlider />
            <FontPicker />
          </div>

          <div className="center-body">
            {center === 'chat' && <ChatView />}
            {center === 'editor' && <EditorPanel />}
            {center === 'terminal' && <TerminalPanel />}
          </div>
        </div>
      </div>
      {view?.reviewing && <ReviewOverlay />}
      {view?.paintTarget && <PaintEditorOverlay />}
    </div>
  );
}
