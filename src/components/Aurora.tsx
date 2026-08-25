import type { CSSProperties } from 'react';
import type { Mood } from '../lib/mood';

/**
 * Ambient field behind the composer. Colour comes from what the agent is doing,
 * intensity and rate from how long and how hard it has been working, so the
 * light reads as a status surface rather than decoration.
 */
export function Aurora({ mood, voiceLevel = 0 }: { mood: Mood; voiceLevel?: number }) {
  // While dictating, the field answers your voice instead of the agent's work.
  const listening = voiceLevel > 0;
  const colors = listening ? (['#f43f5e', '#fb7185', '#e879f9', '#c026d3'] as const) : mood.colors;
  const intensity = listening ? 0.4 + voiceLevel * 0.6 : mood.intensity;

  const style = {
    '--a1': colors[0],
    '--a2': colors[1],
    '--a3': colors[2],
    '--a4': colors[3],
    '--aurora-intensity': intensity,
    '--aurora-speed': listening ? 1.8 : mood.speed,
  } as CSSProperties;

  return (
    <div className={`aurora${intensity > 0 ? ' on' : ''}`} style={style} aria-hidden="true">
      <span className="band b1" />
      <span className="band b2" />
      <span className="band b3" />
      <span className="band b4" />
    </div>
  );
}
