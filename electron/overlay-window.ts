import { BrowserWindow, Menu, ipcMain, screen } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IPC } from './ipc-channels';

// This file is bundled into dist-electron/main.js (ESM) — `__dirname` isn't
// provided there, so derive it the same way main.ts does. Resolves to
// dist-electron/, next to overlay-preload.cjs.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The desktop companion layer: one frameless, transparent, always-on-top
 * BrowserWindow that spans the primary display. It's click-through everywhere
 * (setIgnoreMouseEvents) — the renderer flips it interactive only while the
 * cursor is actually over the Orb, so the desktop underneath stays fully usable.
 *
 * The roaming Orb itself is a canvas sprite positioned in screen space inside
 * this window; it never moves the window.
 */

export interface OverlayHost {
  /** Bring the main Forge window to the front (creating it if needed). */
  showMainWindow: () => void;
  /** Real quit — tears down the close-to-hide guard on the main window. */
  quit: () => void;
  /** A spoken request from the Operator, already transcribed. */
  ask: (text: string) => void;
  /** Abort whatever the Orb's agent is doing. */
  stopAgent: () => void;
}

let overlayWin: BrowserWindow | null = null;

/** Push a message to the Orb overlay renderer (no-op if it isn't up). */
export function overlaySend(channel: string, ...args: unknown[]): void {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send(channel, ...args);
}

function displayInfo() {
  const d = screen.getPrimaryDisplay();
  // `bounds` covers the whole screen incl. the taskbar; `workArea` is the part
  // apps normally get. The renderer needs both to find "above the clock" and
  // "along the taskbar".
  return { bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor };
}

export function createOverlayWindow(host: OverlayHost): BrowserWindow {
  const { bounds } = displayInfo();

  overlayWin = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    // Don't steal focus from whatever the user is working in. Context menus
    // still pop fine from a non-focusable window on Windows.
    focusable: false,
    // Nothing to paint until React mounts; avoids a transparent-window flash.
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  // Above the taskbar and most things, but 'screen-saver' would also cover
  // real fullscreen apps/games — 'pop-up-menu' sits just under those.
  overlayWin.setAlwaysOnTop(true, 'pop-up-menu');
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Click-through by default; forward:true still delivers mousemove so the
  // renderer can tell when the cursor enters the Orb.
  overlayWin.setIgnoreMouseEvents(true, { forward: true });

  const url = process.env.VITE_DEV_SERVER_URL;
  if (url) {
    overlayWin.loadURL(new URL('overlay.html', url).toString());
  } else {
    overlayWin.loadFile(path.join(__dirname, '..', 'dist', 'overlay.html'));
  }

  overlayWin.once('ready-to-show', () => overlayWin?.show());
  overlayWin.on('closed', () => {
    overlayWin = null;
  });

  // Keep the overlay matched to the display if resolution / taskbar changes.
  const onDisplayChange = () => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    const { bounds: b } = displayInfo();
    overlayWin.setBounds(b);
    overlayWin.webContents.send(IPC.overlayDisplayChanged, displayInfo());
  };
  screen.on('display-metrics-changed', onDisplayChange);
  screen.on('display-added', onDisplayChange);
  screen.on('display-removed', onDisplayChange);

  // ── IPC ────────────────────────────────────────────────────────────────
  ipcMain.on(IPC.overlaySetInteractive, (e, interactive: boolean) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    win?.setIgnoreMouseEvents(!interactive, { forward: true });
  });

  ipcMain.handle(IPC.overlayGetDisplay, () => displayInfo());

  ipcMain.on(IPC.overlayOpenForge, () => host.showMainWindow());

  ipcMain.on(IPC.overlayAsk, (_e, text: string) => {
    const t = String(text ?? '').trim();
    if (t) host.ask(t);
  });

  ipcMain.on(IPC.overlayStopAgent, () => host.stopAgent());

  let paused = false;
  ipcMain.on(IPC.overlayContextMenu, (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const menu = Menu.buildFromTemplate([
      { label: 'Open Forge', click: () => host.showMainWindow() },
      {
        label: paused ? 'Resume roaming' : 'Pause roaming',
        click: () => {
          paused = !paused;
          overlayWin?.webContents.send(IPC.overlaySetPaused, paused);
        },
      },
      { type: 'separator' },
      {
        label: 'Always on top',
        type: 'checkbox',
        checked: overlayWin?.isAlwaysOnTop() ?? true,
        click: (item) => overlayWin?.setAlwaysOnTop(item.checked, 'pop-up-menu'),
      },
      { type: 'separator' },
      { label: 'Quit Forge', click: () => host.quit() },
    ]);
    // The overlay is non-focusable; give the menu an explicit anchor window.
    if (win) menu.popup({ window: win });
    else menu.popup();
  });

  return overlayWin;
}

export function getOverlayWindow(): BrowserWindow | null {
  return overlayWin;
}
