/**
 * Deciding whether a spoken utterance is actually addressed to the Orb —
 * ported in spirit from the discord-agent's voice engagement model:
 *
 *  - a wake word ("orb", "hey orb") brings it into the conversation;
 *  - for a follow-up window after it finishes speaking, anything you say
 *    reaches it with no wake word (each real reply re-arms the window);
 *  - "stop" / "never mind" cancels a pending reply, "stop talking" barges in,
 *    "that's all" / "stop listening" ends the conversation;
 *  - Whisper's classic noise hallucinations ("thank you", "you", "bye") and
 *    an immediately-repeated short phrase are dropped as non-speech.
 */

export const DEFAULT_WAKE_WORDS = ['orb', 'hey orb', 'okay orb', 'ok orb', 'yo orb'];

const STOP_SPEAKING = ['stop talking', 'stop speaking', 'be quiet', 'quiet', 'shut up', 'hush'];
const STOP_LISTENING = [
  'stop listening', 'go to sleep', 'never mind', 'nevermind', 'forget it',
  'that is all', "that's all", 'we are done', "we're done", 'thank you that is all',
];
const CANCEL = ['stop', 'wait', 'never mind', 'nevermind', 'cancel', 'hold on', 'scratch that'];

// Whisper base.en emits these on silence / room tone / breath.
const NOISE = new Set([
  '', '.', '..', '...', 'you', 'thank you', 'thanks', 'thank you.', 'thanks for watching',
  'thank you for watching', 'bye', 'bye bye', 'bye-bye', 'okay', 'ok', 'so', 'uh', 'um',
  'yeah', 'mm', 'hmm', 'mhm', 'the', 'oh', 'i', 'a',
]);

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function phoneticKey(word: string): string {
  return word
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .replace(/ph/g, 'f')
    .replace(/ck/g, 'k')
    .replace(/[cq]/g, 'k')
    .replace(/z/g, 's')
    .replace(/[aeiouy]/g, '')
    .replace(/(.)\1+/g, '$1');
}

function editDistance(a: string, b: string, max = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (row[j] < best) best = row[j];
    }
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[b.length];
}

function containsPhrase(norm: string, phrase: string): boolean {
  const p = normalize(phrase);
  return p.length > 0 && (norm === p || norm.includes(` ${p} `) || norm.startsWith(`${p} `) || norm.endsWith(` ${p}`) || norm === p);
}

function matchesAny(norm: string, phrases: string[]): boolean {
  return phrases.some((p) => containsPhrase(norm, p));
}

/** Wake word present anywhere? Fuzzy on the bare name to survive mishearing. */
export function findWake(text: string, wakeWords = DEFAULT_WAKE_WORDS): { woken: boolean; rest: string } {
  const norm = normalize(text);
  for (const w of wakeWords) {
    const nw = normalize(w);
    if (norm === nw) return { woken: true, rest: '' };
    if (norm.startsWith(`${nw} `)) return { woken: true, rest: norm.slice(nw.length + 1).trim() };
    if (norm.includes(` ${nw} `) || norm.endsWith(` ${nw}`)) return { woken: true, rest: norm.replace(nw, '').replace(/\s+/g, ' ').trim() };
  }
  // fuzzy: any single word that sounds like "orb"
  const key = phoneticKey('orb'); // "rb"
  for (const word of norm.split(' ')) {
    if (word.length >= 2 && word.length <= 5 && (phoneticKey(word) === key || editDistance(word, 'orb', 1) <= 1)) {
      return { woken: true, rest: norm.replace(word, '').replace(/\s+/g, ' ').trim() };
    }
  }
  return { woken: false, rest: text };
}

export interface Classified {
  kind: 'noise' | 'cancel' | 'stop-speaking' | 'stop-listening' | 'wake' | 'follow-up' | 'ignore';
  /** the payload to send to the agent (wake / follow-up only) */
  text: string;
}

export interface EngageState {
  followUpUntil: number;
  lastText: string;
  lastTextAt: number;
}

export function newEngageState(): EngageState {
  return { followUpUntil: 0, lastText: '', lastTextAt: 0 };
}

export function classify(
  raw: string,
  state: EngageState,
  opts: { wakeWords?: string[]; hasPendingReply?: boolean; now?: number } = {}
): Classified {
  const now = opts.now ?? Date.now();
  const norm = normalize(raw);
  const engaged = now < state.followUpUntil;

  // repeated short blip from the noise gate
  if (norm && norm === state.lastText && norm.length <= 24 && now - state.lastTextAt < 45000) {
    state.lastTextAt = now;
    return { kind: 'noise', text: '' };
  }
  state.lastText = norm;
  state.lastTextAt = now;

  if (!norm || NOISE.has(norm) || norm.split(' ').length < 1) return { kind: 'noise', text: '' };

  if (matchesAny(norm, STOP_SPEAKING)) return { kind: 'stop-speaking', text: '' };
  if (matchesAny(norm, STOP_LISTENING)) return { kind: 'stop-listening', text: '' };
  if (opts.hasPendingReply && matchesAny(norm, CANCEL)) return { kind: 'cancel', text: '' };

  const { woken, rest } = findWake(raw, opts.wakeWords);
  if (woken) return { kind: 'wake', text: rest.replace(/^(hey|hi|yo|okay|ok|so|um|uh)\s+/i, '').trim() };
  if (engaged) return { kind: 'follow-up', text: raw.trim() };

  return { kind: 'ignore', text: '' };
}

/** Call when the Orb has finished speaking a real reply. */
export function armFollowUp(state: EngageState, seconds = 24, now = Date.now()) {
  state.followUpUntil = now + seconds * 1000;
}

export function endConversation(state: EngageState) {
  state.followUpUntil = 0;
}
