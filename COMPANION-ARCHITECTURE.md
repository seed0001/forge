# Companion + background builder — target architecture

Reference implementation: `codex-companion` ("Joe") on the Operator's desktop.

## Principle

Forge is a **companion-first** app. There is always one thing the Operator
talks to — the **companion** — and it carries the Operator's persona. Real
building is delegated to **Codex as a background sub-agent** so the
conversation never blocks on a build.

Everything runs through the Operator's **Codex/ChatGPT subscription**
(`codex login`). No OpenAI API key, no OpenRouter for the chat path. Chat comes
through the subscription as a read-only Codex pass; building comes through the
same subscription as a workspace-write Codex pass.

## Roles (all `codex exec`, differentiated by sandbox + prompt + thread)

| Role | Sandbox | Thread | Prompt | Purpose |
|---|---|---|---|---|
| **Companion** | `read-only` | `companionThreadId` | Forge identity preamble (persona, ABOUT FORGE, grounding, rules, KB) + message | The voice. Chat, planning, Q&A, "how does Forge work". Can read the project to answer. |
| **Builder** | `workspace-write` (or `danger-full-access` on opt-in) | `builderThreadId` | Execution brief (the approved plan/roadmap item + relevant context) | Background. Edits / builds / tests on disk. |
| **Triage** | `read-only` | ephemeral, schema-forced | Router prompt + message + transcript | In Build mode only: decides each message is *chat* vs *delegate to builder*. |

The companion and builder are **separate Codex threads** — separate identities,
separate context. They are bridged by a **cross-feed**: after a builder run,
a short "context only, no reply" note is fed into the companion thread so the
companion knows what was built.

## Modes

- **Chat (Plan) mode:** every message → companion. The companion never
  delegates. When it judges it has enough to start, it *offers* to switch:
  emits a `build-handoff` proposal the Operator approves with a button (same
  pattern as roadmap-item approval). Approving flips the project to Build mode
  and hands the accumulated plan to the builder.
- **Build mode:** every message → **triage**. Triage routes to companion
  (keep talking) or builder (do work now, in the background). The Operator can
  keep chatting with the companion while the builder runs.

## Current state (v0.2.48)

**Done — the companion carries Forge's identity.** `runCodexTurn` now prepends
`buildCodexPreamble()` (persona, `ABOUT_FORGE`, grounding, Operator rules,
project knowledge base + working-memory files) to the first message of a Codex
thread. `codex exec resume` carries it forward. This fixes "it thinks it's
Codex / ignores the persona / describes ChatGPT's features".

`ABOUT_FORGE` is now a shared const used by both `buildSystemPrompt` (HTTP
loop) and `buildCodexPreamble` (Codex companion).

## Remaining slices

1. **Split the thread id.** `codexThreadId` → `companionThreadId` +
   `builderThreadId`, persisted separately (session-store). Companion turns
   resume the companion thread; builder turns resume the builder thread.
2. **Background builder.** A `delegate_build` path that spawns `codex exec`
   workspace-write on `builderThreadId` **without blocking the turn** — reuse
   the Focus-agent machinery (own background session, non-blocking, posts to
   the board / folds a result note into the companion thread). The Operator
   keeps chatting meanwhile.
3. **Triage in Build mode.** Port Joe's `triage.ts` — a read-only,
   schema-forced Codex pass returning `{ route: chat|build, say, proceed,
   task }`. Only runs when the project is in Build mode.
4. **Build-handoff proposal + button.** In Chat mode the companion can emit a
   `build-handoff` (like `propose_roadmap`): a short "ready to build — here's
   the plan" card with Approve/Not yet. Approve → Build mode + first builder
   task.
5. **Cross-feed.** After every builder run, `codex exec resume
   <companionThreadId>` with a "context only" summary of what changed.

## Notes carried from Joe

- `codex exec resume <id>` cannot take `-s` / `-C`; sandbox goes via
  `-c sandbox_mode=...`, cwd stays the thread's original. (Forge already does
  this in `codex-runner.ts`.)
- `codex exec` is non-interactive — it can't pause for approval. A builder
  that needs to step outside its sandbox just fails and explains; hence the
  full-access opt-in + retry.
- Auth is `codex login` only; `CODEX_API_KEY` / `OPENAI_API_KEY` are stripped
  from the child env so billing can't silently fall through to the API.
