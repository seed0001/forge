import { useEffect, useRef, useState } from 'react';
import { useForge } from '../state/store';
import { CHAT_PROVIDERS } from '../../electron/ipc-channels';
import { IconCheck, IconGlobe } from './icons';

/** Picks which chat-completion backend is active — OpenRouter, FairRouter, and (eventually) local runtimes like Ollama or llama.cpp. Separate from ModelSelector, which only ever lists the active provider's own models. */
export function ProviderSelector() {
  const currentProvider = useForge((s) => s.currentProvider);
  const selectProvider = useForge((s) => s.selectProvider);

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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

  const current = CHAT_PROVIDERS.find((p) => p.id === currentProvider);

  return (
    <div className="modelpick" ref={ref}>
      <button className={`autonomy-trigger${open ? ' on' : ''}`} onClick={() => setOpen((o) => !o)} title="Provider">
        <IconGlobe className="icon-xs" />
        <span>{current?.label ?? currentProvider}</span>
      </button>

      {open && (
        <div className="modelmenu" style={{ width: 200 }}>
          <div className="modelmenu-top">
            <div className="fontmenu-head" style={{ padding: 0 }}>
              Provider
            </div>
          </div>

          <div className="modellist">
            {CHAT_PROVIDERS.map((p) => (
              <button
                key={p.id}
                className={`modelrow${p.id === currentProvider ? ' on' : ''}`}
                onClick={() => {
                  void selectProvider(p.id);
                  setOpen(false);
                }}
              >
                <div className="modelrow-top">
                  <span className="modelrow-name">{p.label}</span>
                  {p.id === currentProvider && <IconCheck className="icon-xs" />}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
