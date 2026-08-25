import { app, dialog } from 'electron';
// electron-updater is CommonJS; this process builds as ESM ("type": "module").
// A named import (`import { autoUpdater } from 'electron-updater'`) requires
// Node to statically detect that export via cjs-module-lexer, which fails for
// this package — it throws a SyntaxError at module-LINK time, before any code
// runs, killing the app on every launch before a window can even open. The
// default-import + destructure form below reads the property at runtime
// instead, which always works.
import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;

/** How often to poll GitHub Releases for a newer build, beyond the one check on launch. */
const CHECK_INTERVAL_MS = 4 * 60 * 60_000;

/**
 * Wires electron-updater to this repo's GitHub Releases (configured in
 * package.json's "build.publish"). Every packaged install polls that feed,
 * downloads a newer build silently in the background, and — once it's fully
 * on disk — asks the Operator whether to restart into it now or later. Only
 * runs when packaged: an unpackaged dev run has no update feed and
 * electron-updater errors immediately if asked to check.
 */
export function initAutoUpdater() {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err) => {
    console.error('[forge] update check failed:', err.message);
  });
  autoUpdater.on('update-available', (info) => {
    console.log(`[forge] update available: ${info.version} — downloading in the background`);
  });
  autoUpdater.on('update-not-available', () => {
    console.log('[forge] already on the latest version');
  });
  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[forge] update ${info.version} downloaded — asking to restart`);
    void dialog
      .showMessageBox({
        type: 'info',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        title: 'Update ready',
        message: `Forge ${info.version} has been downloaded.`,
        detail: 'Restart to finish installing it, or keep working and it will install the next time you quit.',
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
  });

  autoUpdater.checkForUpdates().catch((err) => console.error('[forge] initial update check failed:', err.message));
  setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => console.error('[forge] update check failed:', err.message));
  }, CHECK_INTERVAL_MS);
}
