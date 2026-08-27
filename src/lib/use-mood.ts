import { useEffect, useState } from 'react';
import { useActiveWorkspace } from '../state/store';
import { usePacedActivity } from './use-paced-activity';
import { deriveMood, type Mood } from './mood';
import type { ActivityEvent } from '../../electron/ipc-channels';

/**
 * The single derivation of "what is the agent doing right now" for the active
 * workspace — shared by the composer's Aurora field, its trail line, and the
 * Orb so they can never disagree. One paced-activity cursor feeds all of them.
 */
export function useMood(): { mood: Mood; current: ActivityEvent | null } {
  const view = useActiveWorkspace();
  const activityList = view?.activity ?? [];
  const current = usePacedActivity(activityList);

  const running =
    !!view &&
    view.summary.activeSessionId !== null &&
    view.summary.runningSessionIds.includes(view.summary.activeSessionId);

  const pendingDiffs = Object.values(view?.pendingDiffs ?? {});

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  const mood = deriveMood({
    running,
    activity: activityList,
    current,
    elapsedMs: view?.runStartedAt ? now - view.runStartedAt : 0,
    hasPendingDiffs: pendingDiffs.length > 0,
  });

  return { mood, current };
}
