use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::os::unix::fs::MetadataExt;
use std::path::Path;

use memchr::memmem::Finder;

/// Calls `f` for each newline-terminated line that contains any of `needles`
/// (every line when `needles` is empty). A final line without a trailing
/// newline is treated as still being written and is skipped.
pub fn for_each_matching_line(path: &Path, needles: &[&str], f: impl FnMut(&[u8])) -> std::io::Result<()> {
    read_matching_lines_from(path, 0, needles, f).map(|_| ())
}

/// start（バイト位置）から読み、needles を含む「改行で終わる行」ごとに f を呼ぶ。
/// 戻り値は、最後に読み終えた改行の直後の位置。書きかけの最後の行はその手前で止まる
pub fn read_matching_lines_from(path: &Path, start: u64, needles: &[&str], mut f: impl FnMut(&[u8])) -> std::io::Result<u64> {
    let finders: Vec<Finder<'_>> = needles.iter().map(|n| Finder::new(n.as_bytes())).collect();
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut reader = BufReader::with_capacity(256 * 1024, file);
    let mut buf = Vec::with_capacity(64 * 1024);
    let mut position = start;
    loop {
        buf.clear();
        let read = reader.read_until(b'\n', &mut buf)?;
        if read == 0 || buf.last() != Some(&b'\n') {
            return Ok(position);
        }
        position += read as u64;
        if finders.is_empty() || finders.iter().any(|fd| fd.find(&buf).is_some()) {
            f(&buf);
        }
    }
}

/// ファイルの識別子。rename しても変わらない（dev と ino の組）
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct FileId {
    pub dev: u64,
    pub ino: u64,
}

/// ファイルの識別子と現在の長さ
pub struct FileStat {
    pub id: FileId,
    pub len: u64,
}

/// path のファイル識別子と長さを返す
pub fn stat(path: &Path) -> std::io::Result<FileStat> {
    let meta = std::fs::metadata(path)?;
    Ok(FileStat {
        id: FileId { dev: meta.dev(), ino: meta.ino() },
        len: meta.len(),
    })
}

/// Returns the first newline-terminated line containing `needle`, reading
/// no further than that line.
pub fn first_matching_line(path: &Path, needle: &str) -> std::io::Result<Option<Vec<u8>>> {
    let finder = Finder::new(needle.as_bytes());
    let mut reader = BufReader::with_capacity(64 * 1024, File::open(path)?);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        if reader.read_until(b'\n', &mut buf)? == 0 || buf.last() != Some(&b'\n') {
            return Ok(None);
        }
        if finder.find(&buf).is_some() {
            return Ok(Some(buf));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect(content: &str, needles: &[&str]) -> Vec<String> {
        let path = std::env::temp_dir().join(format!("aiwl-jsonl-{}-{}.jsonl", std::process::id(), content.len()));
        std::fs::write(&path, content).unwrap();
        let mut got = Vec::new();
        for_each_matching_line(&path, needles, |l| {
            let s = String::from_utf8_lossy(l);
            got.push(s.trim_end_matches(['\n', '\r']).to_string());
        })
        .unwrap();
        std::fs::remove_file(&path).unwrap();
        got
    }

    #[test]
    fn passes_only_complete_lines_containing_a_needle() {
        assert_eq!(collect("a:1\nb:2\na:3\na:4", &["a:"]), vec!["a:1", "a:3"]);
    }

    #[test]
    fn first_matching_line_stops_at_the_first_match() {
        let path = std::env::temp_dir().join(format!("aiwl-first-{}.jsonl", std::process::id()));
        std::fs::write(&path, "x:0\nmeta:1\nmeta:2\n").unwrap();
        let got = first_matching_line(&path, "meta:").unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(got.as_deref(), Some(&b"meta:1\n"[..]));
    }

    #[test]
    fn empty_needles_pass_every_complete_line() {
        assert_eq!(collect("x\ny\n", &[]), vec!["x", "y"]);
    }

    fn temp_path(test: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("aiwl-{test}-{}.jsonl", std::process::id()))
    }

    #[test]
    fn resumes_from_the_returned_offset() {
        use std::io::Write;
        let path = temp_path("resumes_from_the_returned_offset");
        std::fs::write(&path, "a:1\na:2\na:3").unwrap();

        let mut first = Vec::new();
        let offset = read_matching_lines_from(&path, 0, &["a:"], |l| first.push(String::from_utf8_lossy(l).into_owned())).unwrap();
        assert_eq!(first, vec!["a:1\n", "a:2\n"]);
        assert_eq!(offset, 8);

        std::fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(b"\na:4\n").unwrap();
        let mut second = Vec::new();
        let end = read_matching_lines_from(&path, offset, &["a:"], |l| second.push(String::from_utf8_lossy(l).into_owned())).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(second, vec!["a:3\n", "a:4\n"]);
        assert_eq!(end, 16);
    }

    #[test]
    fn returns_start_when_nothing_new() {
        let path = temp_path("returns_start_when_nothing_new");
        std::fs::write(&path, "a:1\n").unwrap();
        let offset = read_matching_lines_from(&path, 0, &[], |_| {}).unwrap();
        assert_eq!(offset, 4);

        let mut calls = 0;
        let again = read_matching_lines_from(&path, offset, &[], |_| calls += 1).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(calls, 0);
        assert_eq!(again, offset);
    }

    #[test]
    fn file_id_survives_rename() {
        let path = temp_path("file_id_survives_rename");
        let renamed = temp_path("file_id_survives_rename_moved");
        std::fs::write(&path, "a:1\n").unwrap();
        let before = stat(&path).unwrap();
        std::fs::rename(&path, &renamed).unwrap();
        let after = stat(&renamed).unwrap();
        std::fs::remove_file(&renamed).unwrap();
        assert_eq!(before.id, after.id);
        assert_eq!(after.len, 4);
    }
}
