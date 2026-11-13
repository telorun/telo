//! Reading a `.tgz` a package manager or a registry hands back, as the file
//! set it holds. ustar with GNU long names and pax `path` / `linkpath`
//! records; directories are dropped, since a file set is its files.

use std::collections::HashMap;
use std::io::Read;

use flate2::read::MultiGzDecoder;

use super::files_digest::FileSetEntry;
use crate::ReleaseError;

fn until_nul(bytes: &[u8]) -> String {
    let end = bytes.iter().position(|b| *b == 0).unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

fn octal(text: &str) -> u64 {
    let trimmed = text.trim();
    let digits: String = trimmed.chars().take_while(|c| ('0'..='7').contains(c)).collect();
    u64::from_str_radix(&digits, 8).unwrap_or(0)
}

pub fn read_tar_gz(bytes: &[u8], at: &str) -> Result<Vec<FileSetEntry>, ReleaseError> {
    let mut tar = Vec::new();
    MultiGzDecoder::new(bytes)
        .read_to_end(&mut tar)
        .map_err(|err| ReleaseError::new(format!("{at} is not a gzip archive: {err}")))?;
    let mut entries = Vec::new();
    let mut long_name: Option<String> = None;
    let mut long_link: Option<String> = None;
    let mut pax: HashMap<String, String> = HashMap::new();
    let mut offset = 0usize;
    while offset + 512 <= tar.len() {
        let header = &tar[offset..offset + 512];
        if header.iter().all(|b| *b == 0) {
            break;
        }
        let text = |start: usize, length: usize| until_nul(&header[start..start + length]);
        let size = octal(&text(124, 12)) as usize;
        let kind = header[156] as char;
        let body_end = (offset + 512 + size).min(tar.len());
        let body = &tar[(offset + 512).min(tar.len())..body_end];
        offset += 512 + size.div_ceil(512) * 512;
        match kind {
            'L' => {
                long_name = Some(until_nul(body));
                continue;
            }
            'K' => {
                long_link = Some(until_nul(body));
                continue;
            }
            'x' => {
                pax = read_pax(body);
                continue;
            }
            'g' => continue,
            _ => {}
        }
        let prefix = text(345, 155);
        let name = pax
            .get("path")
            .cloned()
            .or_else(|| long_name.clone())
            .unwrap_or_else(|| if prefix.is_empty() { text(0, 100) } else { format!("{prefix}/{}", text(0, 100)) });
        let link = pax.get("linkpath").cloned().or_else(|| long_link.clone()).unwrap_or_else(|| text(157, 100));
        let mode = octal(&text(100, 8));
        long_name = None;
        long_link = None;
        pax = HashMap::new();
        let relative = name.strip_prefix("./").map(str::to_string).unwrap_or(name);
        match kind {
            '0' | '\0' | '7' => entries.push(FileSetEntry::File { path: relative, content: body.to_vec(), executable: mode & 0o111 != 0 }),
            '2' => entries.push(FileSetEntry::Link { path: relative, link }),
            '5' => {}
            other => {
                return Err(ReleaseError::new(format!(
                    "{at} holds '{relative}' of tar type '{other}', which no file set can carry."
                )));
            }
        }
    }
    Ok(entries)
}

fn read_pax(body: &[u8]) -> HashMap<String, String> {
    let mut records = HashMap::new();
    let mut offset = 0usize;
    while offset < body.len() {
        let Some(space) = body[offset..].iter().position(|b| *b == b' ').map(|p| offset + p) else { break };
        let length: usize = match String::from_utf8_lossy(&body[offset..space]).trim().parse() {
            Ok(length) if length > 0 => length,
            _ => break,
        };
        let end = (offset + length).saturating_sub(1).min(body.len());
        if end > space + 1 {
            let record = String::from_utf8_lossy(&body[space + 1..end]).into_owned();
            if let Some(eq) = record.find('=').filter(|eq| *eq > 0) {
                records.insert(record[..eq].to_string(), record[eq + 1..].to_string());
            }
        }
        offset += length;
    }
    records
}

/// Entries beneath `prefix/`, renamed relative to it; every entry must be there.
pub fn strip_prefix(entries: Vec<FileSetEntry>, prefix: &str, at: &str) -> Result<Vec<FileSetEntry>, ReleaseError> {
    let lead = format!("{prefix}/");
    entries
        .into_iter()
        .map(|entry| {
            let path = entry.path().to_string();
            match path.strip_prefix(&lead) {
                Some(rest) => Ok(entry.renamed(rest.to_string())),
                None => Err(ReleaseError::new(format!("{at} holds '{path}', outside its '{prefix}/' directory."))),
            }
        })
        .collect()
}

/// A fresh directory under the system's temporary directory, for a tool to
/// write its tarball into — `fs.mkdtempSync(<tmp>/<prefix>)`. The caller
/// removes it.
pub fn scratch_dir(prefix: &str) -> Result<std::path::PathBuf, ReleaseError> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let base = std::env::temp_dir();
    for _ in 0..64 {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = base.join(format!("{prefix}{}{nanos:08x}{n}", std::process::id()));
        match std::fs::create_dir(&dir) {
            Ok(()) => return Ok(dir),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(ReleaseError::new(format!("{}: {err}", dir.display()))),
        }
    }
    Err(ReleaseError::new(format!("no scratch directory could be created under {}", base.display())))
}
