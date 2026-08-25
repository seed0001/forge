import { useForge } from '../state/store';
import { IconCheckCircle, IconDownload, IconRefresh, IconXCircle } from './icons';

/**
 * One button, one meaning at a time — always the next manual step, never an
 * automatic one. See electron/updater.ts for why nothing here fires on its
 * own: the Operator clicks Check, then (if something's found) clicks
 * Download, then (once it's on disk) clicks Restart & Install. Each stage
 * only ever happens because this exact button was clicked.
 */
export function UpdateControl() {
  const status = useForge((s) => s.updateStatus);
  const checkForUpdates = useForge((s) => s.checkForUpdates);
  const downloadUpdate = useForge((s) => s.downloadUpdate);
  const installUpdate = useForge((s) => s.installUpdate);

  switch (status.state) {
    case 'checking':
      return (
        <button className="autonomy-trigger" disabled title="Checking for updates…">
          <IconRefresh className="icon-xs spin" />
          <span>Checking…</span>
        </button>
      );

    case 'available':
      return (
        <button
          className="autonomy-trigger"
          style={{ color: 'var(--amber)' }}
          onClick={() => downloadUpdate()}
          title={`Forge ${status.version} is available. Click to download it.`}
        >
          <IconDownload className="icon-xs" />
          <span>Update {status.version}</span>
        </button>
      );

    case 'downloading':
      return (
        <button className="autonomy-trigger" disabled title={`Downloading ${status.version || 'update'}…`}>
          <IconDownload className="icon-xs" />
          <span>Downloading… {status.percent}%</span>
        </button>
      );

    case 'downloaded':
      return (
        <button
          className="autonomy-trigger"
          style={{ color: 'var(--green)' }}
          onClick={() => installUpdate()}
          title={`Forge ${status.version} is downloaded and ready. Click to quit and install it now.`}
        >
          <IconCheckCircle className="icon-xs" />
          <span>Restart & install {status.version}</span>
        </button>
      );

    case 'error':
      return (
        <button
          className="autonomy-trigger"
          style={{ color: 'var(--red)' }}
          onClick={() => checkForUpdates()}
          title={`Update check failed: ${status.message}. Click to try again.`}
        >
          <IconXCircle className="icon-xs" />
          <span>Update check failed</span>
        </button>
      );

    case 'not-available':
      return (
        <button className="autonomy-trigger" onClick={() => checkForUpdates()} title="You're on the latest version. Click to check again.">
          <IconCheckCircle className="icon-xs" style={{ color: 'var(--green)' }} />
          <span>Up to date</span>
        </button>
      );

    case 'idle':
    default:
      return (
        <button className="autonomy-trigger" onClick={() => checkForUpdates()} title="Check for a newer version">
          <IconRefresh className="icon-xs" />
          <span>Check for updates</span>
        </button>
      );
  }
}
