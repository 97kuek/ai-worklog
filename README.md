# Taskfolio

A calendar of what your AI coding agents worked on, and when.

Taskfolio reads the local session logs of **Claude Code** and **Codex**, turns each session into time blocks, and shows them on a calendar you can open from any device. Click a block to see the project, branch, models, token usage, and recorded work intervals.

> **Status: pre-alpha.** The CLI collects Claude Code and Codex sessions. The web app includes a work log, calendar, task board, activity statistics, skill catalog and an interactive 3D office.

## Why

AI agents now do a large share of day-to-day work, but there is no easy way to look back and answer "what did my agents work on this week, and for how long?" Taskfolio is meant to be a lightweight work log and daily report for AI-assisted work.

## How it works

```
Your Mac(s)                                   Your Cloudflare account
┌─────────────────────────────┐               ┌──────────────────────────────┐
│ Claude Code / Codex logs    │               │ Cloudflare Access (login)    │
│            │                │    HTTPS      │            │                 │
│            ▼                │ ────────────▶ │ Worker: API + calendar UI    │
│ Taskfolio CLI (Rust)       │               │            │                 │
│  - collect: sessions,       │               │            ▼                 │
│    work blocks, tokens      │               │ D1 (SQLite)                  │
│  - statusline: rate limits  │               └──────────────────────────────┘
└─────────────────────────────┘
```

- **One session = one task.** Sessions are split into work blocks wherever there is a gap of 30 minutes or more.
- **Short, consistent task names**, collected from saved Codex thread names when available. Haiku generates a name through Claude Code for sessions without one. Edit the name in task details to override it. Later uploads preserve the override.
- **Rate limits**: Claude Code via the official status line input; Codex from its session logs.
- **Self-hosted.** You deploy it to your own Cloudflare account.
- **Privacy.** The Taskfolio API receives metadata: timestamps, project and branch names, models, token counts, the saved or generated task name, and the names, descriptions and supported tools of available skills. When naming is enabled, Claude Code sends short excerpts of the opening exchange to the configured model to generate a title. Set `naming.enabled` to `false` in the collector config to turn this off.

## Components

| Directory | What | Language |
|---|---|---|
| `cli/` | Collector, status line wrapper, and hooks that run on each Mac | Rust |
| `worker/` | Cloudflare Worker serving the API and web UI, backed by D1 | TypeScript |

## Collecting logs

Run `taskfolio collect` for incremental collection or `taskfolio collect --rescan` to reread available Claude Code and Codex logs. Both use the existing upload ledger. Rescanning preserves manually edited task titles and sends updated metadata for changed sessions.

New installations store collector settings and state in `~/.taskfolio`. Set `TASKFOLIO_HOME` to use another location. Run `taskfolio doctor` to check the installation.

## Taskfolio web UI

The layout reference is [DESIGN.md](DESIGN.md). Taskfolio uses white surfaces, indigo table headers and lavender date selections. Task names use the standard text color. The interface uses three text sizes (16, 20, and 32 px) and a visible keyboard focus outline.

- **Work log** shows work blocks for a Sunday–Saturday week. Waiting tasks have a pale purple background. The work location is the final directory name recorded by the collector. Filter by day or latest task status, change the date sort order, or select a task to see its details.
- **Calendar** displays simultaneous blocks side by side and splits them at local midnight. Status labels and colored edges indicate the latest task status. On smaller screens, select one of the seven days.
- **Board** lets you plan requests in Backlog, then move a card into Queued to run it. Drag the card on desktop or use its move action on your phone. The registered Mac takes the first waiting request it can run. Open a waiting session or drag it into Completed to mark it complete.
- **Activity** stacks each project's active time by local hour in Daily and by day in Weekly. Select a weekday to open its hourly chart. Concurrent tasks each contribute their duration. The Projects table shows active time and distinct task counts for every project, including those grouped under Other projects in the chart. Select an hour to filter both Projects and Model usage. Each task counts once per recorded combination of engine, model and effort.

- **Skills** lists the tool, name, and description reported by Claude Code and Codex. Matching names and descriptions appear once with both tools. The collector queries both tools from the user’s home directory by default. Set `skills_cwd` in the CLI configuration to include skills available in a specific project.

