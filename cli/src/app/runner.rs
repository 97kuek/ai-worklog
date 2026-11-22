//! Poll once, finish one initial turn and report its exit status.
use std::fs::{self, File};
use std::io::{ErrorKind, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use super::collect::acquire_named_lock;
use super::runner_settings::{Sandbox, Settings};
use crate::adapters::http::{HttpSender, SendError};
use crate::adapters::{config, fsutil, keychain};
use serde::{Deserialize, Serialize};

type Result<T> = std::result::Result<T, &'static str>;

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

fn sender(cfg: &config::Config) -> Result<HttpSender> {
    let uri = config::api_endpoint(&cfg.api_url)?;
    let authority = uri.authority().ok_or("API URL にホストが必要です")?;
    if !matches!(uri.path(), "" | "/") {
        return Err("API URL にはオリジンを指定してください");
    }
    let local = matches!(authority.host(), "127.0.0.1" | "[::1]" | "localhost");
    let (client_id, client_secret) = match (uri.scheme_str(), local) {
        (Some("http" | "https"), true) => ("local-runner".into(), "local-only".into()),
        (Some("https"), false) => {
            let secret = keychain::read_secret(&cfg.client_id)
                .map_err(|_| "Keychain の Taskfolio 認証情報を読み込めません")?;
            (cfg.client_id.clone(), secret)
        }
        _ => return Err("リモート API には HTTPS が必要です"),
    };
    Ok(HttpSender {
        url: cfg.api_url.clone(),
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
            match settings.codex_sandbox.unwrap_or_default() {
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
    let cfg =
        config::load(&home.join("config.json")).map_err(|_| "config.json を読み込めません")?;
    let sender = sender(&cfg)?;
    let prepared = match previous {
        Some(Journal::Report(saved)) => {
            report(&sender, &saved)?;
            return clear();
        }
        Some(Journal::Prepared(job)) => Some(job),
        None => None,
    };
    let settings = Settings::available(home)?;
    let job = match prepared {
        Some(job) => job,
        None => {
            #[derive(Deserialize)]
            struct Claim {
                job: Option<Job>,
            }
            let mut body = serde_json::json!({
                "projects": settings.projects.keys().collect::<Vec<_>>(),
                "engines": settings.executables.keys().collect::<Vec<_>>(),
                "auto_queue": true,
            });
            let name = cfg.machine_name.trim();
            if !name.is_empty() && name.encode_utf16().count() <= 100 {
                body["machine_name"] = name.into();
            }
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
            let (done, stopped) = std::sync::mpsc::channel::<()>();
            std::thread::scope(|scope| {
                let sender = &sender;
                let running = &running;
                scope.spawn(move || {
                    while stopped.recv_timeout(Duration::from_secs(30)) == Err(std::sync::mpsc::RecvTimeoutError::Timeout) {
                        // A failed check-in never restarts a running provider. The terminal report is journaled below.
                        let _ = report(sender, running);
                    }
                });
                let outcome = execute(cmd, &job.title);
                drop(done);
                outcome
            })
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
