use std::process::ExitCode;

const USAGE: &str = "usage: ai-worklog <scan|--version>";

fn main() -> ExitCode {
    let mut parser = lexopt::Parser::from_env();
    match parser.next() {
        Ok(Some(lexopt::Arg::Long("version"))) => {
            println!("ai-worklog {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        _ => usage_error(),
    }
}

fn usage_error() -> ExitCode {
    eprintln!("{USAGE}");
    ExitCode::from(2)
}
