# Taskfolio の開発に参加する

[English](CONTRIBUTING.md) · 日本語 · [README](README.ja.md)

## 開発時の動作確認

CLI は安定版の Rust を使います。リポジトリのルートでテストとリリースビルドを実行してください。コレクターは軽量に保ち、大きな依存パッケージの追加は必要な場合に限ります。

```sh
cargo test --locked --manifest-path cli/Cargo.toml
cargo build --locked --release --manifest-path cli/Cargo.toml
```

Worker は [worker/package.json](worker/package.json) に指定した Node のバージョンを使います。Vitest のテストは、ローカルの Workers ランタイムと D1 で実行されます。

```sh
cd worker
npm ci
npm run typecheck
npm test
npm run build:ui
```

UI をローカルで起動する場合は、`.dev.vars.example` を `.dev.vars` にコピーし、Access 用の 3 項目を設定します。`worker/` で `npx wrangler d1 migrations apply DB --local` と `npx wrangler dev` を順に実行してください。ローカル API も有効な Access アサーションを検証します。認証が必要な API の動作はテストスイートで確認できます。保護したホスト名でログインまで試す手順は[セットアップガイド](SETUP.ja.md)にあります。`.dev.vars` は Git の管理対象外です。

## ブランチとコミット

最新の `main` から作業用ブランチを切り、1 つのテーマごとにプルリクエストを開きます。`main` は常に動作する状態に保ち、変更はプルリクエスト経由で取り込みます。ブランチ名は `feat/cli-scan-command`、`fix/codex-token-delta`、`docs/setup-guide` のように、小文字とハイフンで書きます。

コミットメッセージは英語で [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) に従います。1 つの変更と対応するテストを同じコミットに含め、そのコミットだけでもビルドでき、個別に取り消せるようにします。

```text
feat(cli): add scan command with JSON and table output
fix(cli): count Claude usage once per message and request id
docs: add setup guide for Cloudflare Access
```

- 種別は `feat`、`fix`、`docs`、`refactor`、`perf`、`test`、`build`、`ci`、`chore` のいずれかを使います。ブランチ名にも同じ種別を使います。
- スコープは任意です。`cli`、`api`、`web`、`db`、`deps`、`ci` などが使えます。要約は小文字の動詞の原形で始め、72 文字以内に収め、末尾のピリオドは省きます。
- 変更理由を補足する場合は本文を加え、72 文字で折り返します。互換性を壊す変更では種別かスコープの直後に `!` を付け、フッターの `BREAKING CHANGE:` に内容を書きます。

## プルリクエスト

最新の `main` にリベースし、タイトルをコミットメッセージと同じ形式で書きます。本文には何をなぜ変えたかと、実施した確認を記載してください。レビュー前にチェックが通ることを確認し、作業途中のコミットを整理します。取り込みには **Rebase and merge** を使い、変更ごとのコミットを残します。

Mac から新たに送るデータがある場合は、内容と送信先を明記します。セッションの収集対象から会話本文は除外します。タスク名生成と所有者がボードに書く依頼文は、それぞれ別の経路で送信されます。セットアップ、プライバシーに関わる動作、利用者向けの手順を変えたときは、日英の文書を更新してください。[現在送信するデータ](README.ja.md#mac-から送るデータ)

## 本番 Worker のリリース

[Deploy Taskfolio ワークフロー](.github/workflows/deploy-production.yml)で、既存の本番 Worker に `main` の対象コミットを公開できます。新たに環境を作る場合は[セットアップガイド](SETUP.ja.md)を参照してください。

1. GitHub の `production` 環境に `main` からデプロイできるよう設定します。`CLOUDFLARE_ACCOUNT_ID` と `TASKFOLIO_DATABASE_ID` は環境変数、`CLOUDFLARE_API_TOKEN` は環境シークレットに設定します。既存の本番構成では、対象 Worker に限定した Individual Workers Editor 権限を使っています。
2. 未適用の D1 マイグレーションは、公開前にデータベース管理者の認証情報で適用します。ワークフローが実行するのは Worker のビルド、テスト、デプロイです。ローカルの `npm run deploy` はマイグレーションも適用します。
3. Actions で **Deploy Taskfolio** を開き、`main` を選んで **Run workflow** を実行します。ビルドと本番への接続だけ確認するときは **Verify the release and Cloudflare connection without publishing** を選択します。公開するときはチェックを外します。公開したコミットは実行結果のサマリーと Cloudflare のバージョン情報に記録されます。

コントリビューションには [MIT ライセンス](LICENSE)が適用されます。
