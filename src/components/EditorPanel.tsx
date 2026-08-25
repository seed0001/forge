import Editor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { useEffect } from 'react';
import { useForge, useActiveWorkspace } from '../state/store';
import { languageFromPath } from '../lib/language';
import { IconX } from './icons';

loader.config({ monaco });

// Editor chrome tuned to the same warm-neutral ground as the app shell, so the
// code surface reads as part of the window rather than a pasted-in widget.
monaco.editor.defineTheme('forge', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#0e0e0e',
    'editorGutter.background': '#0e0e0e',
    'editor.lineHighlightBackground': '#171717',
    'editorLineNumber.foreground': '#4a4a48',
    'editorLineNumber.activeForeground': '#a8a8a4',
    'editorIndentGuide.background1': '#242424',
    'editor.selectionBackground': '#2e2e2e',
    'editorWidget.background': '#070707',
    'editorWidget.border': '#1b1b1b',
    'scrollbarSlider.background': '#2b2b2b55',
    'scrollbarSlider.hoverBackground': '#3a3a3a99',
  },
});

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
