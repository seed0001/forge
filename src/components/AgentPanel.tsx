import { useEffect, useRef, useState } from 'react';
import { useForge, useActiveWorkspace } from '../state/store';
import {
  IconAgent,
  IconCheckCircle,
  IconXCircle,
  IconDot,
  IconArrowUp,
  IconStop,
  IconDiff,
} from './icons';

export function AgentPanel() {
  const view = useActiveWorkspace();
  const sendChat = useForge((s) => s.sendChat);
  const stopAgent = useForge((s) => s.stopAgent);
  const openReview = useForge((s) => s.openReview);

  const [text, setText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const running = view?.summary.status === 'running';
  const diffs = Object.values(view?.pendingDiffs ?? {});
  const added = diffs.reduce((n, d) => n + d.added, 0);
  const removed = diffs.reduce((n, d) => n + d.removed, 0);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [view?.chat.length, view?.activity.length, diffs.length]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
  }, [text]);

  function submit() {
    const t = text.trim();
    if (!t) return;
    setText('');
    sendChat(t);
  }

  if (!view) return <div className="agent" />;

  return (
    <div className="agent">
      <div className="agent-head">
        <IconAgent className="icon-sm" />
        <div className="h">Agent</div>
        <div className="spacer" />
        {running && <span className="chip amber">Working</span>}
      </div>

      <div className="agent-scroll" ref={scrollRef}>
        {view.chat.length === 0 && (
          <div className="hint">
            Give this workspace a task. It reads files, runs commands, and proposes edits — nothing reaches
            disk until you accept it. You can switch tabs while it works.
          </div>
        )}

        {view.chat.map((m, i) =>
          m.role === 'user' ? (
            <div className="bubble" key={i}>{m.text}</div>
          ) : (
            <div className="reply" key={i}>{m.text}</div>
          )
        )}

        {view.activity.length > 0 && (
          <div className="trail">
            {view.activity.map((a) => (
              <div className={`trail-row ${a.status}`} key={a.id}>
                {a.status === 'active' ? (
                  <IconDot className="icon-sm" />
                ) : a.status === 'error' ? (
                  <IconXCircle className="icon-sm" />
                ) : (
                  <IconCheckCircle className="icon-sm" />
                )}
                <span className="trail-detail">{a.detail}</span>
                {a.added !== undefined && <span className="stat-add">+{a.added}</span>}
                {a.removed !== undefined && <span className="stat-del">−{a.removed}</span>}
              </div>
            ))}
          </div>
        )}

        {diffs.length > 0 && (
          <div className="card">
            <div className="card-top">
              <IconDiff className="icon-sm" />
              <span className="card-title">
                {diffs.length} file{diffs.length === 1 ? '' : 's'} waiting for review
              </span>
              <div className="spacer" />
              <span className="stat-add">+{added}</span>
              <span className="stat-del">−{removed}</span>
            </div>
            <button className="btn btn-primary" onClick={openReview} style={{ width: '100%', justifyContent: 'center' }}>
              Review changes
            </button>
          </div>
        )}
      </div>

      <div className="composer">
        <div className="composer-box">
          <textarea
            ref={taRef}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={running ? 'Agent is working — queue another message' : 'What should this workspace do?'}
          />
          <div className="chiprow">
            <span className="chip">read · edit · run · search</span>
            {running ? (
              <button className="send stop" onClick={stopAgent} title="Stop the agent">
                <IconStop className="icon-xs" />
              </button>
            ) : (
              <button className="send" onClick={submit} disabled={!text.trim()} title="Send">
                <IconArrowUp className="icon-sm" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
