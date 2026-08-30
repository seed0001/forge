# Changelog

Every released version of Forge, newest first. Dates are when the build went out.

## 0.2.46 — 2026-08-29

- **The side panels now have visible scrollbars.** The Activity, Roadmap, Focus, and Sessions panels always could scroll, but the scrollbar thumb (`#262626` on a near-black panel) was almost invisible — so a panel with more content than fits just looked like it was cut off at the bottom with no way down. The thumb is now a clearly visible grey, slightly wider, with a faint track behind it, and every scroll area reserves its gutter so content doesn't jump when the bar appears. Each panel is also hard-capped to the window height as a belt-and-suspenders guard so its body can never grow past the viewport unscrolled.

## 0.2.45 — 2026-08-29

- **The agent now describes Forge's own features accurately instead of guessing.** Asked "how does your scheduler work?", it had no grounding on its host app and answered by describing a *different* product's scheduler — inventing capabilities and citing an unrelated docs page. The system prompt now carries an authoritative **ABOUT FORGE** section (the scheduler, roadmap, Focus agents, knowledge base, autonomy/Plan-Build/permissions, the diff-review queue), and a grounding rule that questions about how Forge works are answered *only* from that section or from Forge's own source — never from general knowledge or a web search about a similarly-named feature in another tool. If it doesn't know a detail, it says so.

## 0.2.44 — 2026-08-29

- **Edge-case hardening of the chat loop and Stop button.** First pass of a systematic edge-case test campaign (tracked in `EDGE-CASES.md`), fixing five real bugs found by tracing abnormal paths:
  - **Stopping the agent, then immediately sending a new message, could leave two turn-loops running at once** — the new message reset the internal "stopped" flag while the old loop was still unwinding, and both then mutated the same conversation. Turns now carry a generation token; a stopped turn stays dead no matter what starts after it.
  - **The Activity trail kept showing "Thinking… 12s" (and half-finished tool rows) after you hit Stop or after a crash.** Every in-flight row is now settled the instant a turn ends by any path, and the thinking ticker is stopped directly by Stop rather than left to a cleanup step that could be skipped.
  - **Hitting Stop when the agent was already idle** wrote a phantom "Stopped by you" row and a bogus run summary. Stop is now a no-op when nothing is running, and double-clicking it is clean.
  - **Quitting or crashing mid-turn dropped your last message** from the visible history along with anything the agent had done that turn — the conversation was only checkpointed when the agent went quiet. Your message is now saved the moment you send it, and a session reopened after a crash no longer shows a frozen "Thinking…" row.
  - **A malformed reply from the model could white-screen the whole app** — there was no React error boundary anywhere. Added one around the app (with a "try again") and around message rendering (falls back to raw text), so one bad message can't take down the window.

## 0.2.43 — 2026-08-29

- **The agent can use git.** New `git` tool: he runs one git command in the project root as an argv array — `["commit", "-m", "..."]`, `["diff", "--staged"]`, `["switch", "-c", "feature"]`. Read-only commands (`status`, `diff`, `log`, `show`, `blame`, and bare `branch`/`tag` listings) always run, even in Plan mode. Anything that changes the repo goes through the same approval gate and Plan-mode block as `run_command`, is written to `AUDIT.md`, and can be auto-approved via the bash allowlist. Network commands — `push`, `pull`, `fetch`, `clone`, `remote`, `submodule` — are blocked outright; he stages and commits locally and tells you it's ready to push. Nothing is run through a shell, so args are never word-split or chained. Subagents and Focus agents get the tool too.

## 0.2.42 — 2026-08-30

- **Plan / Build mode.** A new toggle in the composer, next to the autonomy slider. Every project now starts in **Plan** mode: the agent can read files, list/glob/grep, and research on the web, but every tool that changes something — `propose_edit`, `edit_file`, `run_command`, `generate_image`, `generate_music` — is turned off, no matter the autonomy level. He's told up front that he's planning, so he gathers what he needs and then lays out the plan and asks you to switch. Flip the toggle to **Build** (any time) and he has full access again, governed by autonomy as before. Subagents and Focus agents inherit the project's mode. The setting is per-project and resets to Plan on restart, same as the autonomy level.

## 0.2.41 — 2026-08-30

- **Reopening a project no longer shows a red "Hit a problem" glow when nothing failed.** Stopping the agent yourself recorded its closing activity row as an `error`, so the ambient field read that as a crashed run every time the project was loaded again. A manual stop is now recorded as what it is — you halting the agent, not a failure — and the mood derivation ignores the stop marker (and narration rows) when deciding whether the last run ended badly.

## 0.2.40 — 2026-08-29

- **You can give the agent a persona.** New **Settings › Agent › Persona** box takes a free-text note on the voice the agent should write in — say "dry and a little sardonic, short sentences, the occasional wry aside" — and it's spliced into the system prompt as a `PERSONA` block so replies get some flavor. Leave it blank for the default neutral voice. It's told to let the persona colour phrasing only, never to bend facts, grounding, or the safety rules. Stored as `AGENT_PERSONA` in `forge/.env`; takes effect on the next request, no restart.

