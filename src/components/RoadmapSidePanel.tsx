import { useEffect, useState } from 'react';
import { useForge, useActiveWorkspace } from '../state/store';
import type { RoadmapItem, RoadmapItemStatus } from '../../electron/ipc-channels';
import { Markdown } from './Markdown';
import {
  IconRoadmap,
  IconChevronRight,
  IconChevronDown,
  IconMessages,
  IconCheck,
  IconX,
  IconCheckCircle,
  IconXCircle,
  IconDot,
} from './icons';

const STATUS_LABEL: Record<RoadmapItemStatus, string> = {
  pending: 'Waiting for review',
  approved: 'Queued',
  in_progress: 'Working…',
  done: 'Done',
  needs_revision: 'Needs revision',
  rejected: 'Rejected',
};

function StatusIcon({ status }: { status: RoadmapItemStatus }) {
  if (status === 'done') return <IconCheckCircle className="icon-xs" style={{ color: 'var(--green)' }} />;
  if (status === 'rejected') return <IconXCircle className="icon-xs" style={{ color: 'var(--red)' }} />;
  if (status === 'needs_revision') return <IconXCircle className="icon-xs" style={{ color: 'var(--amber)' }} />;
  if (status === 'in_progress') return <IconDot className="icon-xs" style={{ color: 'var(--amber)' }} />;
  if (status === 'approved') return <IconDot className="icon-xs" style={{ color: 'var(--fg-2)' }} />;
  return <IconDot className="icon-xs" style={{ color: 'var(--fg-3)' }} />;
}

const needsReview = (s: RoadmapItemStatus) => s === 'pending' || s === 'needs_revision';

/**
 * Right-edge panel that appears the moment the agent proposes a roadmap —
 * no tab to click away to. Each milestone expands/collapses; "Discuss & chat"
 * pulls that item's plan into the composer so it can be re-outlined or
 * expanded in conversation. Renders nothing when there's no roadmap.
 */
export function RoadmapSidePanel() {
  const view = useActiveWorkspace();
  const decide = useForge((s) => s.decideRoadmapItem);
  const setStatus = useForge((s) => s.setRoadmapItemStatus);
  const discuss = useForge((s) => s.discussRoadmapItem);

  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const roadmap = [...(view?.roadmap ?? [])].sort((a, b) => a.order - b.order);

  // Auto-open anything waiting on the Operator — never force-collapse what
  // they've opened themselves.
  useEffect(() => {
    const toOpen = roadmap.filter((i) => needsReview(i.status)).map((i) => i.id);
    if (toOpen.length === 0) return;
    setExpanded((prev) => {
      if (toOpen.every((id) => prev.has(id))) return prev;
      const next = new Set(prev);
      for (const id of toOpen) next.add(id);
      return next;
    });
  }, [roadmap.map((i) => `${i.id}:${i.status}`).join(',')]);

  if (!view || roadmap.length === 0) return null;

  const doneCount = roadmap.filter((i) => i.status === 'done').length;
  const reviewCount = roadmap.filter((i) => needsReview(i.status)).length;

  if (collapsed) {
    return (
      <button className="rmside-collapsed" onClick={() => setCollapsed(false)} title="Show roadmap">
        <IconRoadmap className="icon-sm" />
        <span className="rmside-badge">
          {doneCount}/{roadmap.length}
        </span>
        {reviewCount > 0 && <span className="rmside-livedot" />}
      </button>
    );
  }

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <div className="rmside">
      <div className="rmside-head">
        <IconRoadmap className="icon-sm" />
        <div className="rmside-title">Roadmap</div>
        <span className="rmside-progress">
          {doneCount}/{roadmap.length}
        </span>
        <div className="spacer" />
        <button className="focus-panel-toggle" onClick={() => setCollapsed(true)} title="Collapse">
          <IconChevronRight className="icon-xs" />
        </button>
      </div>

      <div className="rmside-body">
        {roadmap.map((item: RoadmapItem) => {
          const open = expanded.has(item.id);
          return (
            <div className={`rmside-item ${item.status}`} key={item.id}>
              <button className="rmside-item-head" onClick={() => toggle(item.id)}>
                <StatusIcon status={item.status} />
                <span className="rmside-item-title">{item.title}</span>
                {open ? (
                  <IconChevronDown className="icon-xs rmside-caret" />
                ) : (
                  <IconChevronRight className="icon-xs rmside-caret" />
                )}
              </button>

              {open && (
                <div className="rmside-item-body">
                  <div className="rmside-item-status">{STATUS_LABEL[item.status]}</div>
                  {item.summary && <div className="rmside-item-summary">{item.summary}</div>}
                  {item.detail.trim() && (
                    <div className="rmside-item-detail">
                      <Markdown>{item.detail}</Markdown>
                    </div>
                  )}
                  {item.notes && <div className="rmside-item-notes">{item.notes}</div>}

                  <div className="rmside-item-actions">
                    <button className="mini flat" onClick={() => discuss(item)} title="Bring this item into the chat">
                      <IconMessages className="icon-xs" />
                      Discuss &amp; chat
                    </button>
                    {needsReview(item.status) && (
                      <>
                        <button className="mini reject" onClick={() => decide(item.id, 'reject')}>
                          <IconX className="icon-xs" />
                          Reject
                        </button>
                        <button className="mini accept" onClick={() => decide(item.id, 'approve')}>
                          <IconCheck className="icon-xs" />
                          Approve
                        </button>
                      </>
                    )}
                    {item.status === 'approved' && (
                      <button className="mini reject" onClick={() => decide(item.id, 'reject')}>
                        <IconX className="icon-xs" />
                        Reject
                      </button>
                    )}
                    {(item.status === 'done' || item.status === 'rejected') && (
                      <button className="mini flat" onClick={() => setStatus(item.id, 'pending')}>
                        Reopen
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
