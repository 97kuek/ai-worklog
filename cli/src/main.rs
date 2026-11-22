use std::path::PathBuf;
use std::process::{Command, ExitCode, Stdio};
use std::time::{Duration, SystemTime};

use taskfolio::adapters::config::{self, Config};
use taskfolio::adapters::fsutil;
use taskfolio::adapters::http::HttpSender;
use taskfolio::adapters::{keychain, status_hook};
use taskfolio::domain::Tool;
use taskfolio::adapters::namer::{ClaudeCliNamer, Namer};
use taskfolio::app::collect::{acquire_lock, collect_and_save, CollectOptions, SaveOptions};
use taskfolio::app::payload::DEFAULT_CHUNK;
use taskfolio::app::setup::{self, append_log_line};

use taskfolio::app::output::{to_json, to_table};
use taskfolio::app::scan::{scan, ScanOptions};

const USAGE: &str = "usage: taskfolio <scan|skills|collect|runner|login|setup|hook|hook-status|doctor|--version>
  scan [--since-days N] [--gap-minutes N] [--format json|table] [--claude-dir PATH] [--codex-dir PATH]
  skills [--cwd PATH]
  collect [--rescan]
  runner
  login --url API_URL --machine-name NAME --client-id ID [--expires YYYY-MM-DD]
  setup [--print-only]
  hook
  hook-status <claude|codex>
  doctor";

const LOG_MAX_BYTES: u64 = 1024 * 1024;
const BIG_READ_WARN_BYTES: u64 = 500_000_000;

