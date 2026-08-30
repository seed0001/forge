# Companion + background builder — target architecture

Reference implementation: `codex-companion` ("Joe") on the Operator's desktop.

## Principle

Forge is a **companion-first** app. There is always one thing the Operator
talks to — the **companion** — and it carries the Operator's persona. Real
building can be delegated to a **background Codex builder** so the
conversation never blocks on a build.

Everything runs through the Operator's **Codex/ChatGPT subscription**
(`codex login`). No OpenAI API key, no OpenRouter for the chat path.

## Safety model: one harness, not a sandbox level

Earlier versions of this design tried to get safety from Codex's own
`sandbox_mode` flag (`read-only` for the companion, `workspace-write` for the
builder) via `codex exec`. That never actually worked as intended:
`codex exec` is non-interactive by design — it cannot pause mid-turn to ask
permission — so the only real lever was picking a fixed sandbox level up
front and living with whatever it silently allowed. The Operator had no way
to approve or deny an individual Codex edit or command, and confirmed
empirically (against Codex CLI 0.151.0) that even `on-request` approval
policy under `sandbox: workspace-write` never actually asks — a permissive
sandbox just lets everything through with zero prompts.

The fix is a different transport, not a different sandbox choice:

- Every Codex thread — companion and builder alike — now runs through
  `codex app-server` (`electron/codex-app-server.ts`), a persistent JSON-RPC
  daemon connection, instead of one-shot `codex exec` subprocesses.
  `app-server` genuinely pauses a turn and sends a request the caller must
  answer before Codex proceeds.
- Every thread's sandbox is fixed at **`read-only`**. Confirmed empirically
  that this is what actually makes Codex ask before a mutating action — a
  read-only sandbox blocks the action outright, and Codex offers to retry
  with escalated permissions, which surfaces to Forge as an approval request
  (`item/fileChange/requestApproval`, `item/commandExecution/
  requestApproval`, etc.). There is no more `workspace-write` "builder"
  sandbox; both threads are equally gated.
- Those approval requests are answered by the **same** machinery the native
  HTTP tool-calling agent already uses for its own `propose_edit`/
  `run_command` — `PendingDiff` / `ReviewOverlay` for file changes,
  `requestActionApproval` for commands — so a Codex edit or command shows the
  Operator the *identical* review/approval prompt regardless of which
  provider is driving. See `project.ts`'s `requestEditApproval` (blocks until
  a diff is fully decided, unlike the native loop's `propose_edit` which ends
  its own turn and relies on `resumeAfterReview` to continue a later one —
  Codex's turn is genuinely suspended on the RPC response, so blocking here
  is correct) and the existing `requestApproval`/`getPermission` pair for
  commands.
- Forge's own per-category permission level (`edit`/`bash`, each
  allow/ask/deny) is what decides whether that ask is auto-answered or
  actually shown to the Operator — exactly like the native loop. `allow`
  auto-accepts without a popup; `deny` auto-declines without one; `ask` shows
  the real prompt.

## Roles

