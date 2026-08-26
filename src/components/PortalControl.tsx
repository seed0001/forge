import { useEffect, useRef, useState } from 'react';
import { useForge } from '../state/store';
import { IconCheck, IconCopy, IconGlobe, IconRefresh, IconXCircle } from './icons';

/**
 * Settings-only control for the phone portal — off by default. Enabling it
 * starts a local server plus a temporary Cloudflare quick-tunnel; the
 * resulting link is shown here (and auto-copied once) rather than pushed to
 * an OS notification or a file on disk, so the only place this link ever
 * surfaces is the panel the Operator is already looking at when they asked
 * for it. See electron/main.ts's enablePortal/disablePortal.
 */
export function PortalControl() {
  const status = useForge((s) => s.portalStatus);
  const enablePortal = useForge((s) => s.enablePortal);
  const disablePortal = useForge((s) => s.disablePortal);
  const [copied, setCopied] = useState(false);
  const autoCopiedFor = useRef<string | null>(null);

  useEffect(() => {
    if (status.state !== 'ready') return;
    if (autoCopiedFor.current === status.url) return;
    autoCopiedFor.current = status.url;
    navigator.clipboard
      .writeText(status.url)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      })
      .catch(() => {});
  }, [status]);

  function copyLink() {
    if (status.state !== 'ready') return;
    navigator.clipboard.writeText(status.url).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="settings-section">
      <div className="settings-section-head">
        <div className="row" style={{ gap: 'var(--s2)' }}>
          <span className="settings-dot" style={{ background: status.state === 'ready' ? 'var(--green)' : 'var(--fg-3)' }} />
          <span className="settings-section-name">Phone portal</span>
        </div>
      </div>
      <div className="settings-section-blurb">
        Chat with this workspace from your phone's browser, using the same agent, tools, and permission
        settings as the desktop app. Off by default — enabling it starts a local server and a temporary
        public tunnel for as long as it stays on.
      </div>

      {status.state === 'disabled' && (
        <button className="btn btn-primary" onClick={() => void enablePortal()}>
          <IconGlobe className="icon-xs" />
          Enable phone portal
        </button>
      )}

      {status.state === 'starting' && (
        <button className="btn btn-outline" disabled>
          <IconRefresh className="icon-xs spin" />
          Starting…
        </button>
      )}

      {status.state === 'unavailable' && (
        <>
          <div className="settings-field-hint" style={{ color: 'var(--red)' }}>
            <IconXCircle className="icon-xs" style={{ verticalAlign: '-2px', marginRight: 4 }} />
            Couldn't start the tunnel — {status.reason}. Is cloudflared installed and on PATH?
          </div>
          <button className="btn btn-outline" onClick={() => void enablePortal()}>
            Try again
          </button>
        </>
      )}

      {status.state === 'ready' && (
        <>
          <label className="settings-field">
            <span className="settings-field-label">Your phone link</span>
            <div className="settings-input-wrap">
              <input
                className="settings-input mono"
                readOnly
                value={status.url}
                onFocus={(e) => e.currentTarget.select()}
              />
            </div>
            <span className="settings-field-hint">
              Open this on your phone to chat with this workspace remotely — it was just copied to your
              clipboard. Anyone with this link can use it exactly as you would from the desktop app,
              including running commands and editing files, based on whatever permissions are currently
              configured. Keep it private, and disable the portal when you're done with it.
            </span>
          </label>
          <div className="row" style={{ gap: 'var(--s2)' }}>
            <button className="btn btn-outline" onClick={copyLink}>
              {copied ? <IconCheck className="icon-xs" /> : <IconCopy className="icon-xs" />}
              {copied ? 'Copied' : 'Copy link'}
            </button>
            <button className="btn btn-outline" onClick={() => void disablePortal()}>
              Disable
            </button>
          </div>
        </>
      )}
    </div>
  );
}
