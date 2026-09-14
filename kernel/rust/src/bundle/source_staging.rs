//! Fetching, extracting and writing a file a module's `sources:` block stages, on
//! first use. Mirrors `../../../nodejs/src/bundle/source-staging.ts`: a file is
//! written only once its bytes and execute bit match the pin, and concurrent
//! kernels serialize per archive URL under the module's `.telo/staging` and
//! re-check before fetching. Staging every entry of a module (`telo release
//! stage`) is the Node CLI's, which this runtime does not carry.

use std::fs;
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use telo_analyzer::source_entries::{
    resolve_source_url, source_url_problem, ModuleSource, SourceEntry, SourcePin,
};
use ureq::Agent;

use crate::bundle::files_integrity::PayloadFile;
use crate::bundle::staged_entry::{check_staged_entry, StagedEntryState};
use crate::bundle::tar::read_tar_gz_bounded;
use crate::directory_lock::{with_directory_lock, LockError};
use crate::transports::egress_guard::assert_public_egress;
use crate::transports::oci::oci_client::resolve_location;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const FETCH_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_EXTRACTED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_REDIRECTS: usize = 10;

#[derive(Debug, thiserror::Error)]
pub enum StagingError {
    /// The archive could not be obtained: the network, the upstream, or the
    /// egress policy refused it.
    #[error("{0}")]
    Fetch(String),
    /// The archive was obtained and does not hold the file its entry declares:
    /// the member is absent or ambiguous, the archive does not read, or the bytes
    /// or execute bit differ from the pin.
    #[error("{0}")]
    Content(String),
    /// Anything else: a lock that could not be taken, a write that failed, a
    /// path that would stage outside the module.
    #[error("{0}")]
    Failed(String),
}

impl StagingError {
    /// The clause after "the file is staged by source 'x'", saying which kind of
    /// failure it was, so a lock or a write is never read as a bad pin.
    pub fn describe(&self) -> String {
        match self {
            StagingError::Fetch(detail) => format!("and its archive could not be fetched: {detail}"),
            StagingError::Content(detail) => format!("but its archive does not hold the pinned file: {detail}"),
            StagingError::Failed(detail) => format!("and staging it failed: {detail}"),
        }
    }
}

impl From<LockError> for StagingError {
    fn from(err: LockError) -> Self {
        StagingError::Failed(err.to_string())
    }
}

fn io_failed(err: std::io::Error) -> StagingError {
    StagingError::Failed(err.to_string())
}

/// What a staged entry is once [`ensure_staged_entry`] returns: staging leaves
/// nothing short of a match, and an unpinned entry is never staged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnsuredEntryState {
    Match,
    Unpinned,
}

/// GET `url`, following redirects here so each hop is vetted — by the egress
/// policy and by the rule a source's own url follows — and bounded in time and
/// size.
fn fetch_archive(url: &str) -> Result<Vec<u8>, StagingError> {
    let agent: Agent = Agent::config_builder()
        .http_status_as_error(false)
        .max_redirects(0)
        .timeout_connect(Some(CONNECT_TIMEOUT))
        .timeout_global(Some(FETCH_TIMEOUT))
        .build()
        .into();
    let mut current = url.to_string();
    for hop in 0..=MAX_REDIRECTS {
        assert_public_egress(&current).map_err(|err| {
            StagingError::Fetch(format!("the archive request {current} was refused: {err}"))
        })?;
        let mut response = agent
            .get(&current)
            .call()
            .map_err(|err| StagingError::Fetch(format!("could not fetch the archive {url}: {err}")))?;
        let status = response.status();
        let location = status
            .is_redirection()
            .then(|| response.headers().get("location"))
            .flatten()
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        if let Some(location) = location {
            if hop == MAX_REDIRECTS {
                break;
            }
            let next = resolve_location(&current, &location);
            if let Some((_, detail)) = source_url_problem(&next) {
                return Err(StagingError::Fetch(format!(
                    "the archive request {url} was redirected to {next}: {detail}"
                )));
            }
            current = next;
            continue;
        }
        if !status.is_success() {
            return Err(StagingError::Fetch(format!(
                "the archive request {url} answered {} {}",
                status.as_u16(),
                status.canonical_reason().unwrap_or("")
            )));
        }
        let mut bytes = Vec::new();
        response
            .body_mut()
            .as_reader()
            .take(MAX_ARCHIVE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|err| StagingError::Fetch(format!("could not fetch the archive {url}: {err}")))?;
        if bytes.len() as u64 > MAX_ARCHIVE_BYTES {
            return Err(StagingError::Fetch(format!(
                "the archive {url} is larger than the {MAX_ARCHIVE_BYTES}-byte limit"
            )));
        }
        return Ok(bytes);
    }
    Err(StagingError::Fetch(format!(
        "the archive request {url} was redirected more than {MAX_REDIRECTS} times"
    )))
}

