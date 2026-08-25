import { useEffect, useRef, useState } from 'react';
import { FONTS, applyFont, loadFontId } from '../lib/fonts';
import { IconCheck, IconType } from './icons';

export function FontPicker() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState(loadFontId);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => applyFont(current), [current]);

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

  return (
    <div className="fontpick" ref={ref}>
      <button className="seg-icon" onClick={() => setOpen((o) => !o)} title="Typeface">
        <IconType className="icon-sm" />
      </button>

      {open && (
        <div className="fontmenu">
          <div className="fontmenu-head">Typeface</div>
          {FONTS.map((f) => (
            <button
              key={f.id}
              className={`fontrow${f.id === current ? ' on' : ''}`}
              onClick={() => {
                setCurrent(f.id);
                setOpen(false);
              }}
            >
              <div className="fontrow-main">
                <div className="fontrow-top">
                  <span className="fontrow-name">{f.label}</span>
                  {f.id === current && <IconCheck className="icon-xs" />}
                </div>
                <div className="fontrow-note">{f.note}</div>
                <div
                  className="fontrow-sample"
                  style={{ fontFamily: f.stack, fontSize: `${13 * f.scale}px` }}
                >
                  {f.sample}
                </div>
              </div>
            </button>
          ))}
          <div className="fontmenu-foot">Code and terminal always stay monospace.</div>
        </div>
      )}
    </div>
  );
}
