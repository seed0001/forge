# Changelog

Every released version of Forge, newest first. Dates are when the build went out.

## 0.2.36 — 2026-08-29

- **Codex CLI is a provider now.** Pick "Codex CLI" from the provider dropdown and your turns run through OpenAI's `codex exec` instead of a chat-completions API — it uses your ChatGPT/Codex subscription (run `codex login` once in a terminal; nothing to paste into Settings). Codex runs its own sandboxed agent loop; its commands, reasoning, and file edits stream into the Activity panel, and each session remembers its Codex thread across turns and restarts. In **Auto** autonomy Codex writes files straight to disk (it can't be held for diff review — that's how `codex exec` works); in Manual/Balanced it stays read-only. Optional `CODEX_BIN` in Settings if `codex` isn't on your PATH.

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
