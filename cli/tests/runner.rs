use serde_json::{Value, json};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Command, Output};
use std::thread;
use std::time::{Duration, Instant};

fn home(tag: &str) -> std::path::PathBuf {
    let home = std::env::temp_dir().join(format!("taskfolio-runner-{tag}-{}", std::process::id()));
    fs::create_dir(&home).unwrap();
    let project = home.join("mapped project");
    fs::create_dir(&project).unwrap();
    let executable = home.join("executable");
    fs::write(
        &executable,
        r#"#!/bin/sh
echo start >> calls
printf '%s\n' "$@" > args
cat > prompt
echo private-output
echo private-error >&2
test ! -f should-fail
"#,
    )
    .unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(home.join("runner.json"), json!({
        "projects":{"demo": project}, "executables":{"codex": executable, "claude_code": executable}
    }).to_string()).unwrap();
    home
}

fn run(home: &Path) -> Output {
    let out = Command::new(env!("CARGO_BIN_EXE_taskfolio"))
        .arg("runner")
        .env("TASKFOLIO_HOME", home)
        .output()
        .unwrap();
    assert!(out.stdout.is_empty());
    let stderr = String::from_utf8_lossy(&out.stderr);
    for private in ["private-output", "private-error", "private request"] {
        assert!(!stderr.contains(private));
    }
    out
}

fn job(engine: &str) -> Value {
    json!({"job":{
        "attempt_id":"ac8e5775-86b9-41bd-a963-456f946fa856", "request_id":"1d2d04c3-3ddf-4d52-a241-aeba900aa90c",
        "project":"demo","engine":engine,"title":"private request $(touch unwanted)","model":"model-1","effort":"high"
    }})
}