fn member_name(name: &str) -> &str {
    let mut name = name;
    while let Some(rest) = name.strip_prefix("./") {
        name = rest;
    }
    name
}

/// One file out of an archive's entries.
fn extract_member(entries: Vec<PayloadFile>, member: &str) -> Result<(Vec<u8>, bool), StagingError> {
    let mut matches: Vec<PayloadFile> = entries
        .into_iter()
        .filter(|entry| member_name(entry.name()) == member_name(member))
        .collect();
    if matches.len() > 1 {
        return Err(StagingError::Content(format!(
            "member '{member}' occurs {} times in the archive, so which file it names is ambiguous",
            matches.len()
        )));
    }
    match matches.pop() {
        None => Err(StagingError::Content(format!("member '{member}' is not in the archive"))),
        Some(PayloadFile::Link { .. }) => Err(StagingError::Content(format!(
            "member '{member}' is a symbolic link in the archive, not a file"
        ))),
        Some(PayloadFile::Regular { content, executable, .. }) => Ok((content, executable)),
    }
}

/// Refuse an entry whose parent path crosses a symbolic link or a non-directory
/// on disk: the path is confined as text, but a checked-out link would carry the
/// write below it outside the module.
fn assert_confined(dir: &Path, entry_path: &str) -> Result<(), StagingError> {
    let segments: Vec<&str> = entry_path.split('/').collect();
    let mut current = dir.to_path_buf();
    for segment in &segments[..segments.len().saturating_sub(1)] {
        current.push(segment);
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(err) if err.kind() == ErrorKind::NotFound => return Ok(()),
            Err(err) => return Err(io_failed(err)),
        };
        let relative = current.strip_prefix(dir).unwrap_or(&current).display().to_string();
        if metadata.file_type().is_symlink() {
            return Err(StagingError::Failed(format!(
                "'{relative}' is a symbolic link on disk; staging below it would write outside the module. Replace it with a directory."
            )));
        }
        if !metadata.is_dir() {
            return Err(StagingError::Failed(format!(
                "'{relative}' exists on disk and is not a directory."
            )));
        }
    }
    Ok(())
}

/// Replace `abs` in one step, so a concurrent reader sees the old entry or the
/// new one and never a partial write.
fn replace_entry(abs: &Path, write: impl FnOnce(&Path) -> std::io::Result<()>) -> Result<(), StagingError> {
    if let Some(parent) = abs.parent() {
        fs::create_dir_all(parent).map_err(io_failed)?;
    }
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_nanos());
    let temp = PathBuf::from(format!("{}.{}.{nanos}.tmp", abs.display(), std::process::id()));
    let written = write(&temp).and_then(|()| fs::rename(&temp, abs));
    if let Err(err) = written {
        let _ = fs::remove_file(&temp);
        return Err(io_failed(err));
    }
    Ok(())
}

#[cfg(unix)]
fn write_file(path: &Path, content: &[u8], executable: bool) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::write(path, content)?;
    fs::set_permissions(path, fs::Permissions::from_mode(if executable { 0o755 } else { 0o644 }))
}

#[cfg(windows)]
fn write_file(path: &Path, content: &[u8], _executable: bool) -> std::io::Result<()> {
    fs::write(path, content)
}

#[cfg(unix)]
fn write_link(target: &str, path: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, path)
}

