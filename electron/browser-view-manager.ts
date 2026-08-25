import { WebContentsView } from 'electron';
import type { BrowserWindow } from 'electron';
import type { BrowserNavState } from './ipc-channels';
import { buildExtractionScript, type ExtractedPage } from './page-extract';

export type BrowserViewEmit = (workspaceId: string, state: BrowserNavState) => void;

/**
 * Electron's default User-Agent identifies itself with an "Electron/x.y.z"
 * (and the app name) token — plenty of sites, Google search included, treat
 * that as automated/suspicious traffic and throw a CAPTCHA at it. This is a
 * normal desktop Chrome UA instead — built from the REAL Chromium version
 * this Electron build actually ships (process.versions.chrome), so it never
 * goes stale across Electron upgrades, just presenting as what this
 * genuinely is under the hood: a Chromium browser being used by a person.
 */
const DESKTOP_CHROME_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;

/** A bare domain/host ("example.com", "localhost:3000") gets https:// prepended; anything else that isn't already a URL is treated as a search query. */
function normalizeUrlOrSearch(input: string): string {
  const trimmed = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/i.test(trimmed) && !trimmed.includes(' ')) {
    return `https://${trimmed}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

/**
 * Owns the single live WebContentsView shown for whichever Browsing
 * workspace's Browser tab is currently on screen — only one is ever
 * attached to the window at a time. Switching away detaches it (its nav
 * state is remembered so switching back restores it by renavigating);
 * switching to a different browsing workspace reuses the same view
 * instance, just renavigated. This is a full, separate Chromium renderer —
 * deliberately no preload script and no access to anything forge.* exposes,
 * so a browsed page can never reach Forge's own APIs.
 */
export class BrowserViewManager {
  private view: WebContentsView | null = null;
  private win: BrowserWindow | null = null;
  /** Whether `view` is CURRENTLY a child of `win`'s contentView — tracked explicitly rather than inferred from `win`, because `win` alone can't tell "attached to this same window, but currently detached" apart from "never attached to it yet". Getting that wrong is exactly what silently broke reattaching after switching tabs. */
  private attached = false;
  private currentWorkspaceId: string | null = null;
  private lastState = new Map<string, BrowserNavState>();
  private emit: BrowserViewEmit;

  constructor(emit: BrowserViewEmit) {
    this.emit = emit;
  }

  private ensureView(): WebContentsView {
    if (this.view) return this.view;
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const wc = view.webContents;
    wc.setUserAgent(DESKTOP_CHROME_UA);
    const pushState = () => {
      const workspaceId = this.currentWorkspaceId;
      if (!workspaceId) return;
      const state: BrowserNavState = {
        url: wc.getURL(),
        title: wc.getTitle() || wc.getURL(),
        canGoBack: wc.canGoBack(),
        canGoForward: wc.canGoForward(),
        loading: wc.isLoading(),
      };
      this.lastState.set(workspaceId, state);
      this.emit(workspaceId, state);
    };
    wc.on('did-start-loading', pushState);
    wc.on('did-stop-loading', pushState);
    wc.on('did-navigate', pushState);
    wc.on('did-navigate-in-page', pushState);
    wc.on('page-title-updated', pushState);
    this.view = view;
    return view;
  }

  /** Attaches (creating on first use) and shows this workspace's browser, positioned over `bounds`. */
  attach(win: BrowserWindow, workspaceId: string, bounds: { x: number; y: number; width: number; height: number }) {
    const view = this.ensureView();
    if (this.win !== win) {
      if (this.attached && this.win) this.win.contentView.removeChildView(view);
      this.win = win;
      this.attached = false;
    }
    if (!this.attached) {
      win.contentView.addChildView(view);
      this.attached = true;
    }
    if (this.currentWorkspaceId !== workspaceId) {
      this.currentWorkspaceId = workspaceId;
      const remembered = this.lastState.get(workspaceId);
      void view.webContents.loadURL(remembered?.url || 'https://www.google.com');
    }
    view.setBounds(bounds);
  }

  /** Hides the view without destroying it — reused for whichever workspace attaches next. */
  detach() {
    if (this.view && this.win && this.attached) {
      this.win.contentView.removeChildView(this.view);
      this.attached = false;
    }
    this.currentWorkspaceId = null;
  }

  setBounds(bounds: { x: number; y: number; width: number; height: number }) {
    this.view?.setBounds(bounds);
  }

  navigate(url: string) {
    if (!this.view) return;
    void this.view.webContents.loadURL(normalizeUrlOrSearch(url));
  }

  back() {
    if (this.view?.webContents.canGoBack()) this.view.webContents.goBack();
  }

  forward() {
    if (this.view?.webContents.canGoForward()) this.view.webContents.goForward();
  }

  reload() {
    this.view?.webContents.reload();
  }

  /** Runs Readability + Turndown inside the live page itself (a real DOM — no jsdom needed) and returns the cleaned result. */
  async extractPage(): Promise<ExtractedPage | null> {
    if (!this.view) return null;
    try {
      const result = await this.view.webContents.executeJavaScript(buildExtractionScript());
      if (!result || typeof result !== 'object') return null;
      return { title: result.title, markdown: result.markdown, excerpt: result.excerpt ?? null };
    } catch {
      return null;
    }
  }

  getCurrentUrl(): string {
    return this.view?.webContents.getURL() ?? '';
  }

  getState(workspaceId: string): BrowserNavState | null {
    return this.lastState.get(workspaceId) ?? null;
  }

  /** A workspace is being deleted/closed — forget its remembered nav state. */
  forgetWorkspace(workspaceId: string) {
    this.lastState.delete(workspaceId);
    if (this.currentWorkspaceId === workspaceId) this.detach();
  }
}
