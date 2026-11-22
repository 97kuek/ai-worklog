use std::fs::{DirBuilder, OpenOptions, Permissions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::Path;

/// 自分だけが読み書きできるフォルダ（0700）を作る。親も同じ。既にあるフォルダの権限は変えない
pub fn create_private_dir(path: &Path) -> std::io::Result<()> {
    DirBuilder::new().recursive(true).mode(0o700).create(path)
}

pub(crate) fn open_lock_file(home: &Path, name: &str) -> std::io::Result<std::fs::File> {
    create_private_dir(home)?;
    OpenOptions::new().create(true).truncate(false).write(true).mode(0o600).open(home.join(name))
}

/// 同じフォルダの一時ファイルに書いて fsync してから rename する。
/// 途中で落ちても、元のファイルか新しいファイルのどちらかが残る。
/// ファイルは自分だけが読み書きできる 0600、ないフォルダは 0700 で作る
pub fn write_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        create_private_dir(parent)?;
    }
    let mut tmp_name = path.file_name().unwrap_or_default().to_os_string();
    tmp_name.push(format!(".tmp{}", std::process::id()));
    let tmp = path.with_file_name(tmp_name);
    let written = OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp).and_then(|mut f| {
        // 前に残った一時ファイルを開いたときも 0600 にする
        f.set_permissions(Permissions::from_mode(0o600))?;
        f.write_all(bytes)?;
        f.sync_all()
    });
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn mode(p: &Path) -> u32 {
        std::fs::metadata(p).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn writes_private_files_and_folders() {
        let root = std::env::temp_dir().join(format!("aiwl-fsutil-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let path = root.join("home").join("state.json");
        write_atomically(&path, b"{}").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"{}");
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(path.parent().unwrap()), 0o700);
        // 既にあるファイルを書き直しても 0600
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        write_atomically(&path, b"[]").unwrap();
        assert_eq!(mode(&path), 0o600);

        create_private_dir(&root.join("other")).unwrap();
        assert_eq!(mode(&root.join("other")), 0o700);
        let _ = std::fs::remove_dir_all(&root);
    }
}
