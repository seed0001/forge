import { useEffect, useRef, useState } from 'react';
import { useForge, useActiveWorkspace } from '../state/store';
import { IconEdit, IconRectangle, IconArrowDiag, IconType, IconUndo, IconX } from './icons';

type Tool = 'pen' | 'rect' | 'arrow' | 'text';

type Stroke =
  | { type: 'pen'; color: string; width: number; points: { x: number; y: number }[] }
  | { type: 'rect'; color: string; width: number; x0: number; y0: number; x1: number; y1: number }
  | { type: 'arrow'; color: string; width: number; x0: number; y0: number; x1: number; y1: number }
  | { type: 'text'; color: string; size: number; x: number; y: number; text: string };

const SWATCHES = ['#e0897c', '#d9a86c', '#e0d27c', '#7ec78a', '#7aa7d9', '#f2f2f1', '#000000'];

function drawArrowHead(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, width: number) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  const angle = Math.atan2(y1 - y0, x1 - x0);
  const head = Math.max(10, width * 3);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - head * Math.cos(angle - Math.PI / 6), y1 - head * Math.sin(angle - Math.PI / 6));
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - head * Math.cos(angle + Math.PI / 6), y1 - head * Math.sin(angle + Math.PI / 6));
  ctx.stroke();
}

function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke) {
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (s.type === 'pen') {
    ctx.lineWidth = s.width;
    ctx.beginPath();
    s.points.forEach((pt, i) => (i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y)));
    ctx.stroke();
  } else if (s.type === 'rect') {
    ctx.lineWidth = s.width;
    ctx.strokeRect(Math.min(s.x0, s.x1), Math.min(s.y0, s.y1), Math.abs(s.x1 - s.x0), Math.abs(s.y1 - s.y0));
  } else if (s.type === 'arrow') {
    ctx.lineWidth = s.width;
    drawArrowHead(ctx, s.x0, s.y0, s.x1, s.y1, s.width);
  } else {
    ctx.font = `600 ${s.size}px var(--font-ui, sans-serif)`;
    ctx.textBaseline = 'top';
    ctx.fillText(s.text, s.x, s.y);
  }
}

/**
 * A lightweight, from-scratch canvas markup tool — no canvas/image-editing
 * library exists anywhere else in this app, and this only needs pen/shape/text
 * annotation, not a real editor. Undo replays committed strokes over the base
 * image rather than snapshotting ImageData, which stays cheap regardless of
 * image resolution.
 */
