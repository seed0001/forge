import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { FileNode } from '../../electron/ipc-channels';
import { forge } from '../lib/forge-api';
import { useForge, useActiveWorkspace } from '../state/store';
import {
  IconFile,
  IconFolder,
  IconChevronRight,
  IconChevronDown,
  IconFolderOpen,
  IconGlobe,
} from './icons';
import { SessionList } from './SessionList';
import { UpdateControl } from './UpdateControl';

const HTML_RE = /\.html?$/i;

/** Lets any Node, at any depth, open the tree's one context menu without prop-drilling through every level. */
const ContextMenuCtx = createContext<(e: React.MouseEvent, node: FileNode) => void>(() => {});

function Node({ node, depth }: { node: FileNode; depth: number }) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<FileNode[] | null>(null);
  const [loading, setLoading] = useState(false);
  const view = useActiveWorkspace();
  const openFile = useForge((s) => s.openFile);
  const openContextMenu = useContext(ContextMenuCtx);
  const treeVersion = view?.treeVersion ?? 0;
  // Which treeVersion `children` reflects — not just whether it's been fetched
  // at all, so a folder that changed while collapsed reloads next time it opens.
  const fetchedVersion = useRef<number | null>(null);

  async function load() {
    if (!view?.summary.id) return;
    setLoading(true);
    setChildren(await forge.fs.listDir(view.summary.id, node.path));
    fetchedVersion.current = treeVersion;
    setLoading(false);
  }

  async function toggle() {
    const next = !open;
    setOpen(next);
    // Children are fetched the first time a directory is expanded, so opening a
    // large project costs one shallow read instead of walking everything.
    if (next && fetchedVersion.current !== treeVersion) await load();
  }

  // A diff decided elsewhere in the tree still needs to reach an already-open
  // folder — this Node has no other way to hear about it.
  useEffect(() => {
    if (open && fetchedVersion.current !== treeVersion) void load();
  }, [treeVersion]);

  if (node.type === 'dir') {
    return (
      <>
        <div className="tree-row" style={{ paddingLeft: 8 + depth * 12 }} onClick={toggle}>
          {open ? <IconChevronDown className="icon-xs" /> : <IconChevronRight className="icon-xs" />}
          <IconFolder className="icon-sm" />
          <span className="tree-name">{node.name}</span>
        </div>
        {open && loading && (
          <div className="tree-note" style={{ paddingLeft: 32 + depth * 12 }}>loading…</div>
        )}
        {open && children?.length === 0 && !loading && (
          <div className="tree-note" style={{ paddingLeft: 32 + depth * 12 }}>empty</div>
        )}
        {open && children?.map((c) => <Node key={c.path} node={c} depth={depth + 1} />)}
      </>
    );
  }

  const isActive = view?.activeFilePath === node.path;
  const isDirty = view?.openFiles.find((f) => f.path === node.path)?.isDirty;

  return (
    <div
      className={`tree-row${isActive ? ' active' : ''}`}
      style={{ paddingLeft: 20 + depth * 12 }}
      onClick={() => openFile(node.path, node.name)}
      onContextMenu={(e) => {
        // Only HTML files have anything to offer right now — leave every other
        // file type showing the normal browser context menu, not an empty one.
        if (!HTML_RE.test(node.name)) return;
        e.preventDefault();
        openContextMenu(e, node);
      }}
    >
      <IconFile className="icon-sm" />
      <span className="tree-name">{node.name}</span>
      {isDirty && <div className="tree-dot" />}
    </div>
  );
}

export function Sidebar() {
  const view = useActiveWorkspace();
  const activeId = useForge((s) => s.activeId);
  const pickFolder = useForge((s) => s.pickFolder);
  const setSidebar = useForge((s) => s.setSidebar);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; node: FileNode } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  function openContextMenu(e: React.MouseEvent, node: FileNode) {
    setCtxMenu({ x: e.clientX, y: e.clientY, node });
  }

  useEffect(() => {
    if (!ctxMenu) return;
    function onDown(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setCtxMenu(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setCtxMenu(null);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    // A second right-click elsewhere should move the menu, not fight one already open.
    document.addEventListener('contextmenu', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('contextmenu', onDown);
    };
  }, [ctxMenu]);

  if (!view) return <div className="sidebar" />;

  const tab = view.sidebar;

  return (
    <div className="sidebar">
      <div className="side-head">
        <div className="side-title" title={view.summary.rootPath ?? ''}>{view.summary.name}</div>
        <div className="spacer" />
        <button className="side-btn" onClick={() => activeId && pickFolder(activeId)} title="Open a folder">
          <IconFolderOpen className="icon-xs" />
          Open
        </button>
      </div>

      <div className="side-tabs">
        <button className={`side-tab${tab === 'sessions' ? ' on' : ''}`} onClick={() => setSidebar('sessions')}>
          Sessions
        </button>
        <button className={`side-tab${tab === 'files' ? ' on' : ''}`} onClick={() => setSidebar('files')}>
          Files
        </button>
      </div>

      {tab === 'sessions' ? (
        <SessionList />
      ) : view.summary.rootPath ? (
        <div className="tree">
          {view.tree.length === 0 ? (
            <div className="tree-note" style={{ paddingLeft: 12 }}>This folder is empty.</div>
          ) : (
            <ContextMenuCtx.Provider value={openContextMenu}>
              {view.tree.map((n) => (
                <Node key={n.path} node={n} depth={0} />
              ))}
            </ContextMenuCtx.Provider>
          )}
        </div>
      ) : (
        <div className="empty-pane">
          <div>No folder open in this workspace.</div>
          <button className="btn btn-outline" onClick={() => activeId && pickFolder(activeId)}>
            <IconFolderOpen className="icon-sm" />
            Open folder
          </button>
        </div>
      )}

      <div className="side-foot">
        <span className="side-version" title="Installed version">Forge v{__APP_VERSION__}</span>
        <UpdateControl />
      </div>

      {ctxMenu && (
        <div className="ctxmenu" ref={menuRef} style={{ left: ctxMenu.x, top: ctxMenu.y }}>
          <button
            className="ctxmenu-item"
            onClick={() => {
              forge.fs.openInBrowser(ctxMenu.node.path);
              setCtxMenu(null);
            }}
          >
            <IconGlobe className="icon-sm" />
            Open in browser
          </button>
        </div>
      )}
    </div>
  );
}