fn serve(home: &Path, responses: Vec<(u16, Value)>) -> thread::JoinHandle<Vec<(String, Value)>> {
    let socket = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    socket.set_nonblocking(true).unwrap();
    fs::write(
        home.join("config.json"),
        json!({
            "api_url": format!("http://{}", socket.local_addr().unwrap()),
            "machine_name":"fixture","client_id":"unused"
        })
        .to_string(),
    )
    .unwrap();
    thread::spawn(move || {
        let mut calls = Vec::new();
        for (status, response) in responses {
            let deadline = Instant::now() + Duration::from_secs(8);
            let mut stream = loop {
                match socket.accept() {
                    Ok((stream, _)) => break stream,
                    Err(e)
                        if e.kind() == std::io::ErrorKind::WouldBlock
                            && Instant::now() < deadline =>
                    {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Err(e) => panic!("missing request: {e}"),
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut reader = BufReader::new(&stream);
            let mut first = String::new();
            reader.read_line(&mut first).unwrap();
            assert!(first.starts_with("PUT /api/runner/"));
            let mut lines = Vec::new();
            loop {
                let mut line = String::new();
                assert_ne!(reader.read_line(&mut line).unwrap(), 0);
                if line == "\r\n" {
                    break;
                }
                lines.push(line.trim().to_ascii_lowercase());
            }
            assert!(lines.contains(&"cf-access-client-id: local-runner".to_string()));
            assert!(lines.contains(&"cf-access-client-secret: local-only".to_string()));
            let length = lines
                .iter()
                .find_map(|l| l.strip_prefix("content-length: "))
                .unwrap()
                .parse()
                .unwrap();
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            let path = first.split_whitespace().nth(1).unwrap().to_string();
            calls.push((path, serde_json::from_slice(&body).unwrap()));
            let body = response.to_string();
            write!(stream,"HTTP/1.1 {status} Reply\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",body.len()).unwrap();
        }
        calls
    })
}

#[test]
fn retries_only_delivery_after_provider_exit() {
    let dir = home("delivery");
    let project = dir.join("mapped project");
    let api = serve(
        &dir,
        vec![
            (200, job("codex")),
            (200, json!({"state":"running"})),
            (503, json!({})),
        ],
    );
    assert!(!run(&dir).status.success());
    let calls = api.join().unwrap();
    assert_eq!(
        calls[0],
        (
            "/api/runner/claim".into(),
            json!({"engines":["claude_code","codex"],"projects":["demo"]})
        )
    );
    assert_eq!(calls[1].1["state"], "running");
    assert_eq!(calls[2].1["state"], "completed");
    assert_eq!(
        fs::read_to_string(project.join("args")).unwrap(),
        "exec\n--sandbox\nread-only\n--model\nmodel-1\n-c\nmodel_reasoning_effort=\"high\"\n-\n"
    );
    assert_eq!(
        fs::read_to_string(project.join("prompt")).unwrap(),
        "private request $(touch unwanted)"
    );
    assert!(!project.join("unwanted").exists());
    let journal = dir.join("runner-journal.json");
    assert_eq!(
        fs::metadata(&journal).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert!(
        !fs::read_to_string(&journal)
            .unwrap()
            .contains("private request")
    );
    let api = serve(&dir, vec![(200, json!({"state":"completed"}))]);
    assert!(run(&dir).status.success());
    assert_eq!(api.join().unwrap(), [calls[2].clone()]);
    assert!(!journal.exists());
    assert_eq!(
        fs::read_to_string(project.join("calls")).unwrap(),
        "start\n"
    );
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn resumes_an_unstarted_claim_and_reports_the_actual_claude_exit() {
    let dir = home("prepared");
    let mut claim = job("claude_code");
    claim["job"]["model"] = "provider:region/model-1".into();
    let api = serve(&dir, vec![(200, claim), (503, json!({}))]);
    assert!(!run(&dir).status.success());
    api.join().unwrap();
    let project = dir.join("mapped project");
    assert!(!project.join("calls").exists());
    fs::write(project.join("should-fail"), "").unwrap();
    let api = serve(
        &dir,
        vec![
            (200, json!({"state":"running"})),
            (200, json!({"state":"failed"})),
        ],
    );
    assert!(run(&dir).status.success());
    let calls = api.join().unwrap();
    assert_eq!(calls[0].1["state"], "running");
    assert_eq!(calls[1].1["error"], "provider_failed");
    assert_eq!(
        fs::read_to_string(project.join("args")).unwrap(),
        "-p\n--model\nprovider:region/model-1\n--effort\nhigh\n"
    );
    assert_eq!(
        fs::read_to_string(project.join("calls")).unwrap(),
        "start\n"
    );
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn refused_authorization_and_invalid_arguments_never_spawn() {
    let dir = home("invalid");
    let api = serve(
        &dir,
        vec![
            (200, job("codex")),
            (409, json!({"error":"result_conflict"})),
        ],
    );
    assert!(run(&dir).status.success());
    api.join().unwrap();
    for (key, value, error) in [
        (
            "model",
            "--dangerously-bypass-approvals-and-sandbox",
            "invalid_model",
        ),
        ("effort", "unrecognized", "invalid_effort"),
        ("project", "/some/remote/project", "invalid_project"),
        ("engine", "/bin/sh", "unsupported_engine"),
        ("title", "", "invalid_prompt"),
    ] {
        let mut claim = job("codex");
        claim["job"][key] = value.into();
        let api = serve(&dir, vec![(200, claim), (200, json!({"state":"failed"}))]);
        assert!(run(&dir).status.success());
        let calls = api.join().unwrap();
        assert_eq!(calls[1].1["error"], error);
    }
    assert!(!dir.join("mapped project/calls").exists());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn overlapping_polls_and_crash_recovery_do_not_start_a_second_provider() {
    let dir = home("interrupted");
    let project = dir.join("mapped project");
    fs::write(
        dir.join("executable"),
        "#!/bin/sh\ncat >/dev/null\necho start >> calls\nsleep 2\n",
    )
    .unwrap();
    let api = serve(
        &dir,
        vec![(200, job("codex")), (200, json!({"state":"running"}))],
    );
    let mut process = Command::new(env!("CARGO_BIN_EXE_taskfolio"))
        .arg("runner")
        .env("TASKFOLIO_HOME", &dir)
        .spawn()
        .unwrap();
    api.join().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !project.join("calls").exists() {
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(5));
    }
    // The other runner sees the OS lock without claiming or replaying anything.
    assert!(run(&dir).status.success());
    process.kill().unwrap();
    process.wait().unwrap();
    let api = serve(&dir, vec![(200, json!({"state":"failed"}))]);
    assert!(run(&dir).status.success());
    let calls = api.join().unwrap();
    assert_eq!(calls[0].0, "/api/runner/result");
    assert_eq!(calls[0].1["error"], "runner_interrupted");
    assert_eq!(
        fs::read_to_string(project.join("calls")).unwrap(),
        "start\n"
    );
    assert!(!dir.join("runner-journal.json").exists());
    fs::remove_dir_all(dir).unwrap();
}
