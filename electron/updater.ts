import { app } from 'electron';
// electron-updater is CommonJS; this process builds as ESM ("type": "module").
// A named import (`import { autoUpdater } from 'electron-updater'`) requires
// Node to statically detect that export via cjs-module-lexer, which fails for
// this package — it throws a SyntaxError at module-LINK time, before any code
// runs, killing the app on every launch before a window can even open. The
// default-import + destructure form below reads the property at runtime
// instead, which always works.
import electronUpdater from 'electron-updater';
import type { UpdateStatus } from './ipc-channels';
const { autoUpdater } = electronUpdater;

/**
 * Nothing here runs unless the Operator asks for it — no check on launch, no
 * background polling, no auto-download. Three releases in a row went out
 * broken (a startup crash, then a blank window); a fully automatic updater
 * would have pushed each of those straight onto every running install with
 * no way to stop it, and a build that can't even launch can't show a "check
 * for updates" button to pull the fix either. Manual-only means a bad release
 * only ever affects someone who clicks Check, sees it, and chooses to
 * install it — never someone who just left the app running.
 */
let wired = false;
let onStatus: (status: UpdateStatus) => void = () => {};
/** electron-updater's 'download-progress' event carries no version — remembered from the preceding 'available'. */
let availableVersion = '';

export function initUpdater(cb: (status: UpdateStatus) => void) {
  onStatus = cb;
  if (wired) return;
  wired = true;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('error', (err) => onStatus({ state: 'error', message: err.message }));
  autoUpdater.on('update-available', (info) => {
    availableVersion = info.version;
    onStatus({ state: 'available', version: info.version });
  });
  autoUpdater.on('update-not-available', () => onStatus({ state: 'not-available' }));
  autoUpdater.on('download-progress', (p) => {
    onStatus({ state: 'downloading', version: availableVersion, percent: Math.round(p.percent) });
  });
  autoUpdater.on('update-downloaded', (info) => onStatus({ state: 'downloaded', version: info.version }));
}

/** Only meaningful when packaged — dev has no update feed and this would just error. */
export function canCheckForUpdates() {
  return app.isPackaged;
}

export async function checkForUpdates() {
  if (!app.isPackaged) {
    onStatus({ state: 'error', message: 'Update checks are not available in a dev build.' });
    return;
  }
  onStatus({ state: 'checking' });
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    onStatus({ state: 'error', message: err instanceof Error ? err.message : String(err) });
  }
}

export async function downloadUpdate() {
  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    onStatus({ state: 'error', message: err instanceof Error ? err.message : String(err) });
  }
}

/** Quits and installs — only ever called from the Operator clicking "Restart & Install". */
export function installUpdate() {
  autoUpdater.quitAndInstall();
}
