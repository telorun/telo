//! What a command was handed in place of a manifest, resolved to what it loads. Mirrors
//! `../../nodejs/src/manifest-input.ts`: an `http(s)` URL, a packaged executable (found by
//! its trailer, Mach-O segment or PE resource, and read as data), a directory or a file.
//!
//! Two of the four are inputs this build cannot read — it has no HTTP transport and cannot
//! unpack a payload — so they are a host refusal (`InputRefusal::Unsupported`), never a
//! diagnostic. A path that cannot be read at all is the load failure Node reports for it.

use std::path::{Path, PathBuf};

use telo_kernel::lexical_path;
use telo_kernel::manifest_sources::local_manifest_cache_source::{resolve_cache_root, resolve_entry_dir};

use crate::package::app_trailer::carries_payload;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestInput {
    /// The manifest, directory or URL to load: the input resolved against the working
    /// directory.
    pub entry_path: String,
    /// The `.telo` cache root the load reads, `None` for an entry with no local anchor.
    pub cache_root: Option<PathBuf>,
    /// A packaged executable's payload is the sealed root of its input; this build reads no
    /// such input, so it is never set.
    pub cache_sealed: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum InputRefusal {
    /// A construct this host cannot read: held back, reported on stderr, exit 1.
    Unsupported(String),
    /// The load failure Node reports for the path, as a diagnostic.
    Failure(String),
}

fn is_url(input: &str) -> bool {
    input.starts_with("http://") || input.starts_with("https://") || input.starts_with("oci://")
}

/// `scheme://` — a URL scheme, as distinct from a Windows drive letter.
fn has_url_scheme(input: &str) -> bool {
    let Some(end) = input.find("://") else { return false };
    let scheme = &input[..end];
    let mut chars = scheme.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic()) && chars.all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
}

pub fn resolve_manifest_input(input: &str, cwd: &Path) -> Result<ManifestInput, InputRefusal> {
    if input.starts_with("http://") || input.starts_with("https://") {
        return Err(InputRefusal::Unsupported(format!(
            "'{input}' is an http(s) manifest URL, which this build has no transport to read"
        )));
    }
    let entry_path = if is_url(input) {
        input.to_string()
    } else {
        lexical_path::absolute(&cwd.join(input))
            .map_err(|err| InputRefusal::Failure(format!("cannot resolve '{input}': {err}")))?
            .to_string_lossy()
            .into_owned()
    };
    if !has_url_scheme(input) && Path::new(&entry_path).metadata().is_ok_and(|meta| meta.is_file()) {
        match carries_payload(Path::new(&entry_path)) {
            Ok(false) => {}
            Ok(true) => {
                return Err(InputRefusal::Unsupported(format!(
                    "'{input}' is a packaged executable, whose payload this build cannot unpack"
                )))
            }
            Err(message) => return Err(InputRefusal::Failure(message)),
        }
    }
    let entry_dir = resolve_entry_dir(&entry_path)
        .map_err(|err| InputRefusal::Failure(format!("cannot resolve '{input}': {err}")))?;
    let cache_root = match entry_dir {
        Some(dir) => Some(
            resolve_cache_root(&dir)
                .map_err(|err| InputRefusal::Failure(format!("cannot resolve the cache root of '{input}': {err}")))?,
        ),
        None => None,
    };
    Ok(ManifestInput { entry_path, cache_root, cache_sealed: false })
}
