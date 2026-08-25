import { useEffect, useState } from 'react';
import Editor from '@monaco-editor/react';
import { useForge, useActiveWorkspace } from '../state/store';
import { registerForgeTheme } from '../lib/monaco-theme';
import { Markdown } from './Markdown';
import type { RoadmapItem, RoadmapItemStatus } from '../../electron/ipc-channels';
import {
  IconCheck,
  IconX,
  IconCheckCircle,
  IconXCircle,
  IconDot,
  IconEdit,
  IconRoadmap,
} from './icons';

registerForgeTheme();

function StatusIcon({ status }: { status: RoadmapItemStatus }) {
  if (status === 'done') return <IconCheckCircle className="icon-sm" style={{ color: 'var(--green)' }} />;
  if (status === 'rejected') return <IconXCircle className="icon-sm" style={{ color: 'var(--red)' }} />;
  if (status === 'needs_revision') return <IconXCircle className="icon-sm" style={{ color: 'var(--amber)' }} />;
  if (status === 'in_progress') return <IconDot className="icon-sm" style={{ color: 'var(--amber)' }} />;
  if (status === 'approved') return <IconDot className="icon-sm" style={{ color: 'var(--fg-2)' }} />;
  return <IconDot className="icon-sm" style={{ color: 'var(--fg-3)' }} />;
}

const STATUS_LABEL: Record<RoadmapItemStatus, string> = {
  pending: 'Waiting for review',
  approved: 'Queued',
  in_progress: 'Working…',
  done: 'Done',
  needs_revision: 'Needs revision',
  rejected: 'Rejected',
};

export function RoadmapPanel() {
  const view = useActiveWorkspace();
  const decideRoadmapItem = useForge((s) => s.decideRoadmapItem);
  const pushBackRoadmapItem = useForge((s) => s.pushBackRoadmapItem);
  const setRoadmapItemStatus = useForge((s) => s.setRoadmapItemStatus);

  const roadmap: RoadmapItem[] = view?.roadmap ?? [];
  const [selId, setSelId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const selected = roadmap.find((it) => it.id === selId) ?? roadmap[0];

  // Following a live update (e.g. the item you're looking at just started or
  // finished) should never clobber text you're mid-edit on.
  useEffect(() => {
    if (!editing) setDraft(selected?.detail ?? '');
  }, [selected?.id, selected?.detail, editing]);

  useEffect(() => {
    setEditing(false);
  }, [selected?.id]);

  if (roadmap.length === 0) {
    return (
      <div className="empty-pane">
        No roadmap for this session yet — ask the agent to plan a multi-step project and it will propose
        one here.
      </div>
    );
  }

  function startEdit() {
    setDraft(selected?.detail ?? '');
    setEditing(true);
  }

  function cancelEdit() {
    setDraft(selected?.detail ?? '');
    setEditing(false);
  }

  function saveEdit() {
    if (!selected) return;
    void pushBackRoadmapItem(selected.id, draft);
    setEditing(false);
  }

  const dirty = editing && draft !== (selected?.detail ?? '');
  const saveLabel = selected?.status === 'in_progress' ? 'Push Back' : 'Save';

  return (
    <div className="rm-wrap">
      <div className="rm-list">
        {roadmap.map((it) => (
          <div
            key={it.id}
            className={`rm-item${it.id === selected?.id ? ' sel' : ''}`}
            onClick={() => setSelId(it.id)}
          >
            <StatusIcon status={it.status} />
            <div className="col" style={{ minWidth: 0, flex: 1 }}>
              <div className="rm-title">{it.title}</div>
              <div className="rm-summary">{it.summary}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="rm-detail">
        {selected && (
          <>
            <div className="rm-dhead">
              <IconRoadmap className="icon-sm" style={{ color: 'var(--fg-3)' }} />
              <div className="col" style={{ minWidth: 0 }}>
                <div className="rm-dtitle">{selected.title}</div>
                <div className="rm-dstatus">{STATUS_LABEL[selected.status]}</div>
              </div>
              <div className="spacer" />

              {!editing && selected.status !== 'in_progress' && (
                <button className="mini flat" onClick={startEdit}>
                  <IconEdit className="icon-xs" />
                  Edit
                </button>
              )}
              {!editing && selected.status === 'in_progress' && (
                <button className="mini flat" onClick={startEdit}>
                  <IconEdit className="icon-xs" />
                  Edit plan
                </button>
              )}
              {editing && (
                <>
                  <button className="mini flat" onClick={cancelEdit}>
                    Cancel
                  </button>
                  <button className="mini accept" onClick={saveEdit} disabled={!dirty}>
                    <IconCheck className="icon-xs" />
                    {saveLabel}
                  </button>
                </>
              )}

              {!editing && (selected.status === 'pending' || selected.status === 'needs_revision') && (
                <>
                  <button className="mini reject" onClick={() => decideRoadmapItem(selected.id, 'reject')}>
                    <IconX className="icon-xs" />
                    Reject
                  </button>
                  <button className="mini accept" onClick={() => decideRoadmapItem(selected.id, 'approve')}>
                    <IconCheck className="icon-xs" />
                    Approve
                  </button>
                </>
              )}
              {!editing && selected.status === 'approved' && (
                <button className="mini reject" onClick={() => decideRoadmapItem(selected.id, 'reject')}>
                  <IconX className="icon-xs" />
                  Reject
                </button>
              )}
              {!editing && selected.status === 'done' && (
                <button className="mini flat" onClick={() => setRoadmapItemStatus(selected.id, 'pending')}>
                  Reopen
                </button>
              )}
              {!editing && selected.status === 'rejected' && (
                <button className="mini flat" onClick={() => setRoadmapItemStatus(selected.id, 'pending')}>
                  Restore to pending
                </button>
              )}
            </div>

            <div className="rm-body">
              {editing ? (
                <div className="rm-editor">
                  <Editor
                    language="markdown"
                    theme="forge"
                    value={draft}
                    onChange={(v) => setDraft(v ?? '')}
                    options={{
                      fontFamily: 'Cascadia Code, JetBrains Mono, ui-monospace, Consolas, monospace',
                      fontSize: 13,
                      lineHeight: 21,
                      minimap: { enabled: false },
                      automaticLayout: true,
                      scrollBeyondLastLine: false,
                      padding: { top: 12, bottom: 12 },
                      wordWrap: 'on',
                    }}
                  />
                </div>
              ) : (
                <Markdown>{selected.detail}</Markdown>
              )}

              {!editing && selected.notes && (
                <div className="rm-notes">{selected.notes}</div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
