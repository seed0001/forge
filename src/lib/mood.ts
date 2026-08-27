import type { ActivityEvent } from '../../electron/ipc-channels';

/**
 * What the agent is doing right now, as far as the ambient field is concerned.
 * Derived from the activity trail rather than declared, so the glow can never
 * drift out of sync with the work.
 */
export type Phase = 'idle' | 'thinking' | 'deep' | 'reading' | 'running' | 'editing' | 'error' | 'review';

export interface Mood {
  phase: Phase;
  /** Four band colours, ordered back to front. */
  colors: [string, string, string, string];
  /** 0–1. Drives opacity, blur spread and band size. */
  intensity: number;
  /** Animation rate multiplier; higher is more agitated. */
  speed: number;
  label: string;
}

const PALETTES: Record<Exclude<Phase, 'idle'>, [string, string, string, string]> = {
  // Scanning the codebase — cool, wide, calm.
  reading: ['#22d3ee', '#3b82f6', '#0ea5e9', '#38bdf8'],
  // Executing a command — hot and immediate.
  running: ['#f59e0b', '#fb923c', '#fbbf24', '#f97316'],
  // Producing changes — generative green.
  editing: ['#10b981', '#34d399', '#2dd4bf', '#4ade80'],
  // Reasoning between tools.
  thinking: ['#8b5cf6', '#6366f1', '#a855f7', '#7c3aed'],
  // Long, sustained reasoning — pushes toward magenta.
  deep: ['#d946ef', '#a855f7', '#fb7185', '#c026d3'],
  // Something failed.
  error: ['#ef4444', '#f43f5e', '#dc2626', '#fb7185'],
  // Work is done and waiting on the human.
  review: ['#22c55e', '#4ade80', '#16a34a', '#86efac'],
};

const LABELS: Record<Exclude<Phase, 'idle'>, string> = {
  reading: 'Reading',
  running: 'Running',
  editing: 'Writing changes',
  thinking: 'Thinking',
  deep: 'Thinking deeply',
  error: 'Hit a problem',
  review: 'Waiting for review',
};

function phaseFromKind(kind: ActivityEvent['kind']): Phase {
  switch (kind) {
    case 'read':
    case 'list':
    case 'analyze':
      return 'reading';
    case 'run':
      return 'running';
    case 'propose':
    case 'generate':
      return 'editing';
    default:
      return 'thinking';
  }
}

/**
 * A Mood for a phase you already know (used by the desktop Orb, which is driven
 * by explicit voice/agent states rather than an activity trail).
 */
export function staticMood(phase: Phase, intensity = 0.55, speed = 1): Mood {
  if (phase === 'idle') {
    return { phase: 'idle', colors: PALETTES.thinking, intensity: 0, speed: 0.6, label: '' };
  }
  const p = phase as Exclude<Phase, 'idle'>;
  return { phase, colors: PALETTES[p], intensity, speed, label: LABELS[p] };
}

export function deriveMood(opts: {
  running: boolean;
  activity: ActivityEvent[];
  /** Whatever the trail is currently displaying (see usePacedActivity) — kept
   *  in lockstep with it so the ambient color/label never contradicts the
   *  one line the Operator is actually reading. */
  current: ActivityEvent | null;
  elapsedMs: number;
  hasPendingDiffs: boolean;
}): Mood {
  const { running, activity, current, elapsedMs, hasPendingDiffs } = opts;

  // Depth ramps over the first three minutes of a task, then holds.
  const depth = Math.min(elapsedMs / 180_000, 1);
  const steps = activity.length;
  // More tool calls also reads as deeper work, independent of wall clock.
  const effort = Math.min(depth * 0.7 + Math.min(steps / 14, 1) * 0.3, 1);

  if (!running) {
    // Work waiting on the user outranks a stumble along the way.
    if (hasPendingDiffs) {
      return { phase: 'review', colors: PALETTES.review, intensity: 0.42, speed: 0.6, label: LABELS.review };
    }
    // Only surface red when the run actually ENDED badly. An error earlier in a
    // run that then recovered is history, not the current state — and a missing
    // file ('skipped') is never an error at all.
    const last = current ?? activity[activity.length - 1];
    if (last?.status === 'error') {
      return { phase: 'error', colors: PALETTES.error, intensity: 0.5, speed: 1, label: LABELS.error };
    }
    return { phase: 'idle', colors: PALETTES.thinking, intensity: 0, speed: 0.6, label: '' };
  }

  // Not just "currently active" — a step that flashed into existence already
  // done (read_file, list_files) is still the thing being reported right now,
  // as long as it's what the paced trail is showing.
  let phase: Phase = current && current.kind !== 'thinking' ? phaseFromKind(current.kind) : 'thinking';

  // Sustained reasoning with no tool in flight shifts the palette deeper.
  if (phase === 'thinking' && effort > 0.45) phase = 'deep';

  return {
    phase,
    colors: PALETTES[phase as Exclude<Phase, 'idle'>],
    intensity: 0.45 + effort * 0.55,
    speed: 0.85 + effort * 0.9,
    label: LABELS[phase as Exclude<Phase, 'idle'>],
  };
}