fn main() -> ExitCode {
    let mut parser = lexopt::Parser::from_env();
    match parser.next() {
        Ok(Some(lexopt::Arg::Long("version"))) => {
            println!("taskfolio {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        Ok(Some(lexopt::Arg::Value(cmd))) if cmd == "scan" => match run_scan(parser) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("taskfolio: {e}");
                usage_error()
            }
        },
        Ok(Some(lexopt::Arg::Value(cmd))) if cmd == "skills" => {
            let cwd = match parser.next() {
                Ok(None) => config::load(&config::home_dir().join("config.json")).ok()
                    .and_then(|cfg| cfg.skills_cwd).unwrap_or_else(user_home),
                Ok(Some(lexopt::Arg::Long("cwd"))) => match parser.value() {
                    Ok(value) if matches!(parser.next(), Ok(None)) => PathBuf::from(value),
                    _ => return usage_error(),
                },
                _ => return usage_error(),
            };
            let mut skills = Vec::new();
            for (tool, name) in taskfolio::adapters::skills::TOOLS {
                match taskfolio::adapters::skills::discover(tool, &cwd) {
                    Ok(rows) => skills.extend(rows),
                    Err(reason) => {
                        eprintln!("taskfolio: {name} skills: {reason}");
                        return ExitCode::FAILURE;
                    }
                }
            }
            println!("{}", serde_json::json!({"skills":skills}));
            ExitCode::SUCCESS
        }
        Ok(Some(lexopt::Arg::Value(cmd))) if cmd == "collect" => {
            let rescan = match parser.next() {
                Ok(None) => false,
                Ok(Some(lexopt::Arg::Long("rescan"))) => {
                    if !matches!(parser.next(), Ok(None)) { return usage_error(); }
                    true
                }
                _ => return usage_error(),
            };
            run_collect(rescan)
        }
        Ok(Some(lexopt::Arg::Value(cmd))) if cmd == "runner" => {
            if !matches!(parser.next(), Ok(None)) { return usage_error(); }
            match taskfolio::app::runner::poll(&config::home_dir()) {
                Ok(()) => ExitCode::SUCCESS,
                Err(e) => {
                    eprintln!("taskfolio: runner: {e}");
                    ExitCode::FAILURE
                }
            }
        }
        Ok(Some(lexopt::Arg::Value(cmd))) if cmd == "login" => match run_login(parser) {
            Ok(code) => code,
            Err(e) => {
                eprintln!("taskfolio: {e}");
                usage_error()
            }
        },
        Ok(Some(lexopt::Arg::Value(cmd))) if cmd == "setup" => match run_setup(parser) {
            Ok(code) => code,
            Err(e) => {
                eprintln!("taskfolio: {e}");
                usage_error()
            }
        },
        Ok(Some(lexopt::Arg::Value(cmd))) if cmd == "hook" => run_hook(),
        Ok(Some(lexopt::Arg::Value(cmd))) if cmd == "hook-status" => {
            let tool = match parser.next() {
                Ok(Some(lexopt::Arg::Value(name))) if name == "claude" => Tool::ClaudeCode,
                Ok(Some(lexopt::Arg::Value(name))) if name == "codex" => Tool::Codex,
                _ => return usage_error(),
            };
            if !matches!(parser.next(), Ok(None)) { return usage_error(); }
            // Observing a session must never affect the tool's approval or control flow.
            if status_hook::record(&config::home_dir(), tool, std::io::stdin().lock()).is_err() {
                eprintln!("taskfolio: could not record hook status");
            }
            ExitCode::SUCCESS
        }
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

fn run_collect(rescan: bool) -> ExitCode {
    let home = config::home_dir();
    let cfg = match config::load(&home.join("config.json")) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("taskfolio: {e}");
            eprintln!("taskfolio: run `taskfolio login --url <API_URL> --machine-name <NAME> --client-id <ID>` first");
            return ExitCode::from(2);
        }
    };
    let _lock = match acquire_lock(&home) {
        Ok(Some(l)) => l,
        Ok(None) => {
            eprintln!("taskfolio: another collect is running");
            return if rescan { ExitCode::FAILURE } else { ExitCode::SUCCESS };
        }
        Err(e) => {
            eprintln!("taskfolio: cannot take lock in {}: {e}", home.display());
            return ExitCode::FAILURE;
        }
    };
    let secret = match keychain::read_secret(&cfg.client_id) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("taskfolio: {e}");
            return ExitCode::FAILURE;
        }
    };
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
        rescan,
        claude_projects_dir: user.join(".claude/projects"),
        codex_dir: user.join(".codex"),
        machine_name: cfg.machine_name.clone(),
        gap_minutes: cfg.gap_minutes,
        now: now_ms(),
        naming: cfg.naming.enabled.then_some((&namer as &dyn Namer, cfg.naming.min_user_messages, cfg.naming.max_per_run)),
        chunk: DEFAULT_CHUNK,
    };
    let save = SaveOptions {
        home: &home,
        token_expires_on: cfg.token_expires_on.as_deref(),
        big_read_warn_bytes: BIG_READ_WARN_BYTES,
    };
    let mut report = collect_and_save(&opts, &save, &sender);
    let skills_cwd = cfg.skills_cwd.as_deref().unwrap_or(&user);
    taskfolio::app::skills::sync(&home, skills_cwd, opts.now, &sender, &mut report);

    let log_path = home.join("logs").join("collect.log");
    let mut line = serde_json::to_value(&report).unwrap_or_default();
    line["at"] = opts.now.into();
    let log = |l: &str| {
        if let Err(e) = append_log_line(&log_path, l, LOG_MAX_BYTES) {
            eprintln!("taskfolio: cannot write {}: {e}", log_path.display());
        }
    };
    log(&line.to_string());
    for w in report.errors.iter().filter(|e| e.starts_with("warning: ")) {
        eprintln!("taskfolio: {w}");
    }
    println!("{line}");
    if report.auth_failed || (rescan && report.errors.iter().any(|e| !e.starts_with("warning: "))) {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
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
    if let Some(e) = &expires
        && (e.len() != 10 || e.parse::<jiff::civil::Date>().is_err())
    {
        return Err(format!("--expires must be YYYY-MM-DD, got `{e}`").into());
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
        skills_cwd: prev.and_then(|p| p.skills_cwd),
    };
    if let Err(e) = config::save(&path, &cfg) {
        eprintln!("taskfolio: cannot write {}: {e}", path.display());
        return Ok(ExitCode::FAILURE);
    }
    println!("wrote {}", path.display());
    println!("Enter the Client Secret when the Keychain prompt asks for it (it is not echoed or stored anywhere else).");
    match keychain::store_secret_interactive(&client_id) {
        Ok(()) => {
            println!("stored the Client Secret in the Keychain (service {})", keychain::SERVICE);
            Ok(ExitCode::SUCCESS)
        }
        Err(e) => {
            eprintln!("taskfolio: {e}");
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
            eprintln!("taskfolio: cannot find own path: {e}");
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
            fsutil::create_private_dir(&home.join("logs")).map_err(|e| format!("cannot create logs dir: {e}"))?;
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
                eprintln!("taskfolio: {e}");
                return Ok(ExitCode::FAILURE);
            }
        }
    }
    println!();
    println!("Merge the following hook entries into ~/.claude/settings.json:");
    println!("{}", setup::claude_hook_snippet(&exe));
    println!();
    println!("Merge these entries into ~/.codex/hooks.json, then review them in /hooks or Settings > Hooks:");
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
