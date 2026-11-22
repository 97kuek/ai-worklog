use std::path::PathBuf;
use std::process::{Command, ExitCode, Stdio};
use std::time::{Duration, SystemTime};

use ai_worklog::adapters::config::{self, Config};
use ai_worklog::adapters::http::HttpSender;
use ai_worklog::adapters::keychain;
use ai_worklog::adapters::namer::{ClaudeCliNamer, Namer};
use ai_worklog::app::collect::{acquire_lock, collect, CollectOptions};
use ai_worklog::app::payload::DEFAULT_CHUNK;
use ai_worklog::app::setup::{self, append_log_line};
use ai_worklog::app::state;

use ai_worklog::app::output::{to_json, to_table};
use ai_worklog::app::scan::{scan, ScanOptions};

const USAGE: &str = "usage: ai-worklog <scan|collect|login|setup|hook|doctor|--version>
  scan [--since-days N] [--gap-minutes N] [--format json|table] [--claude-dir PATH] [--codex-dir PATH]
  collect
  login --url API_URL --machine-name NAME --client-id ID [--expires YYYY-MM-DD]
  setup [--print-only]
  hook
  doctor";

const LOG_MAX_BYTES: u64 = 1024 * 1024;
const BIG_READ_WARN_BYTES: u64 = 500_000_000;

fn main() -> ExitCode {
    let mut parser = lexopt::Parser::from_env();
    match parser.next() {
        Ok(Some(lexopt::Arg::Long("version"))) => {
            println!("ai-worklog {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        Ok(Some(lexopt::Arg::Value(cmd))) if cmd == "scan" => match run_scan(parser) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("ai-worklog: {e}");
                usage_error()
            }
        },
        Ok(Some(lexopt::Arg::Value(cmd))) if cmd == "collect" => {
            if parser.next().ok().flatten().is_some() {
                return usage_error();
            }
            run_collect()
        }
        Ok(Some(lexopt::Arg::Value(cmd))) if cmd == "login" => match run_login(parser) {
            Ok(code) => code,
            Err(e) => {
                eprintln!("ai-worklog: {e}");
                usage_error()
            }
        },
        Ok(Some(lexopt::Arg::Value(cmd))) if cmd == "setup" => match run_setup(parser) {
            Ok(code) => code,
            Err(e) => {
                eprintln!("ai-worklog: {e}");
                usage_error()
            }
        },
        Ok(Some(lexopt::Arg::Value(cmd))) if cmd == "hook" => run_hook(),
        Ok(Some(lexopt::Arg::Value(cmd))) if cmd == "doctor" => run_doctor(),
        _ => usage_error(),
    }
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn user_home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default()
}

fn run_collect() -> ExitCode {
    let home = config::home_dir();
    let cfg = match config::load(&home.join("config.json")) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("ai-worklog: {e}");
            eprintln!("ai-worklog: run `ai-worklog login --url <API_URL> --machine-name <NAME> --client-id <ID>` first");
            return ExitCode::from(2);
        }
    };
    let _lock = match acquire_lock(&home) {
        Ok(Some(l)) => l,
        Ok(None) => return ExitCode::SUCCESS, // 別の collect が動いている
        Err(e) => {
            eprintln!("ai-worklog: cannot take lock in {}: {e}", home.display());
            return ExitCode::FAILURE;
        }
    };
    let secret = match keychain::read_secret(&cfg.client_id) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("ai-worklog: {e}");
            return ExitCode::FAILURE;
        }
    };
    let state_path = home.join("state.json");
    let mut state = state::load(&state_path);
    let first_run = state.files.is_empty() && state.sessions.is_empty();
    let sender = HttpSender {
        url: cfg.api_url.clone(),
        client_id: cfg.client_id.clone(),
        client_secret: secret,
        timeout: Duration::from_secs(30),
    };
    let namer = ClaudeCliNamer {
        command: cfg.naming.command.clone(),
        model: cfg.naming.model.clone(),
        cwd: home.join("naming"),
        timeout: Duration::from_secs(60),
    };
    let user = user_home();
    let opts = CollectOptions {
        claude_projects_dir: user.join(".claude/projects"),
        codex_dir: user.join(".codex"),
        machine_name: cfg.machine_name.clone(),
        gap_minutes: cfg.gap_minutes,
        now: now_ms(),
        naming: cfg.naming.enabled.then_some((&namer as &dyn Namer, cfg.naming.min_user_messages, cfg.naming.max_per_run)),
        chunk: DEFAULT_CHUNK,
    };
    let report = collect(&opts, &mut state, &sender);
    if let Err(e) = state::save(&state_path, &state) {
        eprintln!("ai-worklog: cannot save state {}: {e}", state_path.display());
    }

    let log_path = home.join("logs").join("collect.log");
    let mut line = serde_json::to_value(&report).unwrap_or_default();
    line["at"] = opts.now.into();
    let log = |l: &str| {
        if let Err(e) = append_log_line(&log_path, l, LOG_MAX_BYTES) {
            eprintln!("ai-worklog: cannot write {}: {e}", log_path.display());
        }
    };
    log(&line.to_string());
    if report.bytes_read > BIG_READ_WARN_BYTES && !first_run {
        let w = format!("read {} bytes in one run; state may have been reset", report.bytes_read);
        log(&serde_json::json!({ "at": opts.now, "warning": w }).to_string());
        eprintln!("ai-worklog: warning: {w}");
    }
    println!("{line}");
    if report.auth_failed { ExitCode::FAILURE } else { ExitCode::SUCCESS }
}

