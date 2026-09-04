# Harness edge-case test log

A running record of abnormal-path scenarios the Forge harness has been tested
against, the result, and any fix applied. Goal: the harness is *edge-case
tested*, not just happy-path tested.

**Method:** each case is traced through the real code paths (agent loop,
permission/mode gates, persistence, renderer). A case "passes" only when the
code demonstrably handles it; failures are fixed in the same pass and re-verified
(`npx tsc --noEmit` + `npm run build`).

Legend: ✅ pass · 🔧 failed, fixed · ⏳ not yet tested

---

## Batch 1 — core chat loop (25 cases)

### Concurrent / rapid input

| # | Case | Result | Notes |
|---|------|--------|-------|
| 1 | 2nd message while agent is thinking (pre-tool-call) | ✅ | `rt.running` gate → `pendingFollowups`, replayed as one combined follow-up on completion (`project.ts` `sendToAgent`) |
| 2 | Message while a tool call is mid-execution | ✅ | same queue path |
| 3 | Message while the reply is "streaming" | ✅ | completions are not streamed; queued like 1/2 |
| 4 | Double-submit (fast Enter twice) | ✅ (weak) | 2nd becomes a "do it again" follow-up — wasteful, not broken. Renderer also guards on `!text.trim()` |
| 5 | 3+ messages in quick succession | ✅ | all queued, joined with `\n\n`, one follow-up turn |
| 6 | Send, then Stop before the agent responds | ✅ | `aborted` checked at loop top after first await |
| 7 | Stop mid-command (shell running) | ✅ | `stop()` + `rt.terminal.kill()` + pending approvals resolved `false` |
| 8 | **Stop, then immediately send a new message** | 🔧 | **Finding A** — see below |

### Empty / degenerate content

| # | Case | Result | Notes |
|---|------|--------|-------|
| 9 | Empty / whitespace-only user message | ✅ | guarded at both entry points: renderer `submit()` (`!t && !images`), portal `data.text.trim()` |
| 10 | Turn ends with tool calls but no text | ✅ | no note flushed, tools run, loop continues |
| 11 | Empty-string reply | ✅ | `emptyReplyStreak` gives 2 ephemeral nudges, then `flushMessage(replyText || '(agent returned no text)')` |
| 12 | Image with no text | ✅ | `userText || 'Look at the attached image(s) and respond.'` |
| 13 | Very long single message (whole-file paste) | ✅ | not specifically capped, but `capWireRequestBytes` + `REQUEST_BYTE_BUDGET` + token compaction keep the wire request valid |
| 14 | Reply with broken markdown (unclosed fence, giant table) | 🔧 | **Finding C** — no error boundary anywhere in the renderer |

### Turn lifecycle

| # | Case | Result | Notes |
|---|------|--------|-------|
| 15 | Provider errors on the very first turn | ✅ | `fetchCompletionWithRetry` → `{kind:'failed'}` → `flushMessage` + `onStatus(false)` |
| 16 | Network drops mid-turn | ✅ | `isTransientNetError` + `MAX_FETCH_ATTEMPTS` (4) with backoff; watchdog abort scaled by reasoning level |
| 17 | Very long turn (deep reasoning) — user can still type | ✅ | composer stays live; live elapsed ticker; input queued |
| 18 | Switch session/tab while a turn runs | ✅ | agent loop runs detached (`void ...send()`), keyed per session; "acts on what's displayed" |
| 19 | Switch workspace while a turn runs | ✅ | per-project runtimes are independent; old one runs to completion + persists |
| 20 | App quit / crash mid-turn | 🔧 | **Finding B** — user's message + partial turn not checkpointed |
| 21 | Restart → session stuck "running"? | ✅ | `rt.running` is in-memory, rebuilt `false` on load |

### Session boundaries

| # | Case | Result | Notes |
|---|------|--------|-------|
| 22 | Brand-new session, zero messages | ✅ | `newSession()` lazily created on first send; empty thread renders cleanly |
| 23 | Reopen a session after restart | ✅ | history restored from `saveSessions`; stale `active` activity rows now settled (**Finding B**) |
| 24 | Second message cancels the first ("no wait, do X") | 🔧 | same root cause as Finding A (stop + resend) |
| 25 | Message that's only a slash / command-like string | ✅ | the harness has no slash-command layer; treated as ordinary text |

