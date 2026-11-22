//! Read each tool's own inventory. The control calls do not start a model turn.
use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use crate::domain::Tool;
use serde::Serialize;
use serde_json::{Value, json};

#[derive(Debug, PartialEq, Serialize)]
pub struct Skill {
    pub tool: Tool,
    pub name: String,
    pub description: String,
}

type Result<T> = std::result::Result<T, &'static str>;

const INVALID: &str = "invalid skill inventory response";
const LIMIT: u64 = 16 * 1024 * 1024;

pub fn discover(tool: Tool, cwd: &Path, claude_dir: Option<&Path>) -> Result<Vec<Skill>> {
    let cwd = cwd
        .canonicalize()
        .map_err(|_| "inventory working directory unavailable")?;
    let mut cmd = match tool {
        Tool::ClaudeCode => {
            let mut cmd = Command::new("claude");
            if let Some(dir) = claude_dir {
                // Never launch Claude against a vanished directory and upload an empty replacement.
                if !dir.is_dir() {
                    return Err("Claude profile directory unavailable");
                }
                if super::config::is_default_claude_profile(dir) {
                    cmd.env_remove("CLAUDE_CONFIG_DIR");
                } else {
                    cmd.env("CLAUDE_CONFIG_DIR", dir);
                }
            }
            cmd.args([
                "-p",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--verbose",
                "--no-session-persistence",
                "--tools",
                "",
                "--strict-mcp-config",
                "--mcp-config",
                r#"{"mcpServers":{}}"#,
                "--settings",
                r#"{"disableAllHooks":true}"#,
            ]);
            cmd
        }
        Tool::Codex => {
            let mut cmd = Command::new("codex");
            cmd.arg("app-server");
            cmd
        }
    };
    let mut child = cmd
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "could not start inventory command")?;
    let mut stream = Protocol {
        input: child.stdin.take().unwrap(),
        output: BufReader::new(child.stdout.take().unwrap()),
    };
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let rows = match tool {
            Tool::ClaudeCode => stream.claude(),
            Tool::Codex => stream.codex(&cwd),
        };
        drop(stream); // EOF lets both CLIs unregister the short-lived process.
        let _ = tx.send(rows.and_then(|v| parse_skills(tool, &v)));
    });
    let result = rx.recv_timeout(Duration::from_secs(20));
    if result.is_ok() {
        for _ in 0..10 {
            if child.try_wait().ok().flatten().is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }
    if !matches!(child.try_wait(), Ok(Some(_))) {
        let _ = child.kill();
    }
    let _ = child.wait();
    result.map_err(|_| "inventory command did not finish")?
}

struct Protocol {
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

impl Protocol {
    fn send(&mut self, request: Value) -> Result<()> {
        writeln!(self.input, "{request}").map_err(|_| "inventory command closed its input")
    }

    fn response(&mut self, matches: impl Fn(&Value) -> bool) -> Result<Value> {
        let mut line = Vec::new();
        loop {
            line.clear();
            let n = self
                .output
                .by_ref()
                .take(LIMIT + 1)
                .read_until(b'\n', &mut line)
                .map_err(|_| "cannot read inventory command output")?;
            if n == 0 {
                return Err("inventory command exited before responding");
            }
            if n as u64 > LIMIT {
                return Err("inventory response too large");
            }
            let msg: Value = serde_json::from_slice(&line).map_err(|_| INVALID)?;
            if matches(&msg) {
                return Ok(msg);
            }
        }
    }

    fn claude(&mut self) -> Result<Value> {
        self.claude_request("init", "initialize")?;
        Ok(self.claude_request("skills", "get_skills_dialog")?["skills"].take())
    }

    fn claude_request(&mut self, id: &str, subtype: &str) -> Result<Value> {
        self.send(json!({"type":"control_request","request_id":id,"request":{"subtype":subtype}}))?;
        let mut msg = self
            .response(|m| m["type"] == "control_response" && m["response"]["request_id"] == id)?;
        if msg["response"]["subtype"] != "success" {
            return Err("Claude Code inventory request failed");
        }
        Ok(msg["response"]["response"].take())
    }

    fn codex_request(&mut self, id: u64, method: &str, params: Value) -> Result<Value> {
        self.send(json!({"id":id, "method":method, "params":params}))?;
        let mut msg = self.response(|m| m["id"].as_u64() == Some(id))?;
        msg.get_mut("result")
            .map(Value::take)
            .ok_or("Codex app-server inventory request failed")
    }

