# Taskfolio

English · [日本語](README.ja.md)

Taskfolio is a self-hosted work log for Claude Code and Codex. See which projects your agents worked on, when they ran, and how much time they spent. From the same board, you can send a new request to a registered folder on your Mac.

**Pre-alpha.** Each deployment serves one owner. The web app runs on Cloudflare Workers with D1 and Cloudflare Access. The collector and optional queue runner run on your Mac.

## Try the work log locally

From a checkout of this repository, use a recent stable Rust toolchain to preview the last seven days of local logs. This command works before you configure Cloudflare.

```sh
cargo run --locked --manifest-path cli/Cargo.toml -- scan --since-days 7 --format table
```

Each session is one task. A gap of 30 minutes or more starts a new work block by default. Active time is the sum of those recorded intervals. Select a task in the web app to see its branch, models, token counts and work blocks.

Codex Desktop can import external chats. Taskfolio excludes replayed turns from the calendar and activity totals, while keeping work recorded when you resume an imported chat. To correct previously uploaded blocks, apply the Worker migrations and deploy the Worker before upgrading the CLI. The next collection rereads available Codex logs and uploads the corrections.

The collection log records uploads pending retry and sessions recovered by a later upload. It emits a warning when a session first fails two consecutive temporary upload attempts. Skill inventory errors are recorded separately under `skill_errors`.

## Web sign-in

To sign in to the Taskfolio web UI with Google, add Google as an identity provider in Cloudflare Zero Trust and enable it on the Taskfolio Access application. Use the Google account whose email matches the Worker's existing `OWNER_EMAIL` so Access and Taskfolio resolve the same account. Restrict the application's Allow policy to that address and test access in a fresh browser session before changing the existing sign-in methods. See the [Cloudflare Google identity provider guide](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/google/).

The collector and runner authenticate separately using Cloudflare Access service credentials configured through `taskfolio login`.


## Set up your work log

1. Deploy the Worker and database to your Cloudflare account and protect the hostname with Access.
2. Install the CLI on each Mac and sign in with a separate Access service token for each one.
3. Run the collector, then open **Work log** in your browser. The collector reads existing session logs and sends changes to your Worker.

Follow the [setup and troubleshooting guide](SETUP.md) for commands, configuration and checks.

## Run a queued request on your Mac

The optional runner executes board requests. Register a folder on the Mac, install the runner, then open the gear icon in **Settings** to confirm its next check-in. Create a request in **Board**, choose the project and engine, and move it from **Backlog** to **Queued**. An eligible Mac takes the request and reports its result. [Mac runner setup](SETUP.md#run-a-board-request)

## Explore the web app

| View | What you can do |
| --- | --- |
| Work log | Review the week’s work, filter by day or status, and edit a task title. Later collections keep your edits. |
| Calendar | See overlapping work side by side. Blocks split at local midnight. On a small screen, choose one day. |
| Board | Plan requests and follow running, waiting and completed tasks. Mark a waiting session complete. The Completed lane shows the last seven days. |
| Activity | Compare projects by hour or day. Overlapping time counts once and is shared equally among active projects. Select an hour to see project and model usage. |
| Skills | Browse the skill names and descriptions reported by each tool. The collector queries the user’s home directory by default. Set `skills_cwd` to inspect a project instead. |
| Office | Open a running task by selecting its employee in the 3D office or its name in the list. The view refreshes every 15 seconds while visible. |
| Settings | See each Mac’s last check-in, registered folders and reported engines. Use a folder’s switch to pause or resume new launches. |

## What leaves your Mac

- **Session collection.** The Worker receives the machine name, session ID, title, project, working directory (which can be an absolute path), branch, tool, model and effort, status, timestamps, message counts and token usage. Skill inventory contains tool names, skill names and descriptions. Raw session logs stay on the Mac. [Example upload](contract/ingest.example.json)
- **Generated titles.** The collector uses saved Codex thread names when available. For eligible untitled sessions, automatic naming sends excerpts of early user messages to the configured model through Claude Code (Haiku by default). To skip that call, change `naming.enabled` to `false` in `config.json` before the first collection.
- **Board requests.** Text you enter on the board is stored in D1. When a runner claims it, the Mac passes that text to the selected provider. The runner reports project keys, available engines and execution status. Its mapping from project keys to local folder paths stays in `runner.json`.

## Project documentation

[Setup and troubleshooting](SETUP.md) · [Contributing and release checks](CONTRIBUTING.md) · [Interface design](DESIGN.md) · [MIT license](LICENSE)

## Usage

Open **Usage** to compare tokens, estimated session costs, remaining allowances and reset times by account. Claude Code reports five-hour and seven-day limits when available. Skills can be filtered by account. Activity groups model usage by engine. [Register Claude Code accounts](CLAUDE-USAGE.md)