## 0.2.39 — 2026-08-29

- **The agent narrates what it's about to do, right in the Activity trail.** It already sent a one-or-two-sentence "here's what I'm about to do and why" note to the chat before each batch of tool calls; that same statement of intent now also shows up as its own row in the Activity panel, inline with the tool calls it describes — so a long tool-call loop reads as a followable story instead of a wall of silent `read`/`grep`/`run` rows. The style guidance was tightened too: on a long run the agent is told to narrate *more* often, not less, and to say so whenever the picture changes (found it, hit a dead end, new plan, new sub-task) before acting on it.

## 0.2.38 — 2026-08-29

- **Fixed "the total text input size exceeds 8 MB" when exploring a large codebase.** `read_file` returned the whole file with no size limit, and since every turn re-sends the full conversation, reading a handful of big source files could push the request past OpenRouter's 8 MB text ceiling — even when all you asked for was "look at the codebase." A single `read_file` result is now capped at 200,000 characters, with a note pointing the agent at `grep` for the rest. Every other content tool was already clamped; this one wasn't.

## 0.2.37 — 2026-08-29

- **Codex CLI can actually write files now.** 0.2.36 shipped it clamped to read-only unless you were on Auto autonomy, and — worse — the sandbox was baked into the Codex thread on its first turn, so flipping the setting afterwards did nothing on resume. Codex now gets workspace write access at every autonomy level, re-applied on every turn (so a permission change takes effect on the very next message). Its edits land straight on disk (shown in Activity + AUDIT.md, undoable via git) — `codex exec` is non-interactive and can't wait on the per-hunk review queue. Set **File edits → Always deny** (or Shell commands → Always deny) under Settings › Permissions to force Codex read-only.

## 0.2.36 — 2026-08-29

- **Codex CLI is a provider now.** Pick "Codex CLI" from the provider dropdown and your turns run through OpenAI's `codex exec` instead of a chat-completions API — it uses your ChatGPT/Codex subscription (run `codex login` once in a terminal; nothing to paste into Settings). Codex runs its own sandboxed agent loop; its commands, reasoning, and file edits stream into the Activity panel, and each session remembers its Codex thread across turns and restarts. Optional `CODEX_BIN` in Settings if `codex` isn't on your PATH.

## 0.2.35 — 2026-08-28