| Role | Thread | Purpose |
|---|---|---|
| **Companion** | `companionThreadId` | The voice. Chat, planning, Q&A, "how does Forge work". Can read the project to answer, and can edit/run — subject to the same review/approval as everything else. |
| **Builder** | `builderThreadId` | Background. `delegate_build` hands it a task so it can work while the Operator keeps talking to the companion. Same safety as the companion — the split is for *concurrency* (so a build doesn't block the chat), not for differing trust. |

The companion and builder are **separate Codex threads** — separate
identities, separate context — bridged by a cross-feed: after a builder run,
its result is pushed into the companion's chat and the shared board so the
companion knows what was built.

## Modes

- **Chat (Plan) mode:** every message → companion. The companion never
  delegates. When it judges it has enough to start, it *offers* to switch:
  emits a `build-handoff` proposal the Operator approves with a button (same
  pattern as roadmap-item approval). Approving flips the project to Build mode
  and hands the accumulated plan to the builder.
- **Build mode:** every message → companion, which decides per message to
  reply or call `delegate_build`. The Operator can keep chatting with the
  companion while the builder runs.

## Current state (v0.2.50) — working end-to-end

- **One transport for both roles.** `electron/codex-app-server.ts` owns a
  single, lazily-started, shared `codex app-server` connection for the whole
  Forge process; `AgentSession.runCodexTurn` (companion) and
  `Workspace.startBuilder` (builder) both call its `runCodexTurn`, passing a
  `CodexApprovalBridge` (`getPermission` / `requestActionApproval` /
  `requestEditApproval`) instead of a sandbox choice.
- **Approval bridge.** `codex-app-server.ts` tracks Codex's `fileChange`
  items (path + diff, reconstructed via the `diff` package the same way
  `computeHunks` already works) and routes every approval-request type it can
  receive (`item/fileChange/requestApproval`, `applyPatchApproval`,
  `item/commandExecution/requestApproval`, `execCommandApproval`,
  `item/permissions/requestApproval`) through the bridge, then translates the
  Operator's decision back into whatever decision shape that request type
  expects.
- **Companion identity.** `runCodexTurn` prepends `buildCodexPreamble()`
  (persona, `ABOUT_FORGE`, grounding, Operator rules, KB + working-memory
  files) to the first message of the companion thread. `ABOUT_FORGE` is a
  shared const across `buildSystemPrompt` and `buildCodexPreamble`.
- **Separate threads, both persisted.** `codexThreadId` (companion) +
  `codexBuilderThreadId` (builder), exported/restored via
  `AgentSession.exportCodexThreads`/`restoreCodexThreads`.
- **Background builder.** `delegate_build(task)` — primary agent, Build mode
  only — calls `Workspace.startBuilder()`, which fires a detached
  `runCodexTurn` on the builder thread. Non-blocking: the companion turn ends
  at once and the composer stays live. `runningSessionIds` deliberately
  excludes a session that only has a builder attached; `buildingSessionIds`
  is the separate signal (composer pill). Builder activity is tagged
  `[builder]` in the trail; its final report is pushed to the chat as a
  **Builder:** message and posted to the board.
- **Routing is tool-based**, not a separate triage pass. Build mode: the
  companion decides per message to reply or `delegate_build`. Plan mode:
  `delegate_build` is hard-blocked; the companion asks the Operator to flip
  the existing composer Build toggle.

## Remaining polish

1. **Dedicated build-handoff card** — a `propose_build` tool + Approve/Not-yet
   card, instead of "please flip the toggle".
2. **Automatic cross-feed** — a "context only" summary fed into the companion
   thread after each build (today the companion sees the Builder: chat
   message + board post on its next turn).
3. **Builder stop control** in the UI (`BuilderRuntime.kill` exists; only
   teardown / session-delete call it).
4. **Builder status as its own Activity turn card** with a real close event.
5. **Builder cost** folded into the session budget meter.
6. **Reconnect UX** — if the shared `codex app-server` process dies mid-turn
   (confirmed it settles the in-flight turn with a clear error rather than
   hanging, and transparently respawns on the next call), the Operator only
   sees a failed turn today; a visible "Codex reconnected" note would be
   friendlier than silence.

## Notes

- `turn/interrupt` needs both `threadId` and `turnId` — `codex-app-server.ts`
  tracks the active turn id per thread so `AgentSession.stop()` (via
  `CodexHandle.kill()`) can address it correctly.
- Auth is `codex login` only; `CODEX_API_KEY` / `OPENAI_API_KEY` are stripped
  from the child env so billing can't silently fall through to the API.
- On Windows, spawning the daemon needs `shell: true` — `resolveCodexBin()`
  usually resolves to the bare `codex` npm shim (a `.cmd`), which fails to
  spawn directly. The spawned args are a fixed literal (`['app-server']`),
  never interpolated, so this carries none of the usual shell-injection risk.
