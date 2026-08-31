# Forge

Desktop pair-programming agent with reviewable diffs and governed autonomy.

Forge is an Electron app: a chat-driven coding agent that works directly in
a project on disk, but every edit and command it wants to run is gated by
your own permission settings — nothing lands unreviewed unless you've told
it to.

## Features

- **Reviewable diffs.** File edits go through a per-hunk review overlay
  before they touch disk, unless you've set edits to auto-allow.
- **Plan / Build mode.** Plan mode can read, search, and research but can't
  edit or run commands; Build mode unlocks everything, governed by autonomy
  and per-category permissions (edit / bash, each allow / ask / deny).
- **Multiple providers.** OpenRouter, FairRouter, local Ollama, local
  llama.cpp, or the OpenAI Codex CLI (via your own ChatGPT/Codex
  subscription) — pick and switch from the in-app provider/model selector.
- **Companion + background builder** (Codex provider). Talk to a read-only
  companion while a separate builder thread edits/builds/tests in the
  background; see [COMPANION-ARCHITECTURE.md](COMPANION-ARCHITECTURE.md).
- **Scheduler.** Recurring or one-time reminders/tasks the agent can create
  for itself and later check the real status of.
- **Phone portal.** A password-protected, tunnel-exposed chat page for
  reaching your projects and chats from a phone.
- **Voice in/out**, **image/music generation**, **web search**, and a git
  tool the agent can use directly (read-only git commands always allowed;
  anything that changes the repo goes through the same approval gate as
  everything else, with no network commands).

## Getting started

Requires Node.js and, on Windows, a working native-module toolchain for
Electron.

```bash
npm install
npm run dev
```

Copy `.env.example` to `.env` and fill in the providers/keys you plan to
use — everything in it is optional except picking at least one model
provider from the in-app selector. See the comments in
[.env.example](.env.example) for what each variable does.

## Scripts

- `npm run dev` — start the app in development mode
- `npm run build` — build the renderer and main process
- `npm run package` — build and package a Windows installer (electron-builder)
- `npm run release` — cut a release

## Documentation

- [CHANGELOG.md](CHANGELOG.md) — every released version, newest first
- [COMPANION-ARCHITECTURE.md](COMPANION-ARCHITECTURE.md) — companion/builder
  design for the Codex provider
- [EDGE-CASES.md](EDGE-CASES.md) — tracked edge-case test campaign
- [AUDIT.md](AUDIT.md) — audit log of agent actions