**Batch 1: 25/25 passing after fixes (3 findings fixed).**

---

## Findings & fixes

### Finding A — a stopped turn could resurrect itself
*Cases 8, 24 · `electron/agent-service.ts`*

`runTurnLoop` unconditionally reset `this.aborted = false` at its top. If the
Operator stopped turn A and sent turn B before A's promise chain unwound, B
cleared the flag and A's next `if (this.aborted) return` saw `false` — so both
loops ran concurrently, mutating the same `this.messages`, think-ticker, and
`onStatus`.

**Fix:** added a `generation` counter bumped by every `send()`. Each loop
captures its value; new `turnDefunct(gen)` guard (`aborted || generation
changed`) replaces the bare `aborted` checks and is re-checked after every
`await` that precedes a shared-state write. `send()`'s `catch`/`finally` only
touch the ticker / `onStatus` when their generation is still current.

### Finding B — mid-turn quit/crash lost the user's message
*Case 20, 23 · `electron/project.ts`, `electron/session-store.ts`*

Sessions were only checkpointed on `onStatus(false)` (turn end). A quit or crash
mid-turn dropped the user's just-sent message and any partial agent work from
the visible history. Separately, a persisted `active` activity row rendered a
frozen "Thinking…" ticker on reopen.

**Fix:**
- `sendToAgent` now calls `void this.persist()` right after pushing the user
  message.
- `loadSessions` settles any `active` activity row to `error` + `(interrupted)`
  on load.

### Finding C — no React error boundary in the renderer
*Case 14 · `src/components/ErrorBoundary.tsx` (new), `src/main.tsx`, `src/components/Markdown.tsx`*

A render throw anywhere (e.g. malformed markdown in a model reply) unmounted the
whole React tree — white screen, force-quit the only way out.

