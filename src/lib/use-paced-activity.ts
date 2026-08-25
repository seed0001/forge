import { useEffect, useRef, useState } from 'react';
import type { ActivityEvent } from '../../electron/ipc-channels';

const MIN_DWELL_MS = 500;

/**
 * The activity trail collapses to a single line (see ChatView), but a step
 * that arrives fully done in one shot — read_file, list_files — can be
 * pushed and immediately superseded by the next turn's "Thinking…" within
 * the same tick, so it never gets a frame to actually render. This paces
 * display so every distinct step is shown for at least MIN_DWELL_MS before
 * the next one can replace it. A step still in flight (status 'active') —
 * a ticking "Thinking… Ns", a running command — always preempts the queue
 * immediately, since live progress must never wait behind a backlog.
 */
export function usePacedActivity(activity: ActivityEvent[]): ActivityEvent | null {
  const queueRef = useRef<ActivityEvent[]>([]);
  const shownIdRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const [shown, setShown] = useState<ActivityEvent | null>(null);

  useEffect(() => {
    const latest = activity.length ? activity[activity.length - 1] : null;
    if (!latest) {
      queueRef.current = [];
      shownIdRef.current = null;
      setShown(null);
      return;
    }
    if (latest.id === shownIdRef.current) {
      // Same row, refreshed in place (the "Thinking… Ns" tick, or it
      // flipping from active to done) — always update immediately.
      setShown(latest);
      return;
    }
    if (latest.status === 'active' || !shownIdRef.current) {
      queueRef.current = [];
      shownIdRef.current = latest.id;
      setShown(latest);
      return;
    }
    queueRef.current.push(latest);
    scheduleDrain();
  }, [activity]);

  function scheduleDrain() {
    if (timerRef.current !== null) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const next = queueRef.current.shift();
      if (next) {
        shownIdRef.current = next.id;
        setShown(next);
      }
      if (queueRef.current.length) scheduleDrain();
    }, MIN_DWELL_MS);
  }

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    []
  );

  return shown;
}
