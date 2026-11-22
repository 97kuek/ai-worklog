# Set up Taskfolio

English · [日本語](SETUP.ja.md) · [README](README.md)

Deploy the web app once per owner. Repeat the Mac sign-in for each computer you want to connect. Enable collection on Macs whose work you want to record, and install a runner on Macs that should also accept requests.

## Deploy the web app

You need a Cloudflare account, an active domain on Cloudflare for the hostname in this guide, and permission to manage Workers, D1 and Zero Trust Access. Use the Node version pinned in [worker/package.json](worker/package.json). Volta selects it automatically inside `worker/`.

1. Choose a dedicated hostname such as `tasks.example.com`. In Zero Trust, create a self-hosted Access application covering **all paths** on that hostname. Add an **Allow** policy for the owner's email and configure a login method. Note the application's audience tag (AUD) and your team's domain, such as `your-team.cloudflareaccess.com`. [Cloudflare Access setup](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
2. In Access service credentials, create **one service token per Mac**. Add a **Service Auth** policy to the same application that includes those specific tokens. Save each Client ID and Client Secret for its Mac. Taskfolio uses the token identity to distinguish machines. [Cloudflare service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
3. Get the source and install Worker dependencies. If you already have a checkout, start at `cd worker`.

   ```sh
   git clone https://github.com/97kuek/taskfolio.git
   cd taskfolio
   cd worker
   npm ci
   npx wrangler login
   npx wrangler whoami
   ```

4. In your Cloudflare account, create a D1 database for Taskfolio and copy its name and database ID. In **your copy** of [worker/wrangler.jsonc](worker/wrangler.jsonc), set `database_name` and `database_id` on the existing `DB` entry. Keep `migrations_dir`, the UI build, and the asset bindings. Set `name` to a Worker name available in your account. Add the following top-level fields, substituting your protected hostname, and keep `preview_urls` set to `false`. [Cloudflare D1](https://developers.cloudflare.com/d1/get-started/) · [Worker custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

   ```json
   {
     "workers_dev": false,
     "routes": [{ "pattern": "tasks.example.com", "custom_domain": true }]
   }
   ```

5. From `worker/`, deploy to the account shown by `whoami`. The deploy script applies remote D1 migrations, builds the UI and publishes the Worker. Set the three Worker bindings at the prompts. The Mac's service-token secret belongs in its Keychain.

   ```sh
   npm run deploy
   npx wrangler secret put ACCESS_TEAM_DOMAIN
   npx wrangler secret put ACCESS_AUD
   npx wrangler secret put OWNER_EMAIL
   ```

   Enter the team domain without `https://`, the Access application's audience tag and the owner's allowed email, respectively. [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

6. Open the protected hostname in a private browser window. Access should ask you to sign in. After signing in as the owner, open `/api/me` on the same hostname and check for `{"kind":"user"}`. The work log can be empty until the first Mac uploads.

## Connect a Mac

You need a recent stable Rust toolchain with Cargo. If you installed [rustup](https://rustup.rs/) through Homebrew and Terminal cannot find Cargo, run `export PATH="$(brew --prefix rustup)/bin:$PATH"` first. For a new Homebrew installation, `brew install rust` provides Cargo. Add Cargo’s default install directory to PATH so Terminal can also find Taskfolio. From the repository root, run the following commands.

```sh
export PATH="$HOME/.cargo/bin:$PATH"
cargo --version
cargo install --locked --path cli
taskfolio --version
taskfolio scan --since-days 7 --format table
```

The scan reads `~/.claude/projects` and `~/.codex`. Sign in to your Worker using the base URL and the Client ID for this Mac. Replace the three example arguments with your own values. Enter the secret at the Keychain prompt.

```sh
taskfolio login --url 'https://tasks.example.com' --machine-name 'My Mac' --client-id 'YOUR_CLIENT_ID'
```

New installations use `~/.taskfolio`. The login command prints the actual `config.json` location. For a custom directory, export `TASKFOLIO_HOME` before running Taskfolio commands and pass the same directory to the runner installer with `--state-dir`. Existing installations may use `~/.ai-worklog`.

## Collect sessions

1. To turn off automatic title generation, change the existing `naming.enabled` setting to `false` in the generated `config.json` before collecting or running setup. The default uses Claude Code and excerpts from early user messages. [Data sent by Taskfolio](README.md#what-leaves-your-mac)
2. Run `taskfolio collect`. Inspect `sessions_sent`, `errors` and `auth_failed` in the report. Open **Work log** on the week of a session shown by `scan`. A second run can send zero sessions when nothing has changed.
3. Run `taskfolio setup` to install the collector's login agent. Merge the printed hook entries into the existing `~/.claude/settings.json` and `~/.codex/hooks.json` for the tools you use. Review the Codex hooks in `/hooks` or **Settings > Hooks**. Use `taskfolio setup --print-only` to see the snippets again.
4. Run `taskfolio doctor`. The `api` line should report `GET /api/me -> machine`. Read each check individually. The command also checks the collector agent, hooks for both tools, naming command and token expiry. Hooks trigger collection on session activity, with a ten-minute fallback.

To reread available logs, run `taskfolio collect --rescan`. The upload ledger tracks changes and preserves manual task titles. For collection errors, check `logs/collect.log` and `logs/launchd.log` inside the state directory.

## Run a board request

1. Install and sign in to the intended Claude Code or Codex CLI as the Mac user who will run it. Open that CLI in the intended project and check that it can answer a simple request. For Codex, use a trusted Git checkout.
2. From Terminal, register a folder with `taskfolio folder add` and select it in Finder. To give an existing folder a project key, run `taskfolio folder add --path "/absolute/path/to/project" --name demo`. Repeat for each folder. By default the folder name is the project key. Use separate keys to target different Macs that have copies of the same project.
3. From the repository root, start the runner using Python 3 and the installed binary:

   ```sh
   python3 scripts/install-runner.py "$(command -v taskfolio)"
   ```

   The default state directory for this installer is `~/.taskfolio`. For any other directory, append `--state-dir "/absolute/path/to/state"`. The runner uses a separate launch agent and polls every 30 seconds while the Mac is awake and the user is logged in.

4. Open the gear icon for **Settings**. After a check-in, refresh to find the Mac, its enabled project key and the selected engine. **Test connection** succeeds when that Mac checks in after the test starts. The runner checks in about every 30 seconds during a long task as well. An available engine means the runner found the executable. Provider sign-in and permission to use the model are checked when the provider runs.
5. In **Board**, select **＋ Add**. For a first test, enter “Report the current folder name without changing files”, choose the registered project and engine, and leave model and effort at their defaults. Select **Add to backlog**, then move the card to **Queued** by dragging it or using the card's move button. When the provider exits successfully, the card appears under **Completed**. The board shows execution status. Read the agent's response in its local session history if the provider saved one.

Each runner takes one eligible request at a time. A queued request waits while its Mac is offline. Before a Mac claims it, you can move it back to Backlog. If execution fails, inspect the failure on the card, correct the cause and return it to Backlog before queuing it again.

### Change or stop the runner

- Switch off a working folder in **Settings** to pause new launches. A running task can finish. The key-to-folder mapping stays in `runner.json` in the Mac's state directory.
- Codex uses `read-only` by default. To allow edits, set the top-level `codex_sandbox` field in that file to `"workspace-write"` on the Mac that should perform them.
- To stop accepting requests at login, let the active request finish, run `launchctl bootout "gui/$(id -u)/dev.taskfolio.runner"`, then remove `~/Library/LaunchAgents/dev.taskfolio.runner.plist`.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Terminal cannot find Cargo or Taskfolio | Run `command -v cargo` and `command -v taskfolio`. Cargo installs Taskfolio in `~/.cargo/bin` by default. Add this directory to your PATH, or use the absolute binary path. |
| Browser or CLI cannot authenticate | Check the exact hostname, team domain, AUD and owner email. For the Mac, verify its token and **Service Auth** policy. Use `taskfolio doctor` to check Keychain access and the machine identity. |
| Settings has no runner check-in | Confirm the Mac is awake and logged in. Run `launchctl print "gui/$(id -u)/dev.taskfolio.runner"` and check `logs/runner.log` under the installer's state directory. Verify that login and the installer used the same state directory. |
| A project or engine is missing | Run `command -v claude` or `command -v codex` in Terminal. With the default runner settings, repeat `taskfolio folder add` from that shell so the runner records the executable path. Check that the registered folder still exists. Refresh after the next check-in. |
| A request stays queued or fails | Check the folder switch, engine availability and last check-in on the same Mac. If the provider failed, try it interactively in that checkout with the same model. If the runner was interrupted, inspect any work it already performed before retrying. |

For an upgrade, apply the migrations and deploy the new Worker first. Reinstall the CLI, rerun `taskfolio setup`, and review any updated hook entries. The repository's production release workflow is described in [Contributing](CONTRIBUTING.md#release-the-production-worker).

To show your Claude Code accounts in **Usage** and **Skills**, follow the [account registration instructions](CLAUDE-USAGE.md).