export function PaintEditorOverlay() {
  const view = useActiveWorkspace();
  const closePaintEditor = useForge((s) => s.closePaintEditor);
  const addComposerImage = useForge((s) => s.addComposerImage);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const currentRef = useRef<Stroke | null>(null);

  const [ready, setReady] = useState(false);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState('#e0897c');
  const [width, setWidth] = useState(4);
  const [textDraft, setTextDraft] = useState<{ x: number; y: number; cssX: number; cssY: number; value: string } | null>(
    null
  );

  const target = view?.paintTarget ?? null;

  useEffect(() => {
    if (!target) return;
    setReady(false);
    setStrokes([]);
    setTool('pen');
    setTextDraft(null);
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
      }
      setReady(true);
    };
    img.src = target.src;
  }, [target?.src]);

  function redraw(extra?: Stroke) {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !img || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const s of strokes) drawStroke(ctx, s);
    if (extra) drawStroke(ctx, extra);
  }

  useEffect(() => {
    if (ready) redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, strokes]);

  function coordsFrom(e: React.PointerEvent) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    return { x: cssX * (canvas.width / rect.width), y: cssY * (canvas.height / rect.height), cssX, cssY };
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!ready) return;
    const { x, y, cssX, cssY } = coordsFrom(e);
    if (tool === 'text') {
      setTextDraft({ x, y, cssX, cssY, value: '' });
      return;
    }
    canvasRef.current?.setPointerCapture(e.pointerId);
    if (tool === 'pen') currentRef.current = { type: 'pen', color, width, points: [{ x, y }] };
    else currentRef.current = { type: tool, color, width, x0: x, y0: y, x1: x, y1: y };
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const cur = currentRef.current;
    if (!cur) return;
    const { x, y } = coordsFrom(e);
    if (cur.type === 'pen') cur.points.push({ x, y });
    else if (cur.type === 'rect' || cur.type === 'arrow') {
      cur.x1 = x;
      cur.y1 = y;
    }
    redraw(cur);
  }

  function onPointerUp() {
    if (!currentRef.current) return;
    setStrokes((s) => [...s, currentRef.current!]);
    currentRef.current = null;
  }

  function commitText() {
    if (textDraft && textDraft.value.trim()) {
      setStrokes((s) => [
        ...s,
        { type: 'text', color, size: Math.max(16, width * 5), x: textDraft.x, y: textDraft.y, text: textDraft.value },
      ]);
    }
    setTextDraft(null);
  }

  async function attachAndClose() {
    const canvas = canvasRef.current;
    if (!canvas || !target) return;
    canvas.toBlob(async (blob) => {
      if (!blob) return;
      const buffer = await blob.arrayBuffer();
      const base = target.name.replace(/\.[^./\\]+$/, '') || 'image';
      await addComposerImage(buffer, 'image/png', `${base}-edited.png`);
      closePaintEditor();
    }, 'image/png');
  }

  if (!target) return null;

  return (
    <div className="overlay">
      <div className="rev-head">
        <IconEdit className="icon" />
        <div className="col">
          <div className="rev-title">Edit image</div>
          <div className="rev-sub">{target.name}</div>
        </div>
        <div className="spacer" />
        <button className="iconbtn" onClick={closePaintEditor}>
          <IconX className="icon-sm" />
        </button>
      </div>

      <div className="paint-toolbar">
        <div className="paint-tools">
          <button className={`paint-tool${tool === 'pen' ? ' on' : ''}`} onClick={() => setTool('pen')} title="Pen">
            <IconEdit className="icon-sm" />
          </button>
          <button className={`paint-tool${tool === 'rect' ? ' on' : ''}`} onClick={() => setTool('rect')} title="Rectangle">
            <IconRectangle className="icon-sm" />
          </button>
          <button className={`paint-tool${tool === 'arrow' ? ' on' : ''}`} onClick={() => setTool('arrow')} title="Arrow">
            <IconArrowDiag className="icon-sm" />
          </button>
          <button className={`paint-tool${tool === 'text' ? ' on' : ''}`} onClick={() => setTool('text')} title="Text">
            <IconType className="icon-sm" />
          </button>
        </div>

        <div className="paint-swatches">
          {SWATCHES.map((c) => (
            <button
              key={c}
              className={`paint-swatch${color === c ? ' on' : ''}`}
              style={{ background: c }}
              onClick={() => setColor(c)}
              title={c}
            />
          ))}
          <input
            type="color"
            className="paint-colorpick"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            title="Custom color"
          />
        </div>

        <input
          type="range"
          min={2}
          max={20}
          value={width}
          onChange={(e) => setWidth(Number(e.target.value))}
          className="paint-width"
          title="Stroke width"
        />

        <div className="spacer" />
        <button className="iconbtn" onClick={() => setStrokes((s) => s.slice(0, -1))} disabled={!strokes.length} title="Undo">
          <IconUndo className="icon-sm" />
        </button>
        <button className="btn btn-outline" onClick={() => setStrokes([])} disabled={!strokes.length}>
          Clear
        </button>
      </div>

      <div className="paint-canvas-wrap">
        <div className="paint-canvas-inner" style={{ visibility: ready ? 'visible' : 'hidden' }}>
          <canvas
            ref={canvasRef}
            className="paint-canvas"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
          {textDraft && (
            <input
              autoFocus
              className="paint-text-input"
              style={{ left: textDraft.cssX, top: textDraft.cssY, color, fontSize: Math.max(16, width * 5) * 0.6 }}
              value={textDraft.value}
              onChange={(e) => setTextDraft({ ...textDraft, value: e.target.value })}
              onBlur={commitText}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitText();
                else if (e.key === 'Escape') setTextDraft(null);
              }}
            />
          )}
        </div>
        {!ready && <div className="paint-loading">Loading…</div>}
      </div>

      <div className="rev-foot">
        <div className="spacer" />
        <button className="btn btn-outline" onClick={closePaintEditor}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={attachAndClose} disabled={!ready}>
          Attach &amp; Close
        </button>
      </div>
    </div>
  );
}