#[cfg(windows)]
fn write_link(target: &str, path: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_file(target, path)
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Fetch one file entry from its source's archive and write it, once its bytes
/// and execute bit match the pin.
fn stage_file_entry(
    dir: &Path,
    path: &str,
    url: &str,
    source: &ModuleSource,
    member: &str,
    pin: &SourcePin,
) -> Result<(), StagingError> {
    assert_confined(dir, path)?;
    let archive = fetch_archive(url)?;
    let entries = read_tar_gz_bounded(&archive, MAX_EXTRACTED_BYTES).map_err(|err| {
        StagingError::Content(format!("the archive {url} does not read as {}: {err}", source.archive))
    })?;
    let (content, executable) = extract_member(entries, member)?;
    let digest = sha256_hex(&content);
    if digest != pin.sha256 {
        return Err(StagingError::Content(format!(
            "member '{member}' hashes to sha256 {digest}, but the pin is {}",
            pin.sha256
        )));
    }
    if executable != pin.executable {
        return Err(StagingError::Content(format!(
            "member '{member}' is {}executable, but the pin says executable: {}",
            if executable { "" } else { "not " },
            pin.executable
        )));
    }
    replace_entry(&dir.join(path), |temp| write_file(temp, &content, executable))
}

fn stage_link_entry(dir: &Path, path: &str, target: &str) -> Result<(), StagingError> {
    assert_confined(dir, path)?;
    let abs = dir.join(path);
    let stored = fs::symlink_metadata(&abs)
        .ok()
        .filter(|metadata| metadata.file_type().is_symlink())
        .and_then(|_| fs::read_link(&abs).ok());
    if stored.is_some_and(|stored| stored.to_string_lossy().replace('\\', "/") == target) {
        return Ok(());
    }
    replace_entry(&abs, |temp| write_link(target, temp))
}

/// Bring one staged entry to its pin, staging it when it is missing or no longer
/// matches — following a link through its source to the file it leads to, and
/// creating the links on the way. An unpinned entry is returned as it is, never
/// staged. Concurrent callers serialize per archive URL, so an archive is fetched
/// once while entries from different archives stage side by side.
pub fn ensure_staged_entry(
    dir: &Path,
    source: &ModuleSource,
    entry: &SourceEntry,
) -> Result<EnsuredEntryState, StagingError> {
    match check_staged_entry(dir, source, entry).map_err(io_failed)? {
        StagedEntryState::Match => return Ok(EnsuredEntryState::Match),
        StagedEntryState::Unpinned => return Ok(EnsuredEntryState::Unpinned),
        StagedEntryState::Missing(_) | StagedEntryState::Mismatch(_) => {}
    }

    let mut links: Vec<(&str, &str)> = Vec::new();
    let mut current = entry;
    let (file, path, upstream, member, pin) = loop {
        match current {
            SourceEntry::File { path, upstream, member, pin, .. } => break (current, path, upstream, member, pin),
            SourceEntry::Link { path, target, resolved, .. } => {
                if links.iter().any(|(seen, _)| seen == path) {
                    return Err(StagingError::Failed(format!(
                        "the link '{}' of source '{}' leads back to '{path}'",
                        entry.path(),
                        source.name
                    )));
                }
                links.push((path, target));
                current = source.entries.iter().find(|candidate| candidate.path() == resolved).ok_or_else(|| {
                    StagingError::Failed(format!(
                        "the link '{path}' of source '{}' leads to no entry of that source",
                        source.name
                    ))
                })?;
            }
        }
    };
    let Some(pin) = pin else {
        return Ok(EnsuredEntryState::Unpinned);
    };
    let url = resolve_source_url(source, upstream);

    // Under the module's own `.telo/`, which every checkout ignores.
    let lock = dir.join(".telo").join("staging").join(&sha256_hex(url.as_bytes())[..16]);
    with_directory_lock(&lock, "staged file", || {
        if check_staged_entry(dir, source, file).map_err(io_failed)? != StagedEntryState::Match {
            eprintln!("telo: staging '{path}' of the module at {} from {url}", dir.display());
            stage_file_entry(dir, path, &url, source, member, pin)?;
        }
        for (path, target) in links.iter().rev() {
            stage_link_entry(dir, path, target)?;
        }
        Ok::<(), StagingError>(())
    })?;
    Ok(EnsuredEntryState::Match)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use telo_analyzer::source_entries::read_module_sources;

    const LIB: &[u8] = b"\x7fELF library bytes";

    fn archive() -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_size(LIB.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder.append_data(&mut header, "package/lib/libx.so.1", LIB).unwrap();
        let tar = builder.into_inner().unwrap();
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(&tar).unwrap();
        gz.finish().unwrap()
    }

    /// Serves the archive at `/lib-1.0.0.tgz` and 404 elsewhere, counting requests.
    fn serve() -> (String, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&requests);
        let body = archive();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") && stream.read(&mut byte).is_ok_and(|n| n == 1) {
                    head.push(byte[0]);
                }
                counted.fetch_add(1, Ordering::SeqCst);
                let found = String::from_utf8_lossy(&head).starts_with("GET /lib-1.0.0.tgz ");
                let (status, payload): (&str, &[u8]) = if found { ("200 OK", &body) } else { ("404 Not Found", b"") };
                let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", payload.len());
                let _ = stream.write_all(payload);
            }
        });
        (base, requests)
    }

    fn source(url: &str, sha256: &str) -> ModuleSource {
        let read = read_module_sources(&json!({ "sources": { "lib": {
            "version": "1.0.0", "url": url, "archive": "tar.gz", "notices": ["LICENSE"],
            "entries": {
                "native/libx.so.1": { "upstream": "x", "member": "package/lib/libx.so.1", "sha256": sha256, "executable": false },
                "native/libx.so": { "target": "libx.so.1" },
                "native/unpinned.so": { "upstream": "x", "member": "package/lib/libx.so.1" },
            },
        } } }));
        assert_eq!(read.problems, []);
        read.sources.into_iter().next().unwrap()
    }

    fn entry<'a>(source: &'a ModuleSource, path: &str) -> &'a SourceEntry {
        source.entries.iter().find(|candidate| candidate.path() == path).unwrap()
    }

    #[test]
    fn stages_a_missing_file_and_the_link_leading_to_it() {
        let (base, requests) = serve();
        let dir = tempfile::tempdir().unwrap();
        let lib = source(&format!("{base}/lib-{{version}}.tgz"), &sha256_hex(LIB));
        let state = ensure_staged_entry(dir.path(), &lib, entry(&lib, "native/libx.so")).unwrap();
        assert_eq!(state, EnsuredEntryState::Match);
        assert_eq!(fs::read(dir.path().join("native/libx.so")).unwrap(), LIB);
        assert_eq!(requests.load(Ordering::SeqCst), 1);

        // Already matching: no second fetch.
        ensure_staged_entry(dir.path(), &lib, entry(&lib, "native/libx.so.1")).unwrap();
        assert_eq!(requests.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn stages_a_stale_file_again() {
        let (base, _) = serve();
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("native")).unwrap();
        fs::write(dir.path().join("native/libx.so.1"), "an older release").unwrap();
        let lib = source(&format!("{base}/lib-{{version}}.tgz"), &sha256_hex(LIB));
        assert_eq!(
            ensure_staged_entry(dir.path(), &lib, entry(&lib, "native/libx.so.1")).unwrap(),
            EnsuredEntryState::Match
        );
        assert_eq!(fs::read(dir.path().join("native/libx.so.1")).unwrap(), LIB);
    }

    #[test]
    fn refuses_bytes_that_do_not_match_the_pin_and_writes_nothing() {
        let (base, _) = serve();
        let dir = tempfile::tempdir().unwrap();
        let lib = source(&format!("{base}/lib-{{version}}.tgz"), &"0".repeat(64));
        match ensure_staged_entry(dir.path(), &lib, entry(&lib, "native/libx.so.1")) {
            Err(StagingError::Content(detail)) => assert!(detail.contains("hashes to sha256"), "{detail}"),
            other => panic!("expected a pin mismatch, got {other:?}"),
        }
        assert!(!dir.path().join("native/libx.so.1").exists());
    }

    #[cfg(unix)]
    #[test]
    fn reports_a_failure_that_is_neither_a_fetch_nor_the_archive_content_as_neither() {
        let (base, requests) = serve();
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("native")).unwrap();
        let lib = source(&format!("{base}/lib-{{version}}.tgz"), &sha256_hex(LIB));
        match ensure_staged_entry(dir.path(), &lib, entry(&lib, "native/libx.so.1")) {
            Err(StagingError::Failed(detail)) => assert!(detail.contains("'native' is a symbolic link"), "{detail}"),
            other => panic!("expected a staging failure, got {other:?}"),
        }
        assert_eq!(requests.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn reports_an_upstream_that_cannot_provide_the_archive_as_a_fetch_failure() {
        let (base, _) = serve();
        let dir = tempfile::tempdir().unwrap();
        let lib = source(&format!("{base}/gone-{{version}}.tgz"), &sha256_hex(LIB));
        match ensure_staged_entry(dir.path(), &lib, entry(&lib, "native/libx.so.1")) {
            Err(StagingError::Fetch(detail)) => assert!(detail.contains("gone-1.0.0.tgz answered 404"), "{detail}"),
            other => panic!("expected a fetch failure, got {other:?}"),
        }
    }

    #[test]
    fn returns_an_unpinned_entry_without_fetching_it() {
        let (base, requests) = serve();
        let dir = tempfile::tempdir().unwrap();
        let lib = source(&format!("{base}/lib-{{version}}.tgz"), &sha256_hex(LIB));
        assert_eq!(
            ensure_staged_entry(dir.path(), &lib, entry(&lib, "native/unpinned.so")).unwrap(),
            EnsuredEntryState::Unpinned
        );
        assert_eq!(requests.load(Ordering::SeqCst), 0);
    }
}
