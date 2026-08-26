import { useState } from 'react';
import { useForge } from '../state/store';
import { IconCheckCircle, IconCopy, IconGlobe, IconRefresh, IconXCircle } from './icons';

/**
 * One button showing the phone portal's Cloudflare tunnel link — click to
 * copy it to the clipboard, ready to paste/AirDrop/text to your phone. See
 * electron/main.ts's startPortalTunnel for how the URL is obtained.
 */
export function PortalControl() {
  const status = useForge((s) => s.portalStatus);
  const [copied, setCopied] = useState(false);

  if (status.state === 'starting') {
    return (
      <button className="autonomy-trigger" disabled title="Starting the phone portal's Cloudflare tunnel…">
        <IconRefresh className="icon-xs spin" />
        <span>Portal starting…</span>
      </button>
    );
  }

  if (status.state === 'unavailable') {
    return (
      <button
        className="autonomy-trigger"
        style={{ color: 'var(--red)' }}
        disabled
        title={`Phone portal tunnel unavailable: ${status.reason}. Is cloudflared installed and on PATH?`}
      >
        <IconXCircle className="icon-xs" />
        <span>Portal unavailable</span>
      </button>
    );
  }

  return (
    <button
      className="autonomy-trigger"
      style={copied ? { color: 'var(--green)' } : undefined}
      onClick={() => {
        navigator.clipboard.writeText(status.url).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      title={`${status.url} — click to copy, then open it on your phone.`}
    >
      {copied ? <IconCheckCircle className="icon-xs" /> : <IconGlobe className="icon-xs" />}
      <span>{copied ? 'Link copied' : 'Phone link'}</span>
      {!copied && <IconCopy className="icon-xs" style={{ opacity: 0.6 }} />}
    </button>
  );
}
