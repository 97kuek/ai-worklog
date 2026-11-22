use std::path::PathBuf;
use std::process::ExitCode;
use std::time::SystemTime;

use ai_worklog::app::output::{to_json, to_table};
use ai_worklog::app::scan::{scan, ScanOptions};

const USAGE: &str = "usage: ai-worklog <scan|--version>
  scan [--since-days N] [--gap-minutes N] [--format json|table] [--claude-dir PATH] [--codex-dir PATH]";

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
        _ => usage_error(),
    }
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
