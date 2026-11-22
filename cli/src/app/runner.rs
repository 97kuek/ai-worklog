//! Poll once, finish one initial turn and report its exit status.
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{ErrorKind, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use super::collect::acquire_named_lock;
use crate::adapters::http::{HttpSender, SendError};
use crate::adapters::{config, fsutil, keychain};
use serde::{Deserialize, Serialize};

type Result<T> = std::result::Result<T, &'static str>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    projects: BTreeMap<String, PathBuf>,
    executables: BTreeMap<String, PathBuf>,
    #[serde(default)]
    codex_sandbox: Sandbox,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Sandbox {
    #[default]
    ReadOnly,
    WorkspaceWrite,
}

impl Settings {
    fn load(home: &Path) -> Result<Self> {
        let bytes =
            fs::read(home.join("runner.json")).map_err(|_| "runner.json を読み込めません")?;
        let settings: Self =
            serde_json::from_slice(&bytes).map_err(|_| "runner.json の形式が正しくありません")?;
        if settings.projects.is_empty()
            || settings.projects.len() > 1024
            || settings.projects.iter().any(|(name, dir)| {
                name.trim().is_empty()
                    || name.trim() != name
                    || name.encode_utf16().count() > 256
                    || name.chars().any(char::is_control)
                    || !dir.is_absolute()
                    || !dir.is_dir()
            })
        {
            return Err(
                "runner.json の projects にプロジェクト名と実在する絶対ディレクトリを指定してください",
            );
        }
        if settings.executables.is_empty()
            || settings.executables.iter().any(|(engine, path)| {
                !matches!(engine.as_str(), "codex" | "claude_code")
                    || !path.is_absolute()
                    || !fs::metadata(path)
                        .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            })
        {
            return Err(
                "runner.json の executables に codex または claude_code の実行可能な絶対パスを指定してください",
            );
        }
        Ok(settings)
    }
}

#[derive(Clone, Deserialize, Serialize)]
struct Job {
    attempt_id: String,
    request_id: String,
    project: String,
    title: String,
    engine: String,
    model: Option<String>,
    effort: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
struct Report {
    attempt_id: String,
    state: State,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum State {
    Running,
    Completed,
    Failed,
}

impl Report {
    fn failed(attempt_id: &str, error: &str) -> Self {
        Self {
            attempt_id: attempt_id.into(),
            state: State::Failed,
            error: Some(error.into()),
        }
    }
}

#[derive(Deserialize, Serialize)]
enum Journal {
    Prepared(Job),
    Report(Report),
}

fn checkpoint(path: &Path, entry: &Journal) -> Result<()> {
    let bytes = serde_json::to_vec(entry).map_err(|_| "ジャーナルをシリアライズできません")?;
    fsutil::write_atomically(path, &bytes)
        .and_then(|()| File::open(path.parent().unwrap())?.sync_all())
        .map_err(|_| "ジャーナルを保存できません")
}

fn sender(home: &Path) -> Result<HttpSender> {
    let cfg =
        config::load(&home.join("config.json")).map_err(|_| "config.json を読み込めません")?;
    let uri = cfg
        .api_url
        .parse::<ureq::http::Uri>()
        .map_err(|_| "API URL が不正です")?;
    let authority = uri.authority().ok_or("API URL にホストが必要です")?;
    if authority.as_str().contains('@') || uri.query().is_some() || !matches!(uri.path(), "" | "/")
    {
        return Err("API URL にはオリジンを指定してください");
    }
    let local = matches!(authority.host(), "127.0.0.1" | "[::1]" | "localhost");
    let (client_id, client_secret) = match (uri.scheme_str(), local) {
        (Some("http" | "https"), true) => ("local-runner".into(), "local-only".into()),
        (Some("https"), false) => {
            let secret = keychain::read_secret(&cfg.client_id)
                .map_err(|_| "Keychain の Taskfolio 認証情報を読み込めません")?;
            (cfg.client_id, secret)
        }
        _ => return Err("リモート API には HTTPS が必要です"),
    };
    Ok(HttpSender {
        url: cfg.api_url,
        client_id,
        client_secret,
        timeout: Duration::from_secs(30),
    })
}

fn api_error(e: SendError) -> &'static str {
    match e {
        SendError::Auth(_) => "API の認証に失敗しました",
        SendError::Server(_) => "API でサーバーエラーが発生しました",
        SendError::Network(_) => "API と通信できません",
        SendError::Rejected { .. } => "API がリクエストを拒否したか、応答形式が不正です",
    }
}

// A competing terminal decision (e.g. an expired claim) wins. Never start that turn.
fn report(sender: &HttpSender, status: &Report) -> Result<bool> {
    #[derive(Deserialize)]
    struct Ack {
        state: State,
    }
    let body = serde_json::to_string(status).map_err(|_| "状態をシリアライズできません")?;
    match sender.put::<Ack>("runner/result", &body) {
        Ok(ack) if ack.state == status.state => Ok(true),
        Ok(_) => Err("API の応答と送信した状態が一致しません"),
        Err(SendError::Rejected { status: 409, .. }) => Ok(false),
        Err(e) => Err(api_error(e)),
    }
}

fn command(settings: &Settings, job: &Job) -> Result<Command> {
    let project = settings
        .projects
        .get(&job.project)
        .ok_or("invalid_project")?;
    let executable = settings
        .executables
        .get(&job.engine)
        .ok_or("unsupported_engine")?;
    if job.title.trim().is_empty()
        || job.title.encode_utf16().count() > 200
        || job.title.contains('\0')
    {
        return Err("invalid_prompt");
    }
    let mut cmd = Command::new(executable);
    cmd.current_dir(project)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let codex = job.engine == "codex";
    if codex {
        cmd.args([
            "exec",
            "--sandbox",
            match settings.codex_sandbox {
                Sandbox::ReadOnly => "read-only",
                Sandbox::WorkspaceWrite => "workspace-write",
            },
        ]);
    } else {
        cmd.arg("-p");
    }
    if let Some(model) = &job.model {
        if model.len() > 256
            || !model.starts_with(|c: char| c.is_ascii_alphanumeric())
            || !model
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-[]/:".contains(&c))
        {
            return Err("invalid_model");
        }
        cmd.args(["--model", model]);
    }
    if let Some(effort) = job.effort.as_deref() {
        if !matches!(effort, "low" | "medium" | "high" | "xhigh" | "max")
            && !(codex && matches!(effort, "none" | "minimal" | "ultra"))
        {
            return Err("invalid_effort");
        }
        if codex {
            cmd.arg("-c")
                .arg(format!("model_reasoning_effort=\"{effort}\""));
        } else {
            cmd.args(["--effort", effort]);
        }
    }
    if codex {
        cmd.arg("-");
    }
    Ok(cmd)
}

fn execute(mut cmd: Command, prompt: &str) -> Result<()> {
    let mut child = cmd.spawn().map_err(|_| "provider_start_failed")?;
    // Dropping the pipe delivers EOF. Always reap the child even when stdin fails.
    let sent = child.stdin.take().unwrap().write_all(prompt.as_bytes());
    let status = child.wait().map_err(|_| "runner_interrupted")?;
    if sent.is_ok() && status.success() {
        Ok(())
    } else {
        Err("provider_failed")
    }
}

pub fn poll(home: &Path) -> Result<()> {
    let Some(_lock) =
        acquire_named_lock(home, "runner.lock").map_err(|_| "runner.lock を取得できません")?
    else {
        return Ok(());
    };
    let path = home.join("runner-journal.json");
    let previous = match fs::read(&path) {
        Ok(bytes) => Some(
            serde_json::from_slice::<Journal>(&bytes).map_err(|_| "ジャーナルが破損しています")?,
        ),
        Err(e) if e.kind() == ErrorKind::NotFound => None,
        Err(_) => return Err("ジャーナルを読み込めません"),
    };
    let clear = || fs::remove_file(&path).map_err(|_| "ジャーナルを削除できません");
    let prepared = match previous {
        Some(Journal::Report(saved)) => {
            report(&sender(home)?, &saved)?;
            return clear();
        }
        Some(Journal::Prepared(job)) => Some(job),
        None => None,
    };
    let settings = Settings::load(home)?;
    let sender = sender(home)?;
    let job = match prepared {
        Some(job) => job,
        None => {
            #[derive(Deserialize)]
            struct Claim {
                job: Option<Job>,
            }
            let body = serde_json::json!({
                "projects": settings.projects.keys().collect::<Vec<_>>(),
                "engines": settings.executables.keys().collect::<Vec<_>>(),
                "auto_queue": true,
            });
            let claim: Claim = sender
                .put("runner/claim", &body.to_string())
                .map_err(api_error)?;
            let Some(job) = claim.job else { return Ok(()) };
            checkpoint(&path, &Journal::Prepared(job.clone()))?;
            job
        }
    };

    let outcome = match command(&settings, &job) {
        Err(error) => Err(error),
        Ok(cmd) => {
            let running = Report {
                attempt_id: job.attempt_id.clone(),
                state: State::Running,
                error: None,
            };
            if !report(&sender, &running)? {
                return clear();
            }
            // Persist an ambiguous result before spawn. A crash on either side of
            // spawn must never start the same request again.
            checkpoint(
                &path,
                &Journal::Report(Report::failed(&job.attempt_id, "runner_interrupted")),
            )?;
            execute(cmd, &job.title)
        }
    };
    let result = match outcome {
        Ok(()) => Report {
            attempt_id: job.attempt_id,
            state: State::Completed,
            error: None,
        },
        Err(error) => Report::failed(&job.attempt_id, error),
    };
    checkpoint(&path, &Journal::Report(result.clone()))?;
    report(&sender, &result)?;
    clear()
}