fn run_login(mut parser: lexopt::Parser) -> Result<ExitCode, lexopt::Error> {
    use lexopt::prelude::*;
    let (mut url, mut machine, mut client_id, mut expires) = (None, None, None, None);
    while let Some(arg) = parser.next()? {
        match arg {
            Long("url") => url = Some(parser.value()?.string()?),
            Long("machine-name") => machine = Some(parser.value()?.string()?),
            Long("client-id") => client_id = Some(parser.value()?.string()?),
            Long("expires") => expires = Some(parser.value()?.string()?),
            _ => return Err(arg.unexpected()),
        }
    }
    let url = url.ok_or("missing --url")?;
    let machine_name = machine.ok_or("missing --machine-name")?;
    let client_id = client_id.ok_or("missing --client-id")?;
    if let Some(e) = &expires {
        if e.len() != 10 || e.parse::<jiff::civil::Date>().is_err() {
            return Err(format!("--expires must be YYYY-MM-DD, got `{e}`").into());
        }
    }
    let path = config::home_dir().join("config.json");
    // 既存の naming / gap_minutes の設定は引き継ぐ
    let prev = config::load(&path).ok();
    let cfg = Config {
        api_url: url,
        machine_name,
        client_id: client_id.clone(),
        token_expires_on: expires.or_else(|| prev.as_ref().and_then(|p| p.token_expires_on.clone())),
        naming: prev.as_ref().map(|p| p.naming.clone()).unwrap_or_default(),
        gap_minutes: prev.as_ref().map_or(30, |p| p.gap_minutes),
    };
    if let Err(e) = config::save(&path, &cfg) {
        eprintln!("ai-worklog: cannot write {}: {e}", path.display());
        return Ok(ExitCode::FAILURE);
    }
    println!("wrote {}", path.display());
    println!("Enter the Client Secret when the Keychain prompt asks for it (it is not echoed or stored anywhere else).");
    match keychain::store_secret_interactive(&client_id) {
        Ok(()) => {
            println!("stored the Client Secret in the Keychain (service {}, account {client_id})", keychain::SERVICE);
            Ok(ExitCode::SUCCESS)
        }
        Err(e) => {
            eprintln!("ai-worklog: {e}");
            Ok(ExitCode::FAILURE)
        }
    }
}

