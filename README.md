# ai-worklog

A calendar of what your AI coding agents worked on, and when.

ai-worklog reads the local session logs of **Claude Code** and **Codex**, turns each session into time blocks, and shows them on a calendar you can open from any device. Click a block to see the project, branch, models, token usage, and how much of your rate limit was used at the time.

> **Status: pre-alpha.** The design is settled and implementation has just started. Nothing is usable yet.

## Why

AI agents now do a large share of day-to-day work, but there is no easy way to look back and answer "what did my agents work on this week, and for how long?" ai-worklog is meant to be a lightweight work log and daily report for AI-assisted work.

## How it works

```
Your Mac(s)                                   Your Cloudflare account
┌─────────────────────────────┐               ┌──────────────────────────────┐
│ Claude Code / Codex logs    │               │ Cloudflare Access (login)    │
│            │                │    HTTPS      │            │                 │
│            ▼                │ ────────────▶ │ Worker: API + calendar UI    │
│ ai-worklog CLI (Rust)       │               │            │                 │
│  - collect: sessions,       │               │            ▼                 │
│    work blocks, tokens      │               │ D1 (SQLite)                  │
│  - statusline: rate limits  │               └──────────────────────────────┘
└─────────────────────────────┘
```

- **One session = one task.** Sessions are split into work blocks wherever there is a gap of 30 minutes or more.
- **Short, consistent task names**, generated locally for each session.
- **Rate limits**: Claude Code via the official status line input; Codex from its session logs.
- **Self-hosted.** You deploy it to your own Cloudflare account. Your data never goes to a third-party service.
- **Privacy by default.** Conversation text and prompts never leave your machine. Only metadata is uploaded: timestamps, project and branch names, models, token counts, and the generated task name.

## Components

| Directory | What | Language |
|---|---|---|
| `cli/` | Collector, status line wrapper, and hooks that run on each Mac | Rust |
| `worker/` | Cloudflare Worker serving the API and static calendar UI, backed by D1 | TypeScript |

Both directories will be added as implementation progresses.

## Roadmap

1. CLI core: scan local logs into sessions and work blocks
2. Cloudflare Worker, D1 schema, and authentication with Cloudflare Access
3. Incremental collection, upload, launchd, hooks, task naming, and rate-limit recording
4. Calendar UI (week view, overlapping blocks, details)
5. Distribution: Deploy to Cloudflare button, CLI packaging, setup guide

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
