/**
 * Small, stateless helpers injected into the agent loop (agent-service.ts)
 * each turn. Deliberately not a class or a service with its own state — the
 * only state that matters (the failure streak) already belongs to
 * AgentSession, right next to the trackActivity call that feeds it.
 */

/**
 * True if `text` contains CJK, Japanese kana, Korean hangul, Cyrillic,
 * Arabic, Devanagari, Thai, or Hebrew script. Used to catch a model drifting
 * into another language after a tool result (a fetched page, a search hit)
 * happened to contain one — the reminder this feeds only fires on the NEXT
 * turn, so it never touches or censors the tool result itself.
 */
export function containsForeignScript(text: string): boolean {
  return /[一-鿿぀-ヿ가-힯Ѐ-ӿ؀-ۿऀ-ॿ฀-๿֐-׿]/.test(
    text
  );
}

const STREAK_NOTE =
  'Your last 3 tool calls in a row returned an error. Stop and reconsider your approach rather than ' +
  'repeating the same call again — try something different, or explain the dead end in your reply instead.';

const FOREIGN_SCRIPT_NOTE =
  "A tool result you just received contains non-English text. Keep responding in this conversation's own " +
  'language regardless of what a fetched result contains.';

const EMPTY_REPLY_NOTE =
  'Your last response had no text and no tool call — completely empty. If you meant to finish, say so to ' +
  'the user. If you meant to call a tool, call it now.';

/**
 * Builds one ephemeral system message for the NEXT request only — never
 * added to the persisted conversation (see agent-service.ts's send(), which
 * appends this to the wire payload and immediately discards it). Returns
 * null when none of the conditions apply, so a normal turn adds nothing.
 */
export function buildGuardrailNote(
  streakJustHitThree: boolean,
  sawForeignScript: boolean,
  emptyReply = false
): string | null {
  const parts: string[] = [];
  if (streakJustHitThree) parts.push(STREAK_NOTE);
  if (sawForeignScript) parts.push(FOREIGN_SCRIPT_NOTE);
  if (emptyReply) parts.push(EMPTY_REPLY_NOTE);
  return parts.length ? parts.join(' ') : null;
}

/**
 * True if `text` looks like a model output that has degenerated into
 * repetition rather than a genuinely short/repetitive-but-valid reply —
 * checked only against the tail of longer replies so a normal short answer
 * ("Done.", "Yes, that's right.") can never trip it. Two independent signals:
 * an unusually low unique-word ratio over the last stretch of text, or the
 * same short phrase repeated back to back several times.
 */
export function looksCollapsed(text: string): boolean {
  const words = text.trim().split(/\s+/);
  if (words.length < 40) return false;

  const tail = words.slice(-60);
  const uniqueRatio = new Set(tail.map((w) => w.toLowerCase())).size / tail.length;
  if (uniqueRatio < 0.25) return true;

  for (let phraseLen = 2; phraseLen <= 6; phraseLen++) {
    for (let i = 0; i + phraseLen * 4 <= tail.length; i++) {
      const phrase = tail.slice(i, i + phraseLen).join(' ').toLowerCase();
      let repeats = 1;
      let j = i + phraseLen;
      while (j + phraseLen <= tail.length && tail.slice(j, j + phraseLen).join(' ').toLowerCase() === phrase) {
        repeats++;
        j += phraseLen;
      }
      if (repeats >= 4) return true;
    }
  }
  return false;
}

/**
 * Strips any internal harness fence the model echoes back verbatim in its
 * visible reply — [UNTRUSTED]/[/UNTRUSTED] wrap every tool result, and the
 * Operator's rules doc is fenced as [TRUSTED: ...] (see rules-store.ts) — so
 * a model that quotes a tool result back at length doesn't leak the fence
 * markers themselves into what the Operator sees. Only removes the tags,
 * never the surrounding prose.
 */
export function stripLeakedTags(text: string): string {
  return text.replace(/\[TRUSTED:[^\]]*\]/g, '').replace(/\[\/?UNTRUSTED\]/g, '');
}
