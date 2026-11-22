# Contributing to ai-worklog

Thanks for your interest in contributing! This guide describes how we branch, commit, and review changes.

## Branching (GitHub Flow)

- `main` is always in a working state. Never commit directly to `main`.
- Create a short-lived branch from the latest `main` for each change, then open a pull request.
- Name branches `<type>/<short-description>` in lowercase kebab-case, using the same types as commit messages:

  | Example | Use for |
  |---|---|
  | `feat/cli-scan-command` | A new feature |
  | `fix/codex-token-delta` | A bug fix |
  | `docs/setup-guide` | Documentation only |
  | `refactor/split-adapters` | Code changes that neither fix a bug nor add a feature |
  | `test/claude-fixtures` | Adding or fixing tests |
  | `chore/update-deps` | Tooling, dependencies, and maintenance |
  | `ci/add-rust-workflow` | CI configuration |

- Keep branches small and focused. One pull request should address one topic.

## Commits

### One logical change per commit

- Each commit should contain exactly one logical change that can be understood and reverted on its own.
- Keep tests in the same commit as the code they test.
- Do not mix unrelated changes, such as a refactor and a bug fix, in one commit.
- Each commit should build and pass the tests.

### Commit message format (Conventional Commits)

We follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/). Write messages in English.

```
<type>(<scope>): <summary>

<body: optional, explains what and why>

<footer: optional, e.g. "BREAKING CHANGE: ..." or "Closes #123">
```

- **type**: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`
- **scope** (optional): `cli`, `api`, `web`, `db`, `deps`, `ci`
- **summary**: imperative mood ("add", not "added" or "adds"), lowercase first letter, no trailing period, 72 characters or fewer
- **body**: wrap at 72 characters. Explain *why* the change is needed when it is not obvious from the summary.
- Mark breaking changes with `!` after the type or scope (for example, `feat(api)!: ...`) and describe them in a `BREAKING CHANGE:` footer.

Examples:

```
feat(cli): add scan command with JSON and table output
fix(cli): count Claude usage once per message and request id
docs: add setup guide for Cloudflare Access
chore(deps): bump serde_json to 1.0.140
```

## Pull requests

1. Rebase your branch on the latest `main` before opening a pull request.
2. Give the pull request a title in the same format as a commit message.
3. Describe what changed, why, and how you tested it.
4. Make sure all checks pass.
5. Pull requests are merged with **Rebase and merge**, so the logical commits on your branch are kept as they are in `main`. Clean up "fix typo" or "wip" commits before review (for example, with `git rebase -i`).

## Development

### CLI (`cli/`)

Requirements: the stable Rust toolchain (install with [rustup](https://rustup.rs/)).

```bash
cd cli
cargo test
cargo build --release
```

Keep the CLI lightweight: avoid async runtimes and heavy dependencies unless there is a clear need.

### Worker (`worker/`)

Requirements: Node (managed by [Volta](https://volta.sh/); the version is pinned in `worker/package.json`).

```bash
cd worker
npm ci
npm test            # runs Vitest inside the Workers runtime
npm run typecheck
```

To run the Worker locally, copy `.dev.vars.example` to `.dev.vars` and fill in the values. `.dev.vars` is ignored by Git.

## Privacy

ai-worklog must never upload conversation text or prompts. Any change that sends new data off the user's machine needs a clear explanation in the pull request.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
