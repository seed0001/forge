import { useEffect, useRef, useState } from 'react';
import { useForge, useActiveWorkspace } from '../state/store';
import { deriveMood } from '../lib/mood';
import { useVoice } from '../lib/use-voice';
import { usePacedActivity } from '../lib/use-paced-activity';
import { Aurora } from './Aurora';
import { Markdown } from './Markdown';
import { ChatImageThumb } from './ChatImageThumb';
import {
  IconCheckCircle,
  IconXCircle,
  IconDot,
  IconArrowUp,
  IconStop,
  IconDiff,
  IconMic,
  IconMinusCircle,
  IconBolt,
  IconCheck,
  IconX,
  IconRoadmap,
} from './icons';

/** Pulls image Files out of a clipboard paste or a file drop — everything else passes through untouched. */
function imageFilesFrom(items: DataTransferItemList | null | undefined, files: FileList | null | undefined): File[] {
  const out: File[] = [];
  if (items) {
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) out.push(file);
      }
    }
  }
  if (out.length === 0 && files) {
    for (const file of files) if (file.type.startsWith('image/')) out.push(file);
  }
  return out;
}

export function ChatView() {
  const view = useActiveWorkspace();
  const sendChat = useForge((s) => s.sendChat);
  const stopAgent = useForge((s) => s.stopAgent);
  const openReview = useForge((s) => s.openReview);
  const setCenter = useForge((s) => s.setCenter);
  const decideApproval = useForge((s) => s.decideApproval);
  const decideSubagentApproval = useForge((s) => s.decideSubagentApproval);
  const addComposerImage = useForge((s) => s.addComposerImage);
  const removeComposerImage = useForge((s) => s.removeComposerImage);

  const [text, setText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  async function attachImages(files: File[]) {
    for (const file of files) {
      const buffer = await file.arrayBuffer();
      await addComposerImage(buffer, file.type, file.name);
    }
  }

  // Session-scoped, not workspace-wide: another session in this workspace
  // may be running in the background while this one sits idle, and the
  // composer/Stop button must reflect the session actually on screen.
  const running = !!view && view.summary.activeSessionId !== null && view.summary.runningSessionIds.includes(view.summary.activeSessionId);
  const diffs = Object.values(view?.pendingDiffs ?? {});
  const added = diffs.reduce((n, d) => n + d.added, 0);
  const removed = diffs.reduce((n, d) => n + d.removed, 0);
  const roadmapNeedsReview = (view?.roadmap ?? []).filter(
    (it) => it.status === 'pending' || it.status === 'needs_revision'
  ).length;
  // One line, not a stacking transcript: whatever the agent last reported —
  // an in-progress step, or (per ActivityEvent.summary) the run's single
  // consolidated closing line — replaces whatever was shown before it. Paced
  // so a step that arrives already-done (read_file, list_files) still gets
  // a beat on screen instead of being overwritten before it ever paints.
  const activityList = view?.activity ?? [];
  const currentActivity = usePacedActivity(activityList);

  // Re-tick while a task is live so the field deepens as the work goes on.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  const mood = deriveMood({
    running,
    activity: activityList,
    current: currentActivity,
    elapsedMs: view?.runStartedAt ? now - view.runStartedAt : 0,
    hasPendingDiffs: diffs.length > 0,
  });

  // Dictation appends into the composer rather than sending, so nothing is
  // acted on before you have seen what was heard.
  const voice = useVoice((transcript) => {
    setText((prev) => (prev ? `${prev.trimEnd()} ${transcript}` : transcript));
    taRef.current?.focus();
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [
    view?.chat.length,
    view?.activity.length,
    diffs.length,
    view?.pendingApproval,
    view && Object.keys(view.pendingSubagentApprovals).length,
  ]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }, [text]);

  function submit() {
    const t = text.trim();
    if (!t && !view?.composerImages.length) return;
    setText('');
    sendChat(t);
  }

  if (!view) return <div className="chat" />;

  return (
    <div className="chat">
      <div className="chat-scroll" ref={scrollRef}>
        <div className="thread">
          {view.chat.length === 0 && (
            <div className="thread-empty">
              <h1>What should this workspace do?</h1>
              <p>
                It reads files, runs commands and proposes edits. Nothing reaches disk until you accept it —
                and you can switch to another workspace while it works.
              </p>
            </div>
          )}

          {view.chat.map((m, i) =>
            m.role === 'user' ? (
              <div className="turn user" key={i}>
                {!!m.images?.length && (
                  <div className="chat-images">
                    {m.images.map((img) => (
                      <ChatImageThumb key={img.path} path={img.path} name={img.name} />
                    ))}
                  </div>
                )}
                {!!m.text && <div className="bubble">{m.text}</div>}
              </div>
            ) : (
              <div className={`turn agent${m.note ? ' note' : ''}`} key={i}>
                <Markdown>{m.text}</Markdown>
                {!!m.images?.length && (
                  <div className="chat-images">
                    {m.images.map((img) => (
                      <ChatImageThumb key={img.path} path={img.path} name={img.name} />
                    ))}
                  </div>
                )}
              </div>
            )
          )}

          {currentActivity && (
            <div className="turn agent">
              <div className="trail">
                <div className={`trail-row ${currentActivity.status}`} key={currentActivity.id}>
                  {currentActivity.status === 'active' ? (
                    <IconDot className="icon-xs" />
                  ) : currentActivity.status === 'error' ? (
                    <IconXCircle className="icon-xs" />
                  ) : currentActivity.status === 'skipped' ? (
                    <IconMinusCircle className="icon-xs" />
                  ) : (
                    <IconCheckCircle className="icon-xs" />
                  )}
                  <span className="trail-detail">{currentActivity.detail}</span>
                  {currentActivity.added !== undefined && <span className="stat-add">+{currentActivity.added}</span>}
                  {currentActivity.removed !== undefined && <span className="stat-del">−{currentActivity.removed}</span>}
                </div>
              </div>
            </div>
          )}

          {view.pendingApproval && (
            <div className="turn agent">
              <div className="card approval">
                <div className="card-top">
                  <IconBolt className="icon-sm" style={{ color: 'var(--fg-3)' }} />
                  <span className="card-title">
                    {view.pendingApproval.category === 'bash'
                      ? 'Waiting for your approval to run a command'
                      : 'Waiting for your approval for a network/media action'}
                  </span>
                </div>
                <code className="approval-cmd">{view.pendingApproval.command}</code>
                <div className="approval-actions">
                  <button className="mini reject" onClick={() => decideApproval('denied')}>
                    <IconX className="icon-xs" />
                    Deny
                  </button>
                  <button className="mini flat" onClick={() => decideApproval('always')} title="Allow this and skip prompting for the rest of this session">
                    Always allow
                  </button>
                  <button className="mini accept" onClick={() => decideApproval('approved')}>
                    <IconCheck className="icon-xs" />
                    Approve
                  </button>
                </div>
              </div>
            </div>
          )}

          {/*
            Workspace-scoped, not session-scoped: a subagent has no session tab
            of its own, so this must stay visible regardless of which session
            the Operator is viewing — visually and textually distinct from the
            primary agent's own approval card above, so the two are never
            confused. Fails closed (denied) if left unanswered — see
            electron/workspace.ts's requestSubagentApproval.
          */}
          {Object.values(view.pendingSubagentApprovals).map((req) => (
            <div className="turn agent" key={req.requestId}>
              <div className="card approval subagent-approval">
                <div className="card-top">
                  <IconBolt className="icon-sm" style={{ color: 'var(--blue)' }} />
                  <span className="card-title">A subagent wants to run a command</span>
                </div>
                <div className="approval-subagent-label">{req.label}</div>
                <code className="approval-cmd">{req.command}</code>
                <div className="approval-actions">
                  <button className="mini reject" onClick={() => decideSubagentApproval(req.requestId, false)}>
                    <IconX className="icon-xs" />
                    Deny
                  </button>
                  <button className="mini accept" onClick={() => decideSubagentApproval(req.requestId, true)}>
                    <IconCheck className="icon-xs" />
                    Approve
                  </button>
                </div>
              </div>
            </div>
          ))}

          {diffs.length > 0 && (
            <div className="turn agent">
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
                <button className="btn btn-primary" onClick={openReview}>
                  Review changes
                </button>
              </div>
            </div>
          )}

          {roadmapNeedsReview > 0 && (
            <div className="turn agent">
              <div className="card">
                <div className="card-top">
                  <IconRoadmap className="icon-sm" />
                  <span className="card-title">
                    {roadmapNeedsReview} roadmap item{roadmapNeedsReview === 1 ? '' : 's'} waiting for review
                  </span>
                </div>
                <button className="btn btn-primary" onClick={() => setCenter('roadmap')}>
                  Review roadmap
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div
        className="composer-dock"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const files = imageFilesFrom(e.dataTransfer.items, e.dataTransfer.files);
          if (files.length) void attachImages(files);
        }}
      >
        <Aurora mood={mood} voiceLevel={voice.state === 'listening' ? voice.level : 0} />
        <div className="composer-inner">
          {voice.error && (
            <div className="live-pill err" onClick={voice.clearError} title="Dismiss">
              {voice.error}
            </div>
          )}
          {!voice.error && voice.state === 'listening' && (
            <div className="live-pill" style={{ borderColor: '#f43f5e' }}>
              <span className="live-dot" style={{ background: '#f43f5e' }} />
              Listening — click the mic to stop
            </div>
          )}
          {!voice.error && voice.state === 'transcribing' && (
            <div className="live-pill">
              <span className="live-dot" style={{ background: '#8b5cf6' }} />
              Transcribing…
            </div>
          )}
          {!voice.error && voice.state === 'idle' && mood.label && (
            <div className="live-pill" style={{ borderColor: mood.colors[0] }}>
              <span className="live-dot" style={{ background: mood.colors[0] }} />
              {mood.label}
              {running && <span className="live-sub">· you can leave this tab</span>}
            </div>
          )}
          <div
            className="composer-box"
            onPaste={(e) => {
              const files = imageFilesFrom(e.clipboardData.items, null);
              if (files.length) {
                e.preventDefault();
                void attachImages(files);
              }
            }}
          >
            {!!view.composerImages.length && (
              <div className="composer-images">
                {view.composerImages.map((img) => (
                  <div className="composer-img" key={img.id}>
                    <img src={img.dataUrl} alt={img.name} />
                    <button
                      className="composer-img-remove"
                      onClick={() => removeComposerImage(img.id)}
                      title="Remove"
                    >
                      <IconX className="icon-xs" />
                    </button>
                  </div>
                ))}
              </div>
            )}
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
              placeholder={
                view.composerImages.length
                  ? 'Say what to do with the attached image(s)…'
                  : running
                    ? 'Add a follow-up — it will run next'
                    : 'Ask, or describe a task'
              }
            />
            <div className="chiprow">
              <span className="chip">read · edit · run</span>
              <span className="chip">{view.summary.name}</span>
              <div className="spacer" />
              <button
                className={`micbtn${voice.state === 'listening' ? ' live' : ''}`}
                onClick={voice.toggle}
                disabled={voice.state === 'transcribing'}
                title={voice.state === 'listening' ? 'Stop recording' : 'Speak'}
                style={
                  voice.state === 'listening'
                    ? { transform: `scale(${1 + voice.level * 0.22})` }
                    : undefined
                }
              >
                <IconMic className="icon-sm" />
              </button>
              {running ? (
                <button className="send stop" onClick={stopAgent} title="Stop">
                  <IconStop className="icon-xs" />
                </button>
              ) : (
                <button
                  className="send"
                  onClick={submit}
                  disabled={!text.trim() && !view.composerImages.length}
                  title="Send"
                >
                  <IconArrowUp className="icon-sm" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
