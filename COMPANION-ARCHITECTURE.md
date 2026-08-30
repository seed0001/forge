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

## Current state (v0.2.49) — working end-to-end

- **Companion identity.** `runCodexTurn` prepends `buildCodexPreamble()`
  (persona, `ABOUT_FORGE`, grounding, Operator rules, KB + working-memory
  files) to the first message of the companion thread. `ABOUT_FORGE` is a
  shared const across `buildSystemPrompt` and `buildCodexPreamble`.
- **The companion is always read-only.** `runCodexTurn`'s sandbox is fixed at
  `read-only`. The primary Codex agent plans and answers; it never edits.
- **Separate threads.** `codexThreadId` (companion) + `codexBuilderThreadId`
  (builder), both persisted and resumed (`exportCodexThreads` /
  `restoreCodexThreads`).
- **Background builder.** `delegate_build(task)` — primary agent, Build mode
  only — calls `Workspace.startBuilder()`, which fires a detached
  `runCodexTurn` at `workspace-write` on the builder thread. Non-blocking: the
  companion turn ends at once and the composer stays live. `runningSessionIds`
  deliberately excludes a session that only has a builder attached;
  `buildingSessionIds` is the separate signal (composer pill). Builder activity
  is tagged `[builder]` in the trail; its final report is pushed to the chat as
  a **Builder:** message and posted to the board.
- **Routing is tool-based**, not a separate triage pass. Build mode: the
  companion decides per message to reply or `delegate_build`. Plan mode:
  `delegate_build` is hard-blocked; the companion asks the Operator to flip the
  existing composer Build toggle.

## Remaining polish

1. **Dedicated build-handoff card** — a `propose_build` tool + Approve/Not-yet
   card, instead of "please flip the toggle".
2. **Automatic cross-feed** — `codex exec resume <companionThreadId>` with a
   "context only" summary after each build (today the companion sees the
   Builder: chat message + board post on its next turn).
3. **Builder stop control** in the UI (`BuilderRuntime.kill` exists; only
   teardown / session-delete call it).
4. **Builder status as its own Activity turn card** with a real close event.
5. **Builder cost** folded into the session budget meter.

## Notes carried from Joe

- `codex exec resume <id>` cannot take `-s` / `-C`; sandbox goes via
  `-c sandbox_mode=...`, cwd stays the thread's original. (Forge already does
  this in `codex-runner.ts`.)
- `codex exec` is non-interactive — it can't pause for approval. A builder
  that needs to step outside its sandbox just fails and explains; hence the
  full-access opt-in + retry.
- Auth is `codex login` only; `CODEX_API_KEY` / `OPENAI_API_KEY` are stripped
  from the child env so billing can't silently fall through to the API.
