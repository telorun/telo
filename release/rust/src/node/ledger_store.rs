//! Reading and writing `.changes/ledger.yaml` and the pending fragments beside
//! it. The shapes and their parsers are the core's; this is the disk.

use std::fs;
use std::path::Path;

use crate::fragment::{parse_fragment, ReleaseFragment};
use crate::ledger::{parse_ledger, serialize_ledger, Ledger, ParseLedgerOptions, LEDGER_PATH};
use crate::ReleaseError;

/// Where a fragment waits to be released.
pub const PENDING_DIR: &str = ".changes/pending";

fn io(path: &Path, err: std::io::Error) -> ReleaseError {
    ReleaseError::new(format!("{}: {err}", path.display()))
}

pub fn read_ledger(root: &Path, options: &ParseLedgerOptions<'_>) -> Result<Ledger, ReleaseError> {
    let file = root.join(LEDGER_PATH);
    if !file.exists() {
        return Ok(Ledger::default());
    }
    let text = fs::read_to_string(&file).map_err(|err| io(&file, err))?;
    parse_ledger(&text, LEDGER_PATH, options)
}

pub fn write_ledger(root: &Path, ledger: &Ledger) -> Result<(), ReleaseError> {
    let file = root.join(LEDGER_PATH);
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|err| io(parent, err))?;
    }
    fs::write(&file, serialize_ledger(ledger)).map_err(|err| io(&file, err))
}

/// Every pending fragment, in filename order.
pub fn read_fragments(root: &Path) -> Result<Vec<ReleaseFragment>, ReleaseError> {
    let dir = root.join(PENDING_DIR);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut names: Vec<String> = fs::read_dir(&dir)
        .map_err(|err| io(&dir, err))?
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".yaml") || name.ends_with(".yml"))
        .collect();
    names.sort();
    names
        .iter()
        .map(|name| {
            let file = dir.join(name);
            let text = fs::read_to_string(&file).map_err(|err| io(&file, err))?;
            parse_fragment(&text, &format!("{PENDING_DIR}/{name}"))
        })
        .collect()
}

/// Write a fragment, never over one that already exists: a taken name gets a
/// `-2` rather than replacing somebody's changelog line.
pub fn write_fragment(root: &Path, name: &str, text: &str) -> Result<String, ReleaseError> {
    let dir = root.join(PENDING_DIR);
    fs::create_dir_all(&dir).map_err(|err| io(&dir, err))?;
    let (stem, ext) = match name.rfind('.') {
        Some(dot) if dot + 1 < name.len() => (&name[..dot], &name[dot..]),
        _ => (name, ""),
    };
    let mut candidate = name.to_string();
    let mut n = 2;
    while dir.join(&candidate).exists() {
        candidate = format!("{stem}-{n}{ext}");
        n += 1;
    }
    let file = dir.join(&candidate);
    fs::write(&file, text).map_err(|err| io(&file, err))?;
    Ok(format!("{PENDING_DIR}/{candidate}"))
}

pub fn delete_fragment(root: &Path, source: &str) -> Result<(), ReleaseError> {
    let file = root.join(source);
    match fs::remove_file(&file) {
        Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(io(&file, err)),
        _ => Ok(()),
    }
}
