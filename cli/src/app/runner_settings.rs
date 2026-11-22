//! Local project and provider mappings. Only their names are advertised to the server.
use crate::adapters::fsutil;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::ErrorKind;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

type Result<T> = std::result::Result<T, &'static str>;

#[derive(Default, Deserialize, Serialize)]
pub(super) struct Settings {
    #[serde(default)]
    pub projects: BTreeMap<String, PathBuf>,
    #[serde(default)]
    pub executables: BTreeMap<String, PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_sandbox: Option<Sandbox>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    auto_detect_engines: Option<bool>,
    #[serde(flatten)]
    extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Default, Copy, Clone, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum Sandbox {
    #[default]
    ReadOnly,
    WorkspaceWrite,
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name == name.trim()
        && name.encode_utf16().count() <= 256
        && !name.chars().any(char::is_control)
}

fn executable(path: &Path) -> bool {
    path.is_absolute()
        && path
            .metadata()
            .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

impl Settings {
    fn read(home: &Path) -> Result<Self> {
        match fs::read(home.join("runner.json")) {
            Ok(bytes) => {
                serde_json::from_slice(&bytes).map_err(|_| "runner.json の形式が正しくありません")
            }
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(Self {
                auto_detect_engines: Some(true),
                ..Self::default()
            }),
            Err(_) => Err("runner.json を読み込めません"),
        }
    }

    // Keep paths found in the interactive shell when launchd has a smaller PATH.
    fn discover_engines(&mut self) -> bool {
        if self.auto_detect_engines != Some(true) {
            return false;
        }
        let path = std::env::var_os("PATH").unwrap_or_default();
        let mut changed = false;
        for (engine, cmd) in [("claude_code", "claude"), ("codex", "codex")] {
            if self
                .executables
                .get(engine)
                .is_some_and(|bin| executable(bin))
            {
                continue;
            }
            if let Some(bin) = std::env::split_paths(&path)
                .map(|dir| dir.join(cmd))
                .find(|bin| executable(bin))
            {
                self.executables.insert(engine.into(), bin);
                changed = true;
            }
        }
        changed
    }

    fn project_key(&self, dir: &Path, name: Option<&str>) -> Result<String> {
        let matches =
            |path: &PathBuf| path.is_absolute() && path.canonicalize().as_deref().ok() == Some(dir);
        let previous = self
            .projects
            .iter()
            .find(|(_, path)| matches(path))
            .map(|(key, _)| key.as_str());
        let key = name
            .or(previous)
            .or_else(|| dir.file_name()?.to_str())
            .filter(|key| valid_name(key))
            .ok_or("有効なプロジェクト名を --name で指定してください")?;
        match self.projects.get(key) {
            Some(path) if !matches(path) => {
                Err("同じプロジェクト名が登録済みです。別の --name を指定してください")
            }
            None if previous.is_some() => Err("このフォルダは別のプロジェクト名で登録されています"),
            None if self.projects.len() >= 1024 => Err("登録できるプロジェクトは1024件までです"),
            _ => Ok(key.to_owned()),
        }
    }

    pub fn available(home: &Path) -> Result<Self> {
        let mut settings = Self::read(home)?;
        settings.discover_engines();
        settings
            .projects
            .retain(|name, dir| valid_name(name) && dir.is_absolute() && dir.is_dir());
        settings.executables.retain(|engine, bin| {
            matches!(engine.as_str(), "claude_code" | "codex") && executable(bin)
        });
        if settings.projects.len() > 1024 {
            return Err("登録できるプロジェクトは1024件までです");
        }
        Ok(settings)
    }
}

pub fn add_folder(home: &Path, dir: &Path, name: Option<&str>) -> Result<String> {
    let dir = dir.canonicalize().map_err(|_| "フォルダを開けません")?;
    if !dir.is_dir() || dir.to_str().is_none() {
        return Err("UTF-8のフォルダを指定してください");
    }
    let lock = fsutil::open_private_file(home, "runner-settings.lock")
        .map_err(|_| "設定ロックを開けません")?;
    lock.lock().map_err(|_| "設定ロックを取得できません")?;
    let mut settings = Settings::read(home)?;
    let key = settings.project_key(&dir, name)?;
    if !settings.discover_engines() && settings.projects.contains_key(&key) {
        fs::set_permissions(home.join("runner.json"), fs::Permissions::from_mode(0o600))
            .map_err(|_| "runner.json の権限を設定できません")?;
        return Ok(key);
    }
    settings.projects.entry(key.clone()).or_insert(dir);
    let mut bytes = serde_json::to_vec_pretty(&settings).map_err(|_| "設定を変換できません")?;
    bytes.push(b'\n');
    fsutil::write_atomically(&home.join("runner.json"), &bytes)
        .map_err(|_| "runner.json を保存できません")?;
    Ok(key)
}

#[cfg(target_os = "macos")]
pub fn choose_folder() -> Result<Option<PathBuf>> {
    use std::process::Command;
    let output = Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(
            r#"
        try
            return POSIX path of (choose folder with prompt "Choose a project folder for Taskfolio")
        on error number -128
            return ""
        end try
    "#,
        )
        .output()
        .map_err(|_| "フォルダ選択を開けません。--path を指定してください")?;
    if !output.status.success() {
        return Err("フォルダ選択に失敗しました。--path を指定してください");
    }
    let path =
        std::str::from_utf8(&output.stdout).map_err(|_| "UTF-8のフォルダを指定してください")?;
    let path = path.strip_suffix('\n').unwrap_or(path);
    Ok((!path.is_empty()).then(|| PathBuf::from(path)))
}

#[cfg(not(target_os = "macos"))]
pub fn choose_folder() -> Result<Option<PathBuf>> {
    Err("フォルダを --path で指定してください")
}