    fn codex(&mut self, cwd: &Path) -> Result<Value> {
        self.codex_request(
            1,
            "initialize",
            json!({"clientInfo":{"name":"taskfolio","version":env!("CARGO_PKG_VERSION")}}),
        )?;
        self.send(json!({"method":"initialized","params":{}}))?;
        // skills/list alone can omit all installed remote plugins on a fresh app-server.
        let installed = self.codex_request(2, "plugin/installed", json!({"cwds":[cwd]}))?;
        if !installed["marketplaces"].is_array() {
            return Err(INVALID);
        }
        if installed
            .get("marketplaceLoadErrors")
            .is_some_and(|errors| errors.as_array().is_none_or(|e| !e.is_empty()))
        {
            return Err("Codex could not load all installed plugin marketplaces");
        }
        let expected = self.remote_skill_names(&installed)?;
        // The server loads remote plugins asynchronously. Until then skills/list can
        // successfully return only local entries, including with forceReload enabled.
        for attempt in 0..12 {
            if attempt > 0 {
                std::thread::sleep(Duration::from_millis(400));
            }
            let mut list =
                self.codex_request(3, "skills/list", json!({"cwds":[cwd], "forceReload":true}))?;
            let entries = list["data"].as_array_mut().ok_or(INVALID)?;
            let [entry] = entries.as_mut_slice() else {
                return Err(INVALID);
            };
            if !entry["errors"].as_array().ok_or(INVALID)?.is_empty() {
                return Err("Codex could not load all skill sources");
            }
            let rows = entry["skills"].as_array().ok_or(INVALID)?;
            let names: BTreeSet<_> = rows.iter().filter_map(|r| r["name"].as_str()).collect();
            if expected.iter().all(|name| names.contains(name.as_str())) {
                // Only this view applies local per-skill disable settings.
                return Ok(entry["skills"].take());
            }
        }
        Err("Codex has not loaded all installed remote skills")
    }

    fn remote_skill_names(&mut self, installed: &Value) -> Result<BTreeSet<String>> {
        let mut pending = BTreeMap::new();
        for market in installed["marketplaces"].as_array().ok_or(INVALID)? {
            for plugin in market["plugins"].as_array().ok_or(INVALID)? {
                if plugin["source"]["type"] != "remote"
                    || !plugin["installed"].as_bool().ok_or(INVALID)?
                    || !plugin["enabled"].as_bool().ok_or(INVALID)?
                {
                    continue;
                }
                let name = plugin["name"].as_str().ok_or(INVALID)?;
                // Personal/shared plugins are addressed by their backend identifier.
                let remote_id = plugin["remotePluginId"].as_str().unwrap_or(name);
                let id = pending.len() as u64 + 10;
                self.send(json!({"id":id, "method":"plugin/read","params":{
                    "remoteMarketplaceName":market["name"].as_str().ok_or(INVALID)?, "pluginName":remote_id
                }}))?;
                pending.insert(id, name.to_owned());
            }
        }
        let mut expected = BTreeSet::new();
        while !pending.is_empty() {
            let reply =
                self.response(|m| m["id"].as_u64().is_some_and(|id| pending.contains_key(&id)))?;
            let plugin = pending
                .remove(&reply["id"].as_u64().ok_or(INVALID)?)
                .ok_or(INVALID)?;
            let skills = reply["result"]["plugin"]["skills"]
                .as_array()
                .ok_or("Codex could not verify an installed remote plugin")?;
            for row in skills {
                let name = row["name"].as_str().ok_or(INVALID)?;
                expected.insert(format!("{plugin}:{name}"));
            }
        }
        Ok(expected)
    }
}

fn parse_skills(tool: Tool, rows: &Value) -> Result<Vec<Skill>> {
    let mut by_name = BTreeMap::new();
    for row in rows.as_array().ok_or(INVALID)? {
        let enabled = match tool {
            Tool::Codex => row["enabled"].as_bool().ok_or(INVALID)?,
            Tool::ClaudeCode => match row["state"].as_str() {
                Some("on" | "user-invocable-only") => true,
                Some("off") => false,
                _ => return Err(INVALID),
            },
        };
        if !enabled {
            continue;
        }
        let name = row["name"].as_str().ok_or(INVALID)?.trim();
        if name.is_empty() || name.chars().count() > 256 {
            return Err(INVALID);
        }
        let description = row["description"]
            .as_str()
            .ok_or(INVALID)?
            .trim()
            .chars()
            .take(4096)
            .collect();
        by_name.entry(name.to_owned()).or_insert(description);
    }
    if by_name.len() > 1024 {
        return Err("skill inventory exceeds server limit");
    }
    Ok(by_name
        .into_iter()
        .map(|(name, description)| Skill {
            tool,
            name,
            description,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_only_metadata_and_keeps_manual_skills() {
        let rows = json!([
            {"name":"hide","state":"off"}, {"name":"user","description":"example","state":"user-invocable-only","path":"/private","body":"instructions"},
            {"name":"plugin:a","description":"from a plugin","state":"on"}
        ]);
        let found = serde_json::to_value(parse_skills(Tool::ClaudeCode, &rows).unwrap()).unwrap();
        assert_eq!(
            found,
            json!([
                {"tool":"claude_code","name":"plugin:a","description":"from a plugin"},
                {"tool":"claude_code","name":"user","description":"example"}
            ])
        );
    }

    #[test]
    fn rejects_incomplete_inventories_and_excludes_disabled_rows() {
        assert!(parse_skills(Tool::Codex, &Value::Null).is_err());
        assert!(parse_skills(Tool::Codex, &json!([{"name":"a","description":"b"}])).is_err());
        let found = parse_skills(Tool::Codex, &json!([{"enabled":false}])).unwrap();
        assert!(found.is_empty());
    }
}