- **Office** has three employees per room. When you open Office, employees with running tasks are already typing. As new tasks arrive, an employee chosen at random from the café walks to a desk and returns when the task ends. The same task keeps its employee across reloads in that tab. Additional rooms open as needed. Select a working employee or a task in the list to open its details. The office checks for status changes every 15 seconds while visible. The editable Blender scene is [Taskfolio.blend](design/office/Taskfolio.blend).

The 3D scene uses natural materials, including oak desks, felt dividers, and an upholstered reading chair. The three-color web palette applies to the surrounding interface.

The Worker builds the UI from `worker/ui/` during Wrangler development and deployment. Apply pending D1 migrations before deploying the Worker.

## Run a queued request on your Mac

Taskfolio currently serves one owner per Cloudflare deployment. Set up the protected Worker and D1 database for that owner, then enroll each Mac that will run work. Windows runners are not supported yet.

1. On the Mac, install the CLI from this repository with `cargo install --locked --path cli`. The default install location is `~/.cargo/bin/taskfolio`.
2. Install and sign in to Claude Code or Codex on that Mac. Run `taskfolio login --url <worker-url> --machine-name <display-name> --client-id <access-service-token-id>` and enter the service-token secret when prompted. Taskfolio stores the secret in the macOS Keychain.
3. From this repository, run `python3 scripts/install-runner.py "$HOME/.cargo/bin/taskfolio"` to start the runner at login. If you use a custom Taskfolio home, pass `--state-dir /absolute/path/to/state`.
4. Run `taskfolio folder add`, choose a working folder in Finder, and wait for the next runner check-in. Use `taskfolio folder add --path /absolute/path --name project-key` for a named checkout. Each key identifies one folder on that Mac. Run the command again to add another folder.
5. Open **Settings** using the gear in the header. Find the Mac by its display name, check its reported engines and press **Test connection**. A successful test means that Mac checked in after the request. An available engine means the runner found its executable; provider sign-in happens on the Mac. Use the switch beside a folder to pause or resume future requests on that Mac. An active session can finish.

The browser only sees registered project keys. The mapping to absolute paths stays on each Mac in `runner.json` beside `config.json`. A project seen in a work log becomes runnable when a Mac registers its folder. If the `taskfolio` command is outside your shell’s PATH, use `"$HOME/.cargo/bin/taskfolio"` in its place.

Choose a registered project and engine, then move the request from Backlog to Queued. The runner checks for work every 30 seconds while the Mac is awake and logged in. It executes one eligible request at a time in queue order. A queued request waits while its Mac is offline. You can return a waiting request to Backlog until a runner claims it. If execution fails, return the card to Backlog, correct its settings and queue it again. New configurations use Codex’s read-only sandbox. Set `codex_sandbox` to `workspace-write` in that Mac’s `runner.json` to allow Codex to edit its working folder. The Mac resolves the project folder and provider executable locally and reports the execution status to the Board. To disable future launches on this Mac, allow the current job to finish, then unload the agent with `launchctl bootout "gui/$(id -u)/dev.taskfolio.runner"` and remove its plist from `~/Library/LaunchAgents`.

## Session status

`collect` sends the latest observed state and its timestamp with the session. `GET /api/blocks` returns it as `observed_status`. The values are `running`, `waiting` (a reply is ready or input is pending), and `unknown` (for example, an interrupted turn). Older sessions can have no observation. The board stores the user’s completion time separately in `completed_at`. Later uploads preserve it.

On macOS, the collector reads active Claude Code sessions to notice when an approved tool resumes. Codex uses a permission hook and the current turn's human-review setting to identify a pending decision. It can confirm execution has resumed at the next model request. An automatic approval hook can resolve a request before a person sees a dialog. Collection reports the latest observation at each run, so short-lived states can pass between uploads.

When upgrading, apply the Worker migrations and update the Worker before upgrading the CLI. Run `taskfolio setup --print-only` with the installed binary, merge the displayed hooks into the existing settings for each tool, and review the new Codex hooks in `/hooks`. The first collection rereads available main-session logs from older caches to recover status.

## Roadmap

1. CLI core: scan local logs into sessions and work blocks
2. Cloudflare Worker, D1 schema, and authentication with Cloudflare Access
3. Incremental collection, upload, launchd, hooks, task naming, and rate-limit recording
4. Web UI (execution log, weekly calendar, task board, and details)
5. Distribution: Deploy to Cloudflare button, CLI packaging, setup guide

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
