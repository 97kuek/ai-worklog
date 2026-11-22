# Claude Code account usage

Register any number of local Claude Code profiles to see each account in **Usage** and **Skills**. Choose a stable ID for each account. Use 1–64 lowercase ASCII letters, digits, hyphens or underscores, starting with a letter or digit. Accounts with the same ID for the same provider are combined across your machines.

Build and install the Taskfolio CLI as described in [Setup](SETUP.md), then log in. Register each account's actual configuration directory with `--profile ACCOUNT=DIR`. Claude Code uses `~/.claude` when `CLAUDE_CONFIG_DIR` is unset.

```sh
python3 scripts/install-claude-usage.py \
  --profile "personal=$HOME/.claude" \
  --profile "team-research=/absolute/path/to/team/claude" \
  --binary "$(command -v taskfolio)"
taskfolio sync-usage
```

Supply `--profile` once for a single account or repeat it for several. Running the installer again adds or updates the specified accounts. The account mapping is stored in `claude-usage-profiles.json` inside the Taskfolio home. An existing mapping continues to work after a CLI update.

If dotfiles manage the profiles, add `--settings-source "/absolute/path/to/source/settings.json"`. The installer wraps the status-line command in the managed source and the specified profiles. It preserves existing display options and passes the original JSON input to the previous renderer. A machine without the Taskfolio binary can still use that renderer.

| Dashboard metric | Source and coverage |
| --- | --- |
| Input and output tokens | Cumulative assistant usage across the available main and subagent transcripts for each account. Input includes cache reads and writes. Duplicate assistant messages count once per session. The first sync includes existing transcripts. |
| Estimated cost | Latest `cost.total_cost_usd` reported by Claude Code for each observed session, summed by account. When Claude Code retains a project's last cost and session UUID locally, the first sync can also recover that session’s cost. A live observation takes precedence. |
| Five-hour and seven-day limits | Latest reported `rate_limits` window for the account, including its reset time when supplied. Availability depends on the plan and on Claude Code receiving an API response. |

The status line records quota and cost locally. The existing collector uploads the numbers on its next run and retries after a failed upload. For an immediate usage-only sync, run `taskfolio sync-usage`. The upload contains the account label, session UUID, observation time and numeric usage. The collector reads numeric message usage and selected project-summary fields locally. It sends neither conversation content nor credentials. Missing observations remain unknown.

Claude Code's `context_window` token counters describe the latest response. The collector uses message usage from local transcripts for the cumulative total. [Claude Code status-line reference](https://code.claude.com/docs/en/statusline)
