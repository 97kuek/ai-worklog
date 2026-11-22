# Taskfolio のセットアップ

[English](SETUP.md) · 日本語 · [README](README.ja.md)

Web アプリは所有者ごとに 1 回デプロイします。接続する Mac では、それぞれログインが必要です。作業記録を残したい Mac にはコレクターを、ボードから依頼を実行したい Mac にはランナーを設定します。

## Web アプリをデプロイする

ここでは Cloudflare で管理しているドメインに専用のホスト名を用意します。Cloudflare アカウントと、Workers、D1、Zero Trust Access を設定できる権限が必要です。Node は [worker/package.json](worker/package.json) で指定したバージョンを使います。Volta を使う場合は、`worker/` に移動すると自動で切り替わります。

1. `tasks.example.com` のような専用のホスト名を選びます。Zero Trust でセルフホスト型の Access アプリケーションを作成し、そのホスト名の**すべてのパス**を保護します。所有者のメールアドレスを対象に **Allow** ポリシーを追加し、ログイン方法を設定します。アプリケーションの Audience タグ（AUD）と、`your-team.cloudflareaccess.com` の形式のチームドメインを控えます。[Cloudflare Access の設定](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
2. Access のサービス認証情報で、**Mac ごとに 1 つのサービストークン**を発行します。同じアプリケーションに **Service Auth** ポリシーを追加し、発行したトークンを対象に指定します。それぞれの Client ID と Client Secret を、その Mac の設定用に保管します。Taskfolio はこのトークンで Mac を識別します。[Cloudflare のサービストークン](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
3. ソースを取得し、Worker の依存パッケージをインストールします。すでにリポジトリを取得している場合は、そのルートで `cd worker` から始めてください。

   ```sh
   git clone https://github.com/97kuek/taskfolio.git
   cd taskfolio
   cd worker
   npm ci
   npx wrangler login
   npx wrangler whoami
   ```

4. 自分の Cloudflare アカウントに Taskfolio 用の D1 データベースを作り、名前とデータベース ID を控えます。手元の [worker/wrangler.jsonc](worker/wrangler.jsonc) で、既存の `DB` の項目に `database_name` と `database_id` を設定します。`migrations_dir`、UI のビルド設定、静的ファイルのバインディングは既存の値を使います。`name` には自分のアカウントで使える Worker 名を指定します。次の項目をトップレベルに追加し、ホスト名を手順 1 のものに置き換えます。`preview_urls` は `false` のままにします。[Cloudflare D1](https://developers.cloudflare.com/d1/get-started/) · [Worker のカスタムドメイン](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

   ```json
   {
     "workers_dev": false,
     "routes": [{ "pattern": "tasks.example.com", "custom_domain": true }]
   }
   ```

5. `whoami` が表示したアカウントを確認し、`worker/` からデプロイします。`npm run deploy` はリモート D1 にマイグレーションを適用し、UI をビルドして Worker を公開します。続く 3 つのコマンドでは、プロンプトに従って Worker 用の値を入力します。Mac のサービストークンのシークレットは Mac のキーチェーンに保存します。

   ```sh
   npm run deploy
   npx wrangler secret put ACCESS_TEAM_DOMAIN
   npx wrangler secret put ACCESS_AUD
   npx wrangler secret put OWNER_EMAIL
   ```

   順に、`https://` を除いたチームドメイン、Access アプリケーションの Audience タグ、Allow ポリシーで指定した所有者のメールアドレスを入力します。[Worker のシークレット](https://developers.cloudflare.com/workers/configuration/secrets/)

6. ブラウザーのプライベートウィンドウで保護したホスト名を開き、Access のログイン画面が表示されることを確認します。所有者としてログイン後、同じホストの `/api/me` を開き、`{"kind":"user"}` が返れば成功です。最初の Mac が記録を送るまでは Work log が空でも正常です。

## Mac を接続する

安定版の新しい Rust と Cargo を使います。Homebrew で [rustup](https://rustup.rs/) を導入済みなのに Cargo が見つからない場合は、先に `export PATH="$(brew --prefix rustup)/bin:$PATH"` を実行します。初めて Homebrew で Rust を入れる場合は、`brew install rust` で Cargo も入ります。続いて、インストール後の Taskfolio もターミナルから呼び出せるよう、Cargo の標準インストール先を PATH に加えます。リポジトリのルートで以下を実行してください。

```sh
export PATH="$HOME/.cargo/bin:$PATH"
cargo --version
cargo install --locked --path cli
taskfolio --version
taskfolio scan --since-days 7 --format table
```

`scan` は `~/.claude/projects` と `~/.codex` の記録を読みます。次に Worker のベース URL、Mac の表示名、その Mac 用の Client ID を指定してログインします。例の 3 つの値を自分のものに置き換え、Client Secret はキーチェーンのプロンプトで入力してください。

```sh
taskfolio login --url 'https://tasks.example.com' --machine-name 'My Mac' --client-id 'YOUR_CLIENT_ID'
```

新規インストール時の設定と状態の保存先は `~/.taskfolio` です。`login` は実際の `config.json` の場所を表示します。別の場所を使う場合は各コマンドの実行前に `TASKFOLIO_HOME` を設定し、ランナーのインストーラーにも同じ場所を `--state-dir` で指定します。旧版から使っている場合は `~/.ai-worklog` が使われることがあります。

## セッションを収集する

1. タスク名の自動生成を使わない場合は、`collect` や `setup` を実行する前に、生成された `config.json` の `naming.enabled` を `false` にします。初期設定では、Claude Code に初期のユーザーメッセージの抜粋を渡して名前を生成します。[Mac から送るデータ](README.ja.md#mac-から送るデータ)
2. `taskfolio collect` を実行し、結果の `sessions_sent`、`errors`、`auth_failed` を確認します。ブラウザーで **Work log** を開き、`scan` に出たセッションの週を表示します。変更がなければ、次に実行したときの送信件数は 0 です。
3. `taskfolio setup` でコレクターをログイン時に起動するよう設定します。利用しているツールに合わせ、表示されたフックを既存の `~/.claude/settings.json`、`~/.codex/hooks.json` に追加します。Codex では `/hooks` または **Settings > Hooks** で内容を確認します。設定例をもう一度表示するには `taskfolio setup --print-only` を使います。
4. `taskfolio doctor` を実行し、`api` 行に `GET /api/me -> machine` と出ることを確認します。ほかの行では、コレクターの起動設定、両ツールのフック、名前生成用のコマンド、トークンの有効期限を個別に確認できます。フックが作業状況の変化を通知し、定期収集も 10 分ごとに動きます。

既存のログを読み直すには `taskfolio collect --rescan` を使います。送信済みの内容と照合するので、変更分が反映され、手動で付けたタスク名も保持されます。収集エラーは、状態の保存先にある `logs/collect.log` と `logs/launchd.log` で確認できます。

## ボードの依頼を実行する

1. 実行に使う Claude Code または Codex の CLI をインストールし、ランナーを動かす Mac のユーザーでサインインします。使う予定のプロジェクトで CLI を開き、簡単な依頼に応答することを確認します。Codex には信頼済みの Git リポジトリを使います。
2. ターミナルで `taskfolio folder add` を実行し、Finder で作業フォルダーを選びます。フォルダー名がプロジェクトの登録名になります。別名で登録するには `taskfolio folder add --path "/absolute/path/to/project" --name demo` を使います。必要なフォルダーごとに繰り返してください。同じプロジェクトを複数の Mac で使い、依頼先を指定したい場合は、Mac ごとに別の名前で登録します。
3. リポジトリのルートで、Python 3 とインストール済みの実行ファイルを使ってランナーを起動します。

   ```sh
   python3 scripts/install-runner.py "$(command -v taskfolio)"
   ```

   インストーラーは通常 `~/.taskfolio` を使います。別の場所を使う場合は、末尾に `--state-dir "/absolute/path/to/state"` を追加します。ランナーはコレクターとは別のログインエージェントです。ユーザーがログインし、Mac がスリープしていない間、30 秒ごとに依頼を確認します。

4. 歯車アイコンから **Settings** を開きます。Mac から接続が来たら画面を更新し、Mac の表示名、登録したプロジェクト、エンジンを確認します。**Test connection** は、押した後にその Mac が接続すれば成功です。実行に時間がかかる依頼でも、ランナーは約30秒ごとに接続状況を送ります。エンジンが利用可能と表示された場合、ランナーは実行ファイルを見つけています。プロバイダーの認証やモデルの利用権限は依頼の実行時に確認されます。
5. **Board** の **＋ Add** を選びます。最初は「ファイルを変更せず、現在のフォルダー名を答えてください」と入力し、登録したプロジェクトとエンジンを指定します。モデルと推論レベルは初期値のままで試せます。**Add to backlog** で保存し、ドラッグまたはカードの移動ボタンで **Queued** に移します。プロバイダーが正常終了すると **Completed** にカードが表示されます。ボードで確認できるのは実行状態です。プロバイダーがセッション履歴を保存した場合、応答内容は Mac 上の履歴で確認できます。

各ランナーは、実行条件に合う依頼を 1 件ずつ引き受けます。Mac がオフラインの間は待機し、引き受けるまでは Backlog に戻せます。失敗した場合は、カードのエラーを確認して原因に対処し、Backlog に戻してから再度 Queued に移します。

### 設定の変更と停止

- **Settings** でフォルダーのスイッチをオフにすると、新しい依頼を一時停止できます。実行中の依頼はそのまま処理を続けます。登録名とローカルフォルダーの対応表は、Mac の状態保存先にある `runner.json` に保存されます。
- Codex の初期設定は `read-only` です。編集を許可する Mac では、このファイルのトップレベルに `codex_sandbox` を追加し、値を `"workspace-write"` に設定します。
- ログイン時の実行を止めるには、実行中の依頼が終わってから `launchctl bootout "gui/$(id -u)/dev.taskfolio.runner"` を実行し、`~/Library/LaunchAgents/dev.taskfolio.runner.plist` を削除します。

## 困ったときは

| 症状 | 確認すること |
| --- | --- |
| ターミナルで Cargo や Taskfolio が見つからない | `command -v cargo` と `command -v taskfolio` を実行します。Cargo の標準インストール先は `~/.cargo/bin` です。この場所を PATH に追加するか、実行ファイルの絶対パスを使います。 |
| ブラウザーや CLI で認証できない | ホスト名、チームドメイン、AUD、所有者のメールアドレスを確認します。Mac はその端末用のトークンと **Service Auth** ポリシーも確認してください。`taskfolio doctor` でキーチェーンと Worker での端末認証を確認できます。 |
| Settings にランナーからの接続がない | Mac のログインとスリープ状態を確認します。`launchctl print "gui/$(id -u)/dev.taskfolio.runner"` で起動設定を、状態保存先の `logs/runner.log` でエラーを確認します。`login` とインストーラーで同じ状態保存先を使っているかも確認してください。 |
| プロジェクトやエンジンが表示されない | ターミナルで `command -v claude` または `command -v codex` を実行します。ランナーが初期設定なら、そのシェルで `taskfolio folder add` をやり直すと実行ファイルの場所が記録されます。フォルダーの実在を確認し、次の接続後に画面を更新します。 |
| 依頼が待機したまま、または失敗する | 同じ Mac のフォルダースイッチ、エンジン、最終接続時刻を確認します。プロバイダーが失敗したときは、そのフォルダーで同じモデルを対話的に試します。ランナーが中断されたときは、再実行前に、すでに実行された作業を Mac で確認してください。 |

アップグレード時は、先に D1 マイグレーションを適用して新しい Worker を公開します。その後で CLI を再インストールし、`taskfolio setup` を実行してフックの変更点を確認します。リポジトリの本番公開手順は[開発ガイド](CONTRIBUTING.ja.md#本番-worker-のリリース)を参照してください。