- **The agent can no longer hang the turn on a bad `grep` pattern.** A regex from the model now runs on a separate thread that's killed after 4 seconds — a catastrophic-backtracking pattern comes back as an error the agent can react to instead of freezing the run with no way out.
- **Every web request a tool makes now has a timeout.** `webfetch`, web search, image/vision/music generation, and the title/summary helper calls used to wait forever on a server that connected but never answered. Each now aborts on a deadline (and fetched pages are size-capped, so parsing a huge page can't wedge the turn either).
- **A broken scheduled-task time no longer stalls the scheduler.** Working out the next run for an impossible cron expression (e.g. "the 30th of February") took ~1,000,000 steps every tick; it now resolves in one.

## 0.2.34 — 2026-08-28

- **Roadmap is a side panel now, not a tab.** When the agent proposes a roadmap it appears in a collapsible panel on the right — expand/collapse each milestone, and hit **Discuss & chat** on any item to pull its plan into the composer and talk it through (re-outline, expand, whatever). Items waiting for review auto-expand and can be approved or rejected right there.
- **Activity panel.** A new right-side panel shows what the agent looked at, reasoned about, and changed — grouped one card per run, newest last, each expandable down to the individual steps (reads, commands, edits with diff stats). The active run stays open and ticks live.
- Both panels collapse to a thin rail and only appear when there's something to show.

## 0.2.33 — 2026-08-28

- **What's New view.** Click the version number at the bottom of the sidebar to see this changelog — every release, what changed, and when — without leaving the app. GitHub release notes now come from the same place.

## 0.2.32 — 2026-08-28

- **Fixed the "stuck thinking forever" bug.** If an unexpected error hit mid-turn, the agent could stay pinned on the purple "deep thinking" state indefinitely — no way to tell what it was doing, no way to recover without restarting. The turn loop now always unwinds cleanly, shows a real error, and logs `agent loop crashed` to the audit trail.
- **Follow-up messages are no longer dropped.** A message sent while the agent was already working used to vanish silently. It's now shown in the chat and queued — it runs as the next turn the moment the current one finishes. Stop clears the queue.
- **"Deep Thinking" no longer times out on hard problems.** The request timeout now scales with the reasoning level (Flash 90s / Thinking 4 min / Deep 12 min) and also covers the response download, so a long reasoning pass isn't aborted just as it was about to land.
- **Sidebar Time / Cost tick live** during a run instead of showing a frozen number until it ends.

## 0.2.31 — 2026-08-28

- **Conversational project budget.** Tell the agent "we've got $5 for this" and it holds the line — it stops when the cap is reached, says so, and stays chat-only (no commands, no edits) until you say "go over budget" or give it a new amount. A `$2.34 / $5.00` chip in the composer tracks spend, red when reached.

## 0.2.30 — 2026-08-28

- **In-app Audit view.** A new "Audit" tab shows everything the agent did — commands, files read/listed, searches, model requests with their size, and provider errors — filterable, with a live auto-refresh. No more digging through `AUDIT.md` by hand.

## 0.2.29 — 2026-08-28

- **Full activity audit trail.** `AUDIT.md` now records file reads, directory listings, `grep`/`glob`, every model request (with wire size and image count), and every provider error verbatim.
- **Oversize requests recover automatically** — if a request is still over the size limit after trimming images, the agent compacts the conversation and retries rather than sending a request it knows will be rejected.

## 0.2.28 — 2026-08-28

- **Decluttered the top bar.** Autonomy and Reasoning moved down next to the chat input; the update control and version number moved to a footer at the bottom of the sidebar.

## 0.2.27 — 2026-08-28

- **Reasoning-depth control.** A Flash / Thinking / Deep Thinking picker sets how hard the model reasons on each turn.

## 0.2.26 — 2026-08-28

- **Fixed the "total text input size exceeds 8 MB" error** in long visual sessions — inline images that stacked up on the wire are now trimmed oldest-first before a request goes out.

## 0.2.25 — 2026-08-28

- **Hardened the terminal.** A command can no longer wedge the agent: `cd /d` and quoted paths parse correctly, a bad `cd` no longer poisons the shell, chained `cd x && …` passes through, commands have a 5-minute timeout, interactive prompts get EOF instead of hanging, and Stop actually kills the whole process tree.

## 0.2.24 — 2026-08-27

- Soft-key visual treatment for the composer.

## 0.2.23 — 2026-08-27

- Soft-key visual treatment for the sidebar and top toolbar.

## 0.2.22 — 2026-08-27

- The bundled ruleset is now a single Operator-owned `RULES.md` you can edit.

## 0.2.21 — 2026-08-27

- Settings and the main shell reworked into floating panels on a canvas.

## 0.2.20 — 2026-08-26

- **Workspace → Project → Session structure.** Workspaces are now typed and renameable, above projects.

## 0.2.19 — 2026-08-26

- Focus-agent side panel; phone portal finished.

## 0.2.18 — 2026-08-26

- Workspace tabs persist and restore across restarts.

## 0.2.17 — 2026-08-26

- Edge TTS retries on transient connection drops.

## 0.2.16 – 0.2.15 — 2026-08-26

- **Voice output (TTS)** with Edge, Windows SAPI, and XTTS providers.
- The phone portal is opt-in and lives in Settings.

## 0.2.14 — 2026-08-26

- **Local model providers:** Ollama and llama.cpp. Interim chat status notes while the agent works.

## 0.2.13 — 2026-08-26

- **Phone portal:** a local server + Cloudflare quick-tunnel with a mobile chat page (voice in/out via the browser, no login).

## 0.2.12 — 2026-08-26

- **Scheduler**, background **Focus agents**, a cross-agent message board, and a bug-report tool.

## 0.2.11 — 2026-08-26

- Expanded tool registry, cost/budget tools, and automatic recovery from context-length-exceeded errors.

## 0.2.10 — 2026-08-26

- **Per-project knowledge base**, a global lessons file, and automatic `PROJECT.md` / `SCRATCH.md` injection.

## 0.2.9 — 2026-08-25

- Request retry/backoff, a watchdog timeout, empty-reply nudges, model-collapse failover, and a tool-call loop breaker.

## 0.2.8 — 2026-08-25

- **Permission categories**, a bash allowlist, always-allow, and a guardrail interceptor.

## 0.2.7 – 0.2.5 — 2026-08-25

- Filter out OpenRouter batch-only and tool-incompatible model variants.
- The activity trail is paced so fast steps don't flash past, then collapsed to one live status line.

## 0.2.4 — 2026-08-25

- Fixed page-clip reviews vanishing from the agent's memory.

## 0.2.2 – 0.2.0 — 2026-08-25

- **Browsing workspaces:** an embedded browser with summarize / save-as-markdown.
- Fixed a Google CAPTCHA issue and a dead-tab-after-switching issue in the embedded browser.
- Security hardening: key exposure, unscoped filesystem reads, subagent autonomy bypass, audit-log integrity.

## 0.1.9 — 2026-08-25

- **Independent sessions:** one agent per session instead of one per workspace.

## 0.1.8 – 0.1.3 — 2026-08-24 / 25

- Project roadmaps (a two-level checklist with per-item approval).
- FairRouter added as a second chat provider, with a provider selector.
- Settings: max tool calls per task; provider API keys.
- Updates are fully manual — no auto-check, no auto-download, no auto-install.
- Auto-updating release pipeline; fixed the blank-window packaged build and a startup crash.

## 0.1.0 — 2026-08-24

- Initial release: Forge desktop agent.
