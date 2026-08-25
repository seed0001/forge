import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';

let registered = false;

/**
 * Editor chrome tuned to the same warm-neutral ground as the app shell, so
 * the code surface reads as part of the window rather than a pasted-in
 * widget. Called from every component that mounts a Monaco <Editor> (not
 * just EditorPanel) — idempotent, so it's safe to call from more than one
 * module without caring which one runs first.
 */
export function registerForgeTheme(): void {
  if (registered) return;
  registered = true;
  loader.config({ monaco });
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
}
