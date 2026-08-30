import { useEffect, useState } from 'react';
import { useForge, useActiveWorkspace } from '../state/store';
import type { ScheduledTask, ScheduleSpec, FocusAgentSummary } from '../../electron/ipc-channels';
import {
  IconCheck,
  IconX,
  IconPlus,
  IconDot,
  IconClock,
  IconMessages,
  IconStop,
  IconRefresh,
} from './icons';

function describeSchedule(schedule: ScheduleSpec): string {
  if (schedule.kind === 'cron') return `cron: ${schedule.expr}`;
  if (schedule.kind === 'interval') return `every ${schedule.minutes}m`;
  return `once at ${new Date(schedule.at).toLocaleString()}`;
}

function fmtWhen(ts: number | null): string {
  if (!ts) return 'never';
  return new Date(ts).toLocaleString();
}

function emptyDraft(): { label: string; prompt: string; kind: 'cron' | 'interval'; expr: string; minutes: string } {
  return { label: '', prompt: '', kind: 'interval', expr: '0 9 * * *', minutes: '60' };
}

export function SchedulerPanel() {
  const view = useActiveWorkspace();
  const createSchedule = useForge((s) => s.createSchedule);
  const updateSchedule = useForge((s) => s.updateSchedule);
  const deleteSchedule = useForge((s) => s.deleteSchedule);
  const runScheduleNow = useForge((s) => s.runScheduleNow);
  const startFocusAgent = useForge((s) => s.startFocusAgent);
  const stopFocusAgent = useForge((s) => s.stopFocusAgent);
  const answerFocusQuestion = useForge((s) => s.answerFocusQuestion);

  const schedules: ScheduledTask[] = view?.schedules ?? [];
  const focusAgents: FocusAgentSummary[] = view?.focusAgents ?? [];
  const board = view?.board ?? [];
  const pendingQuestions = view ? Object.values(view.pendingFocusQuestions) : [];

  const [tab, setTab] = useState<'tasks' | 'focus' | 'board'>('tasks');
  const [selId, setSelId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(emptyDraft());
  const [focusDraft, setFocusDraft] = useState({ label: '', task: '', budget: '30' });
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({});

  const selected = schedules.find((t) => t.id === selId) ?? null;

  useEffect(() => {
    if (!selected && !creating && schedules.length) setSelId(schedules[0].id);
  }, [schedules, selected, creating]);

  function startCreate() {
    setDraft(emptyDraft());
    setCreating(true);
    setSelId(null);
  }

  async function submitCreate() {
    if (!draft.label.trim() || !draft.prompt.trim()) return;
    const schedule: ScheduleSpec =
      draft.kind === 'cron' ? { kind: 'cron', expr: draft.expr.trim() } : { kind: 'interval', minutes: Math.max(1, Number(draft.minutes) || 60) };
    await createSchedule(draft.label.trim(), draft.prompt.trim(), schedule);
    setCreating(false);
  }

  return (
    <div className="rm-wrap sch-wrap">
      <div className="sch-tabs">
        <button className={`seg${tab === 'tasks' ? ' on' : ''}`} onClick={() => setTab('tasks')}>
          <IconClock className="icon-xs" /> Scheduled Tasks
        </button>
        <button className={`seg${tab === 'focus' ? ' on' : ''}`} onClick={() => setTab('focus')}>
          <IconDot className="icon-xs" /> Focus Agents{focusAgents.length ? ` (${focusAgents.length})` : ''}
        </button>
        <button className={`seg${tab === 'board' ? ' on' : ''}`} onClick={() => setTab('board')}>
          <IconMessages className="icon-xs" /> Message Board
        </button>
      </div>

      {pendingQuestions.length > 0 && (
        <div className="sch-questions">
          {pendingQuestions.map((q) => (
            <div className="card approval" key={q.requestId}>
              <div className="card-top">
                <IconMessages className="icon-sm" style={{ color: 'var(--amber)' }} />
                <span className="card-title">{q.from} is waiting for an answer</span>
              </div>
              <div className="rm-summary">{q.question}</div>
              <div className="approval-actions">
                <input
                  className="sch-answer-input"
                  placeholder="Type your answer…"
                  value={answerDrafts[q.requestId] ?? ''}
                  onChange={(e) => setAnswerDrafts((d) => ({ ...d, [q.requestId]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && answerDrafts[q.requestId]?.trim()) {
                      void answerFocusQuestion(q.requestId, answerDrafts[q.requestId].trim());
                    }
                  }}
                />
                <button
                  className="mini accept"
                  disabled={!answerDrafts[q.requestId]?.trim()}
                  onClick={() => void answerFocusQuestion(q.requestId, (answerDrafts[q.requestId] ?? '').trim())}
                >
                  <IconCheck className="icon-xs" />
                  Answer
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'tasks' && (
        <div className="sch-body">
          <div className="rm-list">
            <button className="mini flat sch-new-btn" onClick={startCreate}>
              <IconPlus className="icon-xs" /> New scheduled task
            </button>
            {schedules.map((t) => (
              <div
                key={t.id}
                className={`rm-item${t.id === selected?.id ? ' sel' : ''}`}
                onClick={() => {
                  setCreating(false);
                  setSelId(t.id);
                }}
              >
                <IconDot className="icon-sm" style={{ color: t.enabled ? 'var(--green)' : 'var(--fg-3)' }} />
                <div className="col" style={{ minWidth: 0, flex: 1 }}>
                  <div className="rm-title">{t.label}</div>
                  <div className="rm-summary">{describeSchedule(t.schedule)} — next: {fmtWhen(t.nextRunAt)}</div>
                </div>
              </div>
            ))}
            {!schedules.length && !creating && (
              <div className="empty-pane" style={{ padding: 'var(--s4)' }}>
                No scheduled tasks yet.
              </div>
            )}
          </div>

          <div className="rm-detail">
            {creating && (
              <div className="rm-body">
                <div className="sch-field">
                  <label>Label</label>
                  <input value={draft.label} onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))} />
                </div>
                <div className="sch-field">
                  <label>Prompt to send</label>
                  <textarea
                    rows={5}
                    value={draft.prompt}
                    onChange={(e) => setDraft((d) => ({ ...d, prompt: e.target.value }))}
                  />
                </div>
                <div className="sch-field">
                  <label>Schedule</label>
                  <div className="sch-kind-row">
                    <button
                      className={`mini flat${draft.kind === 'interval' ? ' on' : ''}`}
                      onClick={() => setDraft((d) => ({ ...d, kind: 'interval' }))}
                    >
                      Interval
                    </button>
                    <button
                      className={`mini flat${draft.kind === 'cron' ? ' on' : ''}`}
                      onClick={() => setDraft((d) => ({ ...d, kind: 'cron' }))}
                    >
                      Cron
                    </button>
                  </div>
                  {draft.kind === 'interval' ? (
                    <div className="sch-kind-row">
                      <span>Every</span>
                      <input
                        style={{ width: 70 }}
                        type="number"
                        min={1}
                        value={draft.minutes}
                        onChange={(e) => setDraft((d) => ({ ...d, minutes: e.target.value }))}
                      />
                      <span>minute(s)</span>
                    </div>
                  ) : (
                    <input
                      placeholder="min hour day month weekday, e.g. 0 9 * * *"
                      value={draft.expr}
                      onChange={(e) => setDraft((d) => ({ ...d, expr: e.target.value }))}
                    />
                  )}
                </div>
                <div className="approval-actions">
                  <button className="mini flat" onClick={() => setCreating(false)}>
                    Cancel
                  </button>
                  <button className="mini accept" onClick={submitCreate} disabled={!draft.label.trim() || !draft.prompt.trim()}>
                    <IconCheck className="icon-xs" />
                    Create
                  </button>
                </div>
              </div>
            )}

            {!creating && selected && (
              <>
                <div className="rm-dhead">
                  <IconClock className="icon-sm" style={{ color: 'var(--fg-3)' }} />
                  <div className="col" style={{ minWidth: 0 }}>
                    <div className="rm-dtitle">{selected.label}</div>
                    <div className="rm-dstatus">{describeSchedule(selected.schedule)}</div>
                  </div>
                  <div className="spacer" />
                  <button
                    className="mini flat"
                    onClick={() => updateSchedule(selected.id, { enabled: !selected.enabled })}
                  >
                    {selected.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button className="mini flat" onClick={() => runScheduleNow(selected.id)}>
                    <IconRefresh className="icon-xs" />
                    Run now
                  </button>
                  <button className="mini reject" onClick={() => deleteSchedule(selected.id)}>
                    <IconX className="icon-xs" />
                    Delete
                  </button>
                </div>
                <div className="rm-body">
                  <div className="sch-field">
                    <label>Prompt</label>
                    <div className="rm-notes">{selected.prompt}</div>
                  </div>
                  <div className="sch-meta">
                    <div>Last run: {fmtWhen(selected.lastRunAt)}</div>
                    <div>Last result: {selected.lastResult ?? '—'}</div>
                    <div>Next run: {fmtWhen(selected.nextRunAt)}</div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {tab === 'focus' && (
        <div className="sch-body sch-full">
          <div className="sch-field sch-focus-form">
            <input
              placeholder="Label"
              style={{ width: 160 }}
              value={focusDraft.label}
              onChange={(e) => setFocusDraft((d) => ({ ...d, label: e.target.value }))}
            />
            <input
              placeholder="Task for the Focus agent to work on…"
              style={{ flex: 1 }}
              value={focusDraft.task}
              onChange={(e) => setFocusDraft((d) => ({ ...d, task: e.target.value }))}
            />
            <input
              type="number"
              min={1}
              max={240}
              style={{ width: 70 }}
              value={focusDraft.budget}
              onChange={(e) => setFocusDraft((d) => ({ ...d, budget: e.target.value }))}
            />
            <span className="rm-summary">min</span>
            <button
              className="mini accept"
              disabled={!focusDraft.label.trim() || !focusDraft.task.trim()}
              onClick={() => {
                void startFocusAgent(focusDraft.task.trim(), focusDraft.label.trim(), Math.max(1, Number(focusDraft.budget) || 30));
                setFocusDraft({ label: '', task: '', budget: '30' });
              }}
            >
              <IconPlus className="icon-xs" />
              Start
            </button>
          </div>

          {!focusAgents.length && <div className="empty-pane">No Focus agents running.</div>}
          {focusAgents.map((f) => (
            <div className="rm-item sch-focus-item" key={f.id}>
              <IconDot
                className="icon-sm"
                style={{
                  color:
                    f.status === 'running' ? 'var(--amber)' : f.status === 'done' ? 'var(--green)' : f.status === 'error' ? 'var(--red)' : 'var(--fg-3)',
                }}
              />
              <div className="col" style={{ minWidth: 0, flex: 1 }}>
                <div className="rm-title">{f.label}</div>
                <div className="rm-summary">
                  {f.status} — {Math.round(f.elapsedMs / 60000)}m / {Math.round(f.budgetMs / 60000)}m budget
                </div>
              </div>
              {f.status === 'running' && (
                <button className="mini reject" onClick={() => stopFocusAgent(f.id)}>
                  <IconStop className="icon-xs" />
                  Stop
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === 'board' && (
        <div className="sch-body sch-full">
          {!board.length && <div className="empty-pane">No messages on the board yet.</div>}
          {board.map((m) => (
            <div className="sch-msg" key={m.id}>
              <div className="sch-msg-head">
                <span className="sch-msg-from">{m.from}</span>
                <span className="sch-msg-time">{new Date(m.createdAt).toLocaleTimeString()}</span>
                {m.needsAnswer && <span className="sch-msg-badge">asking</span>}
              </div>
              <div className="sch-msg-text">{m.text}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
