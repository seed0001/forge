import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from './ipc-channels';

export interface DisplayInfo {
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
}

contextBridge.exposeInMainWorld('overlayApi', {
  /** Toggle whether pointer events hit this window (true) or pass through to
   *  the desktop (false). Call true on pointer-enter of the Orb, false on leave. */
  setInteractive: (interactive: boolean) => ipcRenderer.send(IPC.overlaySetInteractive, interactive),
  contextMenu: () => ipcRenderer.send(IPC.overlayContextMenu),
  openForge: () => ipcRenderer.send(IPC.overlayOpenForge),
  getDisplay: (): Promise<DisplayInfo> => ipcRenderer.invoke(IPC.overlayGetDisplay),
  onDisplayChanged: (cb: (info: DisplayInfo) => void) => {
    const l = (_e: unknown, info: DisplayInfo) => cb(info);
    ipcRenderer.on(IPC.overlayDisplayChanged, l);
    return () => ipcRenderer.removeListener(IPC.overlayDisplayChanged, l);
  },
  onPausedChanged: (cb: (paused: boolean) => void) => {
    const l = (_e: unknown, paused: boolean) => cb(paused);
    ipcRenderer.on(IPC.overlaySetPaused, l);
    return () => ipcRenderer.removeListener(IPC.overlaySetPaused, l);
  },

  // ── voice conversation ──────────────────────────────────────────────
  /** Send a transcribed spoken request to the Orb's agent. */
  ask: (text: string) => ipcRenderer.send(IPC.overlayAsk, text),
  /** Abort whatever the agent is doing (barge-in / "never mind"). */
  stopAgent: () => ipcRenderer.send(IPC.overlayStopAgent),
  /** Audio for a reply to play (base64 + mime). */
  onSpeak: (cb: (clip: { b64: string; mime: string }) => void) => {
    const l = (_e: unknown, clip: { b64: string; mime: string }) => cb(clip);
    ipcRenderer.on(IPC.overlaySpeak, l);
    return () => ipcRenderer.removeListener(IPC.overlaySpeak, l);
  },
  onAgentActivity: (cb: (evt: unknown) => void) => {
    const l = (_e: unknown, evt: unknown) => cb(evt);
    ipcRenderer.on(IPC.overlayAgentActivity, l);
    return () => ipcRenderer.removeListener(IPC.overlayAgentActivity, l);
  },
  onAgentStatus: (cb: (running: boolean) => void) => {
    const l = (_e: unknown, running: boolean) => cb(running);
    ipcRenderer.on(IPC.overlayAgentStatus, l);
    return () => ipcRenderer.removeListener(IPC.overlayAgentStatus, l);
  },
  onAgentReply: (cb: (text: string) => void) => {
    const l = (_e: unknown, text: string) => cb(text);
    ipcRenderer.on(IPC.overlayAgentReply, l);
    return () => ipcRenderer.removeListener(IPC.overlayAgentReply, l);
  },
});
