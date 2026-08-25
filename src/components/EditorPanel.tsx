import Editor from '@monaco-editor/react';
import { useEffect } from 'react';
import { useForge, useActiveWorkspace } from '../state/store';
import { languageFromPath } from '../lib/language';
import { registerForgeTheme } from '../lib/monaco-theme';
import { IconX } from './icons';

registerForgeTheme();

export function EditorPanel() {
  const view = useActiveWorkspace();
  const setActiveFile = useForge((s) => s.setActiveFile);
  const closeFile = useForge((s) => s.closeFile);
  const updateActiveContent = useForge((s) => s.updateActiveContent);
  const saveActiveFile = useForge((s) => s.saveActiveFile);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveActiveFile();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [saveActiveFile]);

  const active = view?.openFiles.find((f) => f.path === view.activeFilePath);

  return (
    <>
      <div className="filetabs">
        {view?.openFiles.map((f) => (
          <div
            key={f.path}
            className={`ftab${f.path === view.activeFilePath ? ' active' : ''}`}
            onClick={() => setActiveFile(f.path)}
          >
            <span>{f.name}</span>
            {f.isDirty && <div className="fdot" />}
            <button
              className="fclose"
              onClick={(e) => {
                e.stopPropagation();
                closeFile(f.path);
              }}
              aria-label={`Close ${f.name}`}
            >
              <IconX className="icon-xs" />
            </button>
          </div>
        ))}
      </div>

      <div className="editorwrap">
        {active ? (
          <Editor
            key={active.path}
            language={languageFromPath(active.path)}
            value={active.content}
            theme="forge"
            onChange={(v) => updateActiveContent(v ?? '')}
            options={{
              fontFamily: 'Cascadia Code, JetBrains Mono, ui-monospace, Consolas, monospace',
              fontSize: 13,
              lineHeight: 21,
              minimap: { enabled: true, renderCharacters: false },
              automaticLayout: true,
              scrollBeyondLastLine: false,
              padding: { top: 12, bottom: 12 },
              renderLineHighlight: 'line',
              smoothScrolling: true,
              cursorBlinking: 'smooth',
            }}
          />
        ) : (
          <div className="empty-pane">
            {view?.summary.rootPath ? 'Open a file from the sidebar.' : 'Open a folder to get started.'}
          </div>
        )}
      </div>
    </>
  );
}
