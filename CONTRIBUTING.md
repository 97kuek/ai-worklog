# Contributing to Taskfolio

English · [日本語](CONTRIBUTING.ja.md) · [README](README.md)

## Run the development checks

From the repository root, use stable Rust for the CLI. Keep the collector lightweight and avoid heavy dependencies unless the change requires them.

```sh
cargo test --locked --manifest-path cli/Cargo.toml
cargo build --locked --release --manifest-path cli/Cargo.toml
```

Use the Node version pinned in [worker/package.json](worker/package.json). Vitest runs the Worker tests against a local Workers runtime with D1.

```sh
cd worker
npm ci
npm run typecheck
npm test
npm run build:ui
```

To serve the UI locally, copy `.dev.vars.example` to `.dev.vars`, set the three Access bindings, then run `npx wrangler d1 migrations apply DB --local` and `npx wrangler dev` from `worker/`. The API checks for a valid Access assertion on local requests too. Use the test suite for authenticated API scenarios. The [setup guide](SETUP.md) covers the full sign-in flow on a protected hostname. Keep your local `.dev.vars` out of Git.

## Branches and commits

Start a short-lived branch from the latest `main` and open a pull request for one topic. Keep `main` in a working state and make changes through pull requests. Use lowercase kebab-case branch names such as `feat/cli-scan-command`, `fix/codex-token-delta` or `docs/setup-guide`.

Write commits in English using [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/). Use one logical change per commit, keep its tests with it, and make each commit buildable and independently reversible.

```text
feat(cli): add scan command with JSON and table output
fix(cli): count Claude usage once per message and request id
docs: add setup guide for Cloudflare Access
```

- Use `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci` or `chore` for the type. Use the same types in branch names.
- Optional scopes include `cli`, `api`, `web`, `db`, `deps` and `ci`. Start the summary with a lowercase imperative verb. Keep it within 72 characters and omit the final period.
- If the reason needs explanation, add a body wrapped at 72 characters. For a breaking change, use `!` after the type or scope and add a `BREAKING CHANGE:` footer.

## Pull requests

Rebase on the latest `main`, give the pull request a Conventional Commit title, and describe the change, its purpose and your checks. Ensure the checks pass and tidy up temporary commits before review. Use **Rebase and merge** to preserve the logical commits.

Explain any new data that leaves the Mac and its destination. Keep conversation bodies out of session ingest. Title generation and owner-authored board requests have separate data flows. Update both language editions when changing setup, privacy behavior or user-facing guidance. [Current data flows](README.md#what-leaves-your-mac)

## Release the production Worker

The [Deploy Taskfolio workflow](.github/workflows/deploy-production.yml) publishes a selected `main` commit to the existing production Worker. For a new deployment, start with [Set up Taskfolio](SETUP.md).

1. Configure the GitHub `production` environment for `main`. Set `CLOUDFLARE_ACCOUNT_ID` and `TASKFOLIO_DATABASE_ID` as environment variables and `CLOUDFLARE_API_TOKEN` as an environment secret. The existing production setup uses an Individual Workers Editor token scoped to the Worker.
2. Apply pending D1 migrations with the database operator's credentials before publishing. The workflow builds, tests and deploys the Worker. The local `npm run deploy` script also applies migrations.
3. In Actions, open **Deploy Taskfolio** and choose **Run workflow** on `main`. Select **Verify the release and Cloudflare connection without publishing** for a dry run and a remote versions check. For publication, clear the option. The run summary and Cloudflare version metadata identify the published commit.

By contributing, you agree to license your contributions under the [MIT license](LICENSE).