**Fix:** added a reusable `ErrorBoundary` (default recoverable panel with "try
again"). Wrapped the app root, and wrapped `Markdown` with a raw-text `<pre>`
fallback so one bad message can't take down the thread.

---

## Verification

| Check | Result |
|-------|--------|
| `npx tsc --noEmit -p .` | exit 0 |
| `npm run build` | exit 0 (pre-existing chunk-size warning only) |

---

## Batch 2 — Stop button, activity/"thinking" truthfulness, navigation (25 cases)

### Stop button

| # | Case | Result | Notes |
|---|------|--------|-------|
| 26 | Stop while agent is thinking (awaiting model) | ✅ | `controller.abort()`; watchdog + `turnDefunct` exit; think ticker settled |
| 27 | Stop while a tool call is executing (grep/read) | ✅ | `turnDefunct(gen)` checked before next call and before pushing results |
| 28 | Stop while a shell command is running | ✅ | `stopAgent()` → `rt.terminal.kill()` + tool result synthesized |
| 29 | Stop while blocked on an Operator approval prompt | ✅ | `stopAgent()` resolves all `pendingApprovals` `false` |
| 30 | Stop while subagents are running | ✅ | `stop()` cascades to `activeSubagents` |
| 31 | Stop during compaction round-trip | ✅ | same `controller` is used for the summarization fetch; aborted |
| 32 | Stop during context-recovery retry | ✅ | `turnDefunct` at loop top ends it before the retry |
| 33 | **Stop, then the trail keeps showing "Thinking…"** | 🔧 | **Finding D** |
| 34 | **Stop when the agent is idle (already finished)** | 🔧 | **Finding E** |
| 35 | Double-click Stop | ✅ | after Finding E, 2nd call early-returns (`turnRunning` false) |
| 36 | Stop as the reply is landing (race) | ✅ | `turnRunning` guard + generation guard |
| 37 | Stop with no active session | ✅ | `stopAgent()` returns on `!activeSessionId` |
| 38 | Stop during background title generation | ✅ | title gen is best-effort, not tied to the turn; unaffected |
| 39 | Stop mid image/music generation | ✅ (weak) | the OpenRouter call runs to completion (no signal wired), but `turnDefunct` discards the result and the row is settled |
| 40 | Switch session, then Stop | ✅ | `stopAgent()` acts on `activeSessionId` — the displayed session, by design |

### "Thinking" / activity indicator truthfulness

| # | Case | Result | Notes |
|---|------|--------|-------|
| 41 | Ticker keeps counting after the turn ends | 🔧 | **Finding D** — `setInterval` row left `active` |
| 42 | Activity row stuck `active` after the step finished | 🔧 | **Finding D** — no settle on interrupt paths |
| 43 | "Thinking…" shown while actually blocked on approval | ✅ | a distinct "Waiting for approval: …" `active` row is emitted; think ticker is already cleared post-fetch |
| 44 | "Thinking…" shown while blocked on diff review | ✅ | turn ends (`onStatus(false)`) at propose; not "thinking" |
| 45 | "Thinking…" shown while blocked on `ask_and_wait` | ✅ | distinct "Waiting for an answer: …" row |
| 46 | Two concurrent think tickers | ✅ | each turn calls `clearThinkTick()` before starting its own; generation guard kills the old loop |
| 47 | Closing-summary row status: finish / stop / crash | ✅ | finish + stop → `done`; crash → `stopped/error`; verified in `flushMessage` / `stop()` / `send()` catch |
| 48 | Elapsed counter after switching away and back | ✅ | `elapsedMs` accumulated server-side on `onStatus`; `runningSince` recomputed on `summary()` |
| 49 | Turn-limit reached — final row + ticker | ✅ | `clearThinkTick()` then final `flushMessage`; ticker settled in `finally` |
| 50 | Crash mid-turn — trail left spinning | 🔧 | **Finding D** — `send()` catch didn't settle rows (now does via `finally`) |

### Navigation / clicks

| # | Case | Result | Notes |
|---|------|--------|-------|
| 51 | Change model in the selector mid-turn | ✅ | `activeModel` + provider captured at turn start; applies next turn |
| 52 | Rapid accept/reject on the same diff hunk | ✅ | `diffs.decide` no-ops on an already-decided hunk; `resumeAfterReview` only fires when the list empties |
| 53 | Close a tab/session whose agent is running | ✅ | `deleteSession` → `stop()` + `terminal.kill()` + approvals resolved + runtime removed; detached `send()` unwinds harmlessly |
| 54 | Approve the same roadmap item twice | ✅ | `decideRoadmapItem` guards on current status |
| 55 | Send to a non-displayed session via scheduler while it's running | ✅ | `sendToSession` returns `false` if `rt.running` |

**Batch 2: 25/25 passing after fixes (2 findings, covering 5 cases).**

---

### Finding D — activity trail kept spinning after a turn stopped
*Cases 33, 41, 42, 50 · `electron/agent-service.ts`*

The "Thinking… Ns" row is driven by a `setInterval` that re-emits an `active`
row every second. `stop()` never called `clearThinkTick()` (it relied on
`send()`'s `finally`, which the new generation guard can now skip), and no path
settled in-flight tool rows on an interrupt. Result: after Stop (or a crash) the
trail showed a forever-counting "Thinking…" and any half-finished tool row stuck
with a spinner — the agent looked like it was still working when it wasn't.

**Fix:**
- `liveRows: Map<id, ActivityEvent>` tracks every row currently `active`
  (maintained in `trackActivity`).
- `settleLiveRows(note, status)` flips them all to a terminal state and stops
  the ticker. Called from `stop()` (`interrupted`), `send()`'s `finally` for the
  current generation (`done`), and the `turnDefunct` early-exit after the
  request is built.

### Finding E — Stop on an idle session emitted a phantom "Stopped by you"
*Case 34, 35 · `electron/agent-service.ts`*

`project.stopAgent()` calls `agent.stop()` unconditionally. With nothing
running, `stop()` still pushed a "Stopped by you" activity row and a closing
summary.

**Fix:** `turnRunning` flag (set across `send()`); `stop()` early-returns when
it's false. Also makes double-clicking Stop a clean no-op on the second click.

---

## Batch 3 — permission & mode gates (25 cases)

### Mid-turn Plan/Build & autonomy flips

| # | Case | Result | Notes |
|---|------|--------|-------|
| 56 | Plan mode hard-denies bash+edit even when Settings override is allow | ✅ | `resolvePermission` checks `mode===plan` BEFORE overrides (`project.ts`) |
| 57 | Plan mode still allows research (webfetch / web_search) | ✅ | Plan only forces deny on bash/edit; webfetch resolves normally |
| 58 | Mid-turn Plan→Build: later tool calls in same turn see Build | ✅ | `getPermission`/`getMode` close over live `this.mode` per call |
| 59 | Mid-turn Build→Plan between tool calls blocks write/run tools | ✅ | Next `run_command` → bash deny; mutating git → Plan blocked; edits deny |
| 60 | Build→Plan AFTER Approve on pending bash card, before runShell | 🔧 | **Finding F1** — post-await re-check of `getPermission`/`getMode` |
| 61 | Mid-turn Manual→Auto: subsequent edits auto-apply | ✅ | Fresh `getPermission(edit)` → allow → `applyEditAuto` |
| 62 | Mid-turn Auto→Manual while turn mid-flight | ✅ | Next edit queues for review; bash returns to ask (absent override) |
| 63 | Flip bash override to deny while approval card open, then Approve | 🔧 | **Finding F1** — same TOCTOU fix as #60 |
| 64 | Always-allow bash, then flip to Plan | ✅ | Plan forces deny before `requestActionApproval`; always-allow never reached |
| 65 | Double-resolve / late click on same approval requestId | ✅ | `resolveApproval` deletes map entry then resolves; second click no-ops |
| 66 | Stop while blocked on approval | ✅ | Stop/delete flushes `pendingApprovals` as false; tool path checks aborted after await |

### Subagent / allowlist / shell chaining

| # | Case | Result | Notes |
|---|------|--------|-------|
| 67 | Subagent bash ask unanswered → denied (fail-closed) | ✅ | `requestSubagentApproval` timeout 3 min → `resolve(false)` |
| 68 | Subagent webfetch when category is ask | 🔧 | **Finding F4** — route all ask categories through fail-closed subagent channel |
| 69 | Allowlist exact/prefix match for non-chained command under bash=ask | ✅ | `matchesAllowlist && !isShellChained` on `run_command` |
| 70 | Allowlist + classic shell chain (`&&`, `;`, pipe, `$(...)`, backticks, `<>`) | ✅ | `isShellChained` catches metacharacters → must prompt |
| 71 | Allowlist prefix on newline/CR-chained command (`ls\nrm ...`) | 🔧 | **Finding F2** — `isShellChained` now includes `\n`/`\r`/Unicode separators |
| 72 | Allowlist pattern `*` | ✅ (weak) | `"*"` → `startsWith("")` matches every command; ask≈allow. Documented residual (Finding F7) |

### Git argv / readonly gadgets

| # | Case | Result | Notes |
|---|------|--------|-------|
| 73 | Git tool: argv via execFile (no shell word-split / `&&`) | ✅ | `runGit` → `execFile("git", argv, ...)`; leading-flag `argv[0]` rejected |
| 74 | Git network/config class blocked (push/pull/fetch/clone/remote/config/…) | ✅ | `GIT_BLOCKED` on `argv[0]` before perms |
| 75 | Read-only git (status/log/…) allowed in Plan | ✅ | Intentional; still blocked if bash=deny |
| 76 | `git diff --ext-diff` (readonly set, no flag audit) | 🔧 | **Finding F3** — `gitHasExecutionEnablers` forces non-readonly |
| 77 | Mutating git under balanced/auto bash=allow (bisect run, `!` aliases, clean -fdx) | ✅ (weak) | execFile is clean; policy gap when bash=allow (Finding F6) — not Batch 3 scope |
| 78 | Git allowlist path omits `isShellChained` | ✅ | OK for execution (no shell). Residual: `git *` under bash=ask auto-approves destructive subs |

### Plan mode side doors

| # | Case | Result | Notes |
|---|------|--------|-------|
| 79 | Plan blocks generate_image / generate_music / delegate_build | ✅ | Explicit `getMode()===plan` checks |
| 80 | Plan still allows schedule_task, add_rule, memory_* writes, spawn_focus_agent, file_bug_report | 🔧 | **Finding F5** — mutators gated; memory list/search remain |

**Batch 3: 25/25 passing after fixes (5 findings F1–F5 fixed; F6/F7 residual/weak documented).**

---

### Finding F1 — Approval TOCTOU: mode/perm not re-checked after Approve
*Cases 60, 63 · `electron/agent-service.ts` (run_command, mutating git) · severity: high*

Gate logic snapshotted `bashPerm`, awaited approval, then executed with no second
`getPermission()` / `getMode()`. During the await the Operator could flip to Plan
or set bash=deny; Approving still ran the command.

**Fix:** After `requestActionApproval` resolves true (run_command + mutating git),
re-read `getPermission("bash")` and `getMode()`. If now deny or Plan, refuse with
the same error strings as the pre-await path. Always-allow cannot outrank a live
deny/Plan.

### Finding F2 — Newline/CR bypass of isShellChained → allowlist auto-approve
*Case 71 · `electron/perm-store.ts` isShellChained · severity: high*

`isShellChained` omitted `\n`/`\r` while `spawn({shell:true})` runs multiple lines.
Under bash=ask + pattern `ls*`, `ls\nrm -rf ...` auto-approved. TerminalSession's
plain-cd check already treated newline as a chain marker.

**Fix:** Extended the regex to `\n`, `\r`, and Unicode line/paragraph separators
(`U+2028`/`U+2029`). `terminal-session.ts` plain-cd check now imports the shared
`isShellChained` helper.

### Finding F3 — Read-only git can still execute host helpers
*Case 76 · `electron/agent-service.ts` GIT_READONLY / isReadOnlyGit · severity: high*

`GIT_READONLY.has("diff")` skipped Plan + ask with no inspection of `--ext-diff`,
`--textconv`, `-c` / `--config`, or `--exec` — host helpers could run while labeled
read-only, including in Plan.

**Fix:** Added `gitHasExecutionEnablers(argv)`. If any of those flags are present,
`isReadOnlyGit` returns false so Plan/ask gates apply (no readonly short-circuit).

### Finding F4 — Subagent webfetch ask auto-approved
*Case 68 · `electron/agent-service.ts` runSubagent · severity: medium*

Subagent `requestActionApproval` did `Promise.resolve(true)` for every non-bash
category. webfetch=ask became allow for subagent network/media tools (deny still
worked via `getPermission`).

**Fix:** Route all ask categories through `requestSubagentCommandApproval` (same
fail-closed 3 min timeout as bash). Non-bash descriptions are prefixed
`[category]`. Missing channel → deny (never auto-true).

### Finding F5 — Plan mode side doors (schedule / rules / memory / focus spawn)
*Case 80 · `electron/agent-service.ts` callTool · severity: medium*

Plan hard-denied bash/edit and blocked generate_image/music/delegate_build, but
`schedule_task`, `add_rule`, `memory_*` mutators, `spawn_focus_agent`, and
`file_bug_report` had no `getMode()===plan` check — durable side effects while
"only planning."

**Fix:** Gate those mutators with `PLAN_MODE_BLOCKED`. Read-only memory paths
(`memory_topic` list, `memory_record` search) and `list_scheduled_tasks` stay allowed.

### Residual (not fixed in Batch 3)

- **F6** (case 77, medium/policy): balanced defaults bash=allow → `git bisect run` /
  pre-existing `!` aliases promptless. execFile path is correct; policy follow-up.
- **F7** (case 72, low): allowlist pattern `*` matches everything. Document or
  reject on save later.

---

## Batch 3 verification

| Check | Result |
|------|------|
| `npx tsc --noEmit` | exit 0 |
| `npm run build` | exit 0 (vite + build-main.mjs; pre-existing chunk-size warning only) |

---

## Next batches (planned)

- **Batch 4:** budget accounting (mid-turn cap crossing, subagent fan-out overrun, malformed `set_budget`)
- **Batch 5:** context/compaction recovery, byte-budget, provider malformed responses
- **Batch 6:** subagent / focus-agent concurrency, message-board deadlocks, orphan cleanup
- **Batch 7:** file-edit path safety (traversal, stale diffs, audit-log targeting, unicode/Windows paths)