fn run_setup(mut parser: lexopt::Parser) -> Result<ExitCode, lexopt::Error> {
    use lexopt::prelude::*;
    let mut print_only = false;
    while let Some(arg) = parser.next()? {
        match arg {
            Long("print-only") => print_only = true,
            _ => return Err(arg.unexpected()),
        }
    }
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("ai-worklog: cannot find own path: {e}");
            return Ok(ExitCode::FAILURE);
        }
    };
    let home = config::home_dir();
    let plist = setup::launch_agent_plist(&exe, &home);
    let plist_path = setup::launch_agents_dir().join(format!("{}.plist", setup::LAUNCH_LABEL));
    if print_only {
        println!("# {}\n{plist}", plist_path.display());
    } else {
        let loaded = (|| -> Result<(), String> {
            std::fs::create_dir_all(home.join("logs")).map_err(|e| format!("cannot create logs dir: {e}"))?;
            let dir = plist_path.parent().ok_or("bad plist path")?;
            std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
            std::fs::write(&plist_path, &plist).map_err(|e| format!("cannot write {}: {e}", plist_path.display()))?;
            let uid = setup::current_uid().ok_or("cannot get uid from `id -u`")?;
            let domain = format!("gui/{uid}");
            let launchctl = setup::launchctl_cmd();
            // 読み込み済みなら入れ替えるため、先に外す（なくても失敗を無視する）
            let _ = Command::new(&launchctl)
                .args(["bootout", &format!("{domain}/{}", setup::LAUNCH_LABEL)])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            let st = Command::new(&launchctl)
                .args(["bootstrap", &domain])
                .arg(&plist_path)
                .stdin(Stdio::null())
                .status()
                .map_err(|e| format!("cannot run launchctl: {e}"))?;
            if st.success() { Ok(()) } else { Err(format!("launchctl bootstrap exited with {st}")) }
        })();
        match loaded {
            Ok(()) => println!("installed and loaded {}", plist_path.display()),
            Err(e) => {
                eprintln!("ai-worklog: {e}");
                return Ok(ExitCode::FAILURE);
            }
        }
    }
    println!();
    println!("Add this to \"hooks\" in ~/.claude/settings.json (not edited by ai-worklog):");
    println!("{}", setup::claude_hook_snippet(&exe));
    println!();
    println!("Add this to ~/.codex/hooks.json (not edited by ai-worklog; format per https://developers.openai.com/codex/hooks):");
    println!("{}", setup::codex_hook_snippet(&exe));
    Ok(ExitCode::SUCCESS)
}

/// SessionEnd から呼ばれる。待たず、標準入力も読まず、何があっても0で終わる
fn run_hook() -> ExitCode {
    if let Some(uid) = setup::current_uid() {
        let _ = Command::new(setup::launchctl_cmd())
            .args(["kickstart", &format!("gui/{uid}/{}", setup::LAUNCH_LABEL)])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }
    ExitCode::SUCCESS
}

fn run_doctor() -> ExitCode {
    let home = config::home_dir();
    let user = user_home();
    let exe = std::env::current_exe().unwrap_or_default();
    let items = setup::doctor(&home, &user.join(".claude/settings.json"), &user.join(".codex/hooks.json"), &exe, now_ms());
    let mut failed = false;
    for i in &items {
        println!("{:<2} {:<16} {}", if i.ok { "OK" } else { "NG" }, i.name, i.detail);
        failed |= !i.ok;
    }
    if failed { ExitCode::FAILURE } else { ExitCode::SUCCESS }
}

fn run_scan(mut parser: lexopt::Parser) -> Result<(), lexopt::Error> {
    use lexopt::prelude::*;

    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let mut opts = ScanOptions {
        claude_projects_dir: home.join(".claude/projects"),
        codex_dir: home.join(".codex"),
        since_days: 7,
        gap_minutes: 30,
        now: SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
    };
    let mut table = false;
    while let Some(arg) = parser.next()? {
        match arg {
            Long("since-days") => opts.since_days = parser.value()?.parse()?,
            Long("gap-minutes") => opts.gap_minutes = parser.value()?.parse()?,
            Long("claude-dir") => opts.claude_projects_dir = parser.value()?.into(),
            Long("codex-dir") => opts.codex_dir = parser.value()?.into(),
            Long("format") => {
                table = match parser.value()?.string()?.as_str() {
                    "json" => false,
                    "table" => true,
                    other => return Err(format!("unknown format: {other}").into()),
                }
            }
            _ => return Err(arg.unexpected()),
        }
    }

    let sessions = scan(&opts);
    if table {
        print!("{}", to_table(&sessions, &jiff::tz::TimeZone::system()));
    } else {
        println!("{}", to_json(&sessions));
    }
    Ok(())
}

fn usage_error() -> ExitCode {
    eprintln!("{USAGE}");
    ExitCode::from(2)
}
