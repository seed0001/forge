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

/**
 * Builds one ephemeral system message for the NEXT request only — never
 * added to the persisted conversation (see agent-service.ts's send(), which
 * appends this to the wire payload and immediately discards it). Returns
 * null when neither condition applies, so a normal turn adds nothing.
 */
export function buildGuardrailNote(streakJustHitThree: boolean, sawForeignScript: boolean): string | null {
  const parts: string[] = [];
  if (streakJustHitThree) parts.push(STREAK_NOTE);
  if (sawForeignScript) parts.push(FOREIGN_SCRIPT_NOTE);
  return parts.length ? parts.join(' ') : null;
}

/**
 * Strips any internal harness fence the model echoes back verbatim in its
 * visible reply — [UNTRUSTED]/[/UNTRUSTED] wrap every tool result, and a
 * ruleset module can be fenced as [TRUSTED: ...] (see rules-service.ts) — so
 * a model that quotes a tool result back at length doesn't leak the fence
 * markers themselves into what the Operator sees. Only removes the tags,
 * never the surrounding prose.
 */
export function stripLeakedTags(text: string): string {
  return text.replace(/\[TRUSTED:[^\]]*\]/g, '').replace(/\[\/?UNTRUSTED\]/g, '');
}
