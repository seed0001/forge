import { useEffect, useRef, useState } from 'react';
import { useForge, useActiveWorkspace } from '../state/store';
import { IconArrowLeft, IconArrowRight, IconRefresh, IconBolt, IconDownload, IconCheck, IconX } from './icons';

export function BrowserPanel() {
  const view = useActiveWorkspace();
  const browserSetBounds = useForge((s) => s.browserSetBounds);
  const browserDetach = useForge((s) => s.browserDetach);
  const browserNavigate = useForge((s) => s.browserNavigate);
  const browserBack = useForge((s) => s.browserBack);
  const browserForward = useForge((s) => s.browserForward);
  const browserReload = useForge((s) => s.browserReload);
  const browserSummarize = useForge((s) => s.browserSummarize);
  const browserSaveClip = useForge((s) => s.browserSaveClip);
  const setClipsFolder = useForge((s) => s.setClipsFolder);

  const placeholderRef = useRef<HTMLDivElement>(null);
  const focusedRef = useRef(false);
  const lastRectRef = useRef('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<'summarize' | 'save' | null>(null);
  const [saveResult, setSaveResult] = useState<{ ok: boolean; message: string } | null>(null);

  const nav = view?.browserNav ?? null;

  // Keep the address bar in sync with real navigation, but never clobber what
  // the Operator is actively typing.
  useEffect(() => {
    if (!focusedRef.current) setDraft(nav?.url ?? '');
  }, [nav?.url]);

  // The real browser is a native view the main process overlays on top of
  // this placeholder — there's no DOM element to render it "into" here, so
  // its position/size has to be reported continuously (a plain resize
  // listener would miss a pure reposition, e.g. the sidebar changing width
  // without this element's own size changing).
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = placeholderRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        const key = `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`;
        if (key !== lastRectRef.current) {
          lastRectRef.current = key;
          void browserSetBounds({
            x: Math.round(r.x),
            y: Math.round(r.y),
            width: Math.round(r.width),
            height: Math.round(r.height),
          });
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      void browserDetach();
    };
  }, [browserSetBounds, browserDetach]);

  function submit() {
    const value = draft.trim();
    if (value) void browserNavigate(value);
  }

  async function handleSummarize() {
    setBusy('summarize');
    await browserSummarize();
    setBusy(null);
  }

  async function handleSave() {
    setBusy('save');
    let result = await browserSaveClip();
    // No clips folder picked yet for this workspace — prompt once and retry
    // immediately. This is a lightweight "where do clips go" folder, not the
    // project root — it never touches this workspace's chat/sessions.
    if (!result.ok && result.error === 'No folder set for this workspace yet.') {
      const picked = await setClipsFolder();
      if (picked) result = await browserSaveClip();
    }
    setBusy(null);
    setSaveResult(
      result.ok ? { ok: true, message: `Saved to ${result.path}` } : { ok: false, message: result.error }
    );
    setTimeout(() => setSaveResult(null), 4000);
  }

  return (
    <div className="browser">
      <div className="browser-bar">
        <button className="iconbtn" onClick={() => void browserBack()} disabled={!nav?.canGoBack} title="Back">
          <IconArrowLeft className="icon-sm" />
        </button>
        <button
          className="iconbtn"
          onClick={() => void browserForward()}
          disabled={!nav?.canGoForward}
          title="Forward"
        >
          <IconArrowRight className="icon-sm" />
        </button>
        <button className="iconbtn" onClick={() => void browserReload()} title="Reload">
          <IconRefresh className="icon-sm" />
        </button>

        <div className="browser-address">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={() => (focusedRef.current = true)}
            onBlur={() => {
              focusedRef.current = false;
              setDraft(nav?.url ?? '');
            }}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="Search or enter a URL"
            spellCheck={false}
          />
        </div>

        <button className="btn btn-outline" onClick={handleSummarize} disabled={!nav?.url || busy !== null}>
          <IconBolt className="icon-xs" />
          {busy === 'summarize' ? 'Summarizing…' : 'Summarize with AI'}
        </button>
        <button className="btn btn-outline" onClick={handleSave} disabled={!nav?.url || busy !== null}>
          <IconDownload className="icon-xs" />
          {busy === 'save' ? 'Saving…' : 'Save as Markdown'}
        </button>
      </div>

      {saveResult && (
        <div className={`browser-toast${saveResult.ok ? '' : ' err'}`}>
          {saveResult.ok ? <IconCheck className="icon-xs" /> : <IconX className="icon-xs" />}
          {saveResult.message}
        </div>
      )}

      <div className="browser-surface" ref={placeholderRef} />
    </div>
  );
}
