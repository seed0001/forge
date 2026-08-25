import { useEffect, useState } from 'react';
import { useForge } from '../state/store';
import { forge } from '../lib/forge-api';

/** data URLs are cheap to keep around for the life of the window — one fetch per path, ever. */
const cache = new Map<string, string>();

/** A clickable thumbnail for one image attached to a chat message — opens the paint editor on click. */
export function ChatImageThumb({ path, name }: { path: string; name: string }) {
  const workspaceId = useForge((s) => s.activeId);
  const openPaintEditor = useForge((s) => s.openPaintEditor);
  const [src, setSrc] = useState(() => cache.get(path) ?? null);

  useEffect(() => {
    if (src || !workspaceId) return;
    let cancelled = false;
    forge.image.read(workspaceId, path).then((dataUrl) => {
      if (cancelled || !dataUrl) return;
      cache.set(path, dataUrl);
      setSrc(dataUrl);
    });
    return () => {
      cancelled = true;
    };
  }, [path, workspaceId, src]);

  if (!src) return <div className="chat-image chat-image-pending" title={name} />;

  return (
    <img
      className="chat-image"
      src={src}
      alt={name}
      title={`${name} — click to edit`}
      onClick={() => openPaintEditor(src, name)}
    />
  );
}
