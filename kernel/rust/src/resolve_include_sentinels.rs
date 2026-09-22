//! Replace `!include-text` / `!include-bytes` markers with the file's contents,
//! mirroring `../../nodejs/src/resolve-include-sentinels.ts`.
//!
//! A path resolves as the Node kernel's `resolveModuleFileUri` resolves it: beside
//! the manifest for a module on disk, and inside the module directory of a
//! published artifact once its `assets` and `common` layers are materialized.
//! One thing differs, forced by what this kernel is: the manifest tree is
//! `serde_json::Value`, which has no bytes variant, so `!include-bytes` is refused
//! with an explicit message rather than silently producing an array of numbers
//! that no `x-telo-binary` slot would accept.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;
use telo_templating::{
    is_tagged_sentinel, normalize_include_path, normalize_module_path, tagged_sentinel_parts,
    INCLUDE_BYTES_ENGINE, INCLUDE_TEXT_ENGINE, MODULE_PATH_ENGINE,
};

use crate::bundle::module_artifact::ModuleFiles;
use crate::error::KernelError;

/// Ceiling on one embedded file. A resolved embed is retained for as long as the
/// resource holding it, so there is no point at which a large one is released.
pub const MAX_INCLUDE_BYTES: u64 = 32 * 1024 * 1024;

/// Reads keyed by absolute path, so two resources embedding one file read it once.
pub type IncludeCache = HashMap<PathBuf, String>;

/// Resolve every file embed in one resource document, in place.
///
/// `module_source` is the module's `telo.yaml` location and `files` where its
/// files are; paths are relative to the module root — never to the file the tag
/// was written in, which is what keeps a path meaning the same thing after
/// publish inlines partials.
pub fn resolve_include_sentinels(
    document: &mut Value,
    module_source: &str,
    files: &ModuleFiles,
    cache: &mut IncludeCache,
) -> Result<(), KernelError> {
    let mut root = ModuleRoot {
        source: module_source,
        files,
        dir: None,
    };
    // The document being created is itself a `{ kind, … }` declaration, so the
    // walk starts inside it — a nested declaration resolves when that resource
    // is created, the same line Phase-5 injection draws for references.
    walk(document, &mut root, cache)
}

/// The directory embeds resolve against, located on the first embed: a module
/// that embeds nothing materializes nothing.
struct ModuleRoot<'a> {
    source: &'a str,
    files: &'a ModuleFiles,
    dir: Option<PathBuf>,
}

impl ModuleRoot<'_> {
    fn dir(&mut self, relative: &str) -> Result<&Path, KernelError> {
        if self.dir.is_none() {
            self.dir = Some(match self.files {
                ModuleFiles::OnDisk => module_root(self.source),
                ModuleFiles::Artifact(artifact) => {
                    artifact.materialize_module_files()?;
                    artifact.directory().to_path_buf()
                }
                ModuleFiles::Unlocatable => {
                    return Err(KernelError::new(
                        "ERR_MODULE_FILES_UNAVAILABLE",
                        format!(
                            "Cannot resolve '{relative}' against module '{}': the module's artifact carries \
                             no layer index, so its files cannot be located. It was published by an older \
                             Telo that wrote a single-blob artifact — republish the module, or import it \
                             from a local path during development.",
                            self.source
                        ),
                    ))
                }
            });
        }
        Ok(self.dir.as_deref().unwrap_or(Path::new(".")))
    }
}

fn module_root(module_source: &str) -> PathBuf {
    let path = module_source.strip_prefix("file://").unwrap_or(module_source);
    Path::new(path)
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn walk(value: &mut Value, root: &mut ModuleRoot, cache: &mut IncludeCache) -> Result<(), KernelError> {
    match value {
        Value::Array(items) => {
            for item in items.iter_mut() {
                visit(item, root, cache)?;
            }
            Ok(())
        }
        Value::Object(entries) => {
            for (_, item) in entries.iter_mut() {
                visit(item, root, cache)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn visit(item: &mut Value, root: &mut ModuleRoot, cache: &mut IncludeCache) -> Result<(), KernelError> {
    if let Some((engine, source)) = tagged_sentinel_parts(item) {
        if engine == INCLUDE_TEXT_ENGINE || engine == INCLUDE_BYTES_ENGINE {
            *item = Value::String(read_embed(engine, source, root, cache)?);
            return Ok(());
        }
        if engine == MODULE_PATH_ENGINE {
            *item = Value::String(resolve_module_path(source, root)?);
            return Ok(());
        }
        // Another engine's marker is opaque.
        return Ok(());
    }
    if is_tagged_sentinel(item) || is_nested_declaration(item) {
        return Ok(());
    }
    walk(item, root, cache)
}

/// A nested resource declaration — an inline `{ kind, … }`. Its embeds are its
/// own to resolve, when it is created.
fn is_nested_declaration(value: &Value) -> bool {
    value
        .as_object()
        .is_some_and(|entries| entries.get("kind").and_then(Value::as_str).is_some())
}

/// A `!module-path` names a location, so resolving it reads nothing: it becomes
/// the absolute path of the file or directory once the module's files are on
/// disk, which is what a `Telo.HostPath` slot holds.
fn resolve_module_path(source: &str, root: &mut ModuleRoot) -> Result<String, KernelError> {
    let relative = normalize_module_path(source).map_err(|err| {
        KernelError::new(
            "ERR_MODULE_PATH_INVALID",
            format!("Invalid `!{MODULE_PATH_ENGINE}` path: {}", err.message),
        )
    })?;
    let path = root.dir(&relative)?.join(&relative);
    let absolute = std::path::absolute(&path).map_err(|err| {
        KernelError::new(
            "ERR_MODULE_PATH_UNREADABLE",
            format!("Cannot resolve '{relative}': '{}' has no absolute form ({err}).", path.display()),
        )
    })?;
    match std::fs::metadata(&absolute) {
        Ok(_) => Ok(absolute.display().to_string()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Err(KernelError::new(
            "ERR_MODULE_PATH_NOT_FOUND",
            format!(
                "Cannot resolve '{relative}': nothing at '{}'. The path is relative to the module \
                 root — the directory holding telo.yaml — not to the file the tag was written in.",
                absolute.display()
            ),
        )),
        Err(err) => Err(KernelError::new(
            "ERR_MODULE_PATH_UNREADABLE",
            format!("Cannot resolve '{relative}': '{}' could not be read ({err}).", absolute.display()),
        )),
    }
}

fn read_embed(
    engine: &str,
    source: &str,
    root: &mut ModuleRoot,
    cache: &mut IncludeCache,
) -> Result<String, KernelError> {
    if engine == INCLUDE_BYTES_ENGINE {
        return Err(KernelError::new(
            "ERR_INCLUDE_BYTES_UNSUPPORTED",
            format!(
                "`!{INCLUDE_BYTES_ENGINE} {source}`: this kernel carries a manifest as JSON, which \
                 has no value for raw bytes, so it cannot host a byte embed. Use `!{INCLUDE_TEXT_ENGINE}` \
                 for textual files, or run this module on the Node kernel."
            ),
        ));
    }

    // Re-checked here rather than trusted from `telo check`: the kernel does not
    // require that check to have run, and confinement is the one property whose
    // absence is a security question rather than a broken build.
    let relative = normalize_include_path(source).map_err(|err| {
        KernelError::new(
            "ERR_INCLUDE_PATH_INVALID",
            format!("Invalid `!{engine}` path: {}", err.message),
        )
    })?;
    let path = root.dir(&relative)?.join(&relative);

    if let Some(cached) = cache.get(&path) {
        return Ok(cached.clone());
    }

    let metadata = std::fs::metadata(&path).map_err(|_| {
        KernelError::new(
            "ERR_INCLUDE_FILE_NOT_FOUND",
            format!(
                "Cannot embed '{relative}': no such file at '{}'. The path is relative to the \
                 module root — the directory holding telo.yaml — not to the file the tag was \
                 written in.",
                path.display()
            ),
        )
    })?;
    if !metadata.is_file() {
        return Err(KernelError::new(
            "ERR_INCLUDE_UNREADABLE",
            format!("Cannot embed '{relative}': '{}' is not a file.", path.display()),
        ));
    }
    if metadata.len() > MAX_INCLUDE_BYTES {
        return Err(KernelError::new(
            "ERR_INCLUDE_FILE_TOO_LARGE",
            format!(
                "Cannot embed '{relative}': it is {} bytes, over the {MAX_INCLUDE_BYTES}-byte limit \
                 for a file embedded into a manifest value.",
                metadata.len()
            ),
        ));
    }

    let text = std::fs::read_to_string(&path).map_err(|err| {
        KernelError::new(
            "ERR_INCLUDE_UNREADABLE",
            format!("Cannot embed '{relative}': {err}"),
        )
    })?;
    cache.insert(path, text.clone());
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sentinel(engine: &str, source: &str) -> Value {
        json!({ "__tagged": true, "engine": engine, "source": source })
    }

    fn fixture() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(dir.path().join("theme.txt"), "brand: blue\n").expect("write");
        let manifest = dir.path().join("telo.yaml").display().to_string();
        (dir, manifest)
    }

    #[test]
    fn embeds_text() {
        let (_dir, manifest) = fixture();
        let mut doc = json!({ "kind": "X", "theme": sentinel(INCLUDE_TEXT_ENGINE, "theme.txt") });
        resolve_include_sentinels(&mut doc, &manifest, &ModuleFiles::OnDisk, &mut IncludeCache::new()).unwrap();
        assert_eq!(doc["theme"], json!("brand: blue\n"));
    }

    #[test]
    fn refuses_bytes_rather_than_producing_a_number_array() {
        let (_dir, manifest) = fixture();
        let mut doc = json!({ "kind": "X", "logo": sentinel(INCLUDE_BYTES_ENGINE, "theme.txt") });
        let err = resolve_include_sentinels(&mut doc, &manifest, &ModuleFiles::OnDisk, &mut IncludeCache::new())
            .expect_err("bytes are unrepresentable here");
        assert_eq!(err.code, "ERR_INCLUDE_BYTES_UNSUPPORTED");
    }

    #[test]
    fn re_checks_confinement() {
        let (_dir, manifest) = fixture();
        let mut doc = json!({ "kind": "X", "a": sentinel(INCLUDE_TEXT_ENGINE, "../escape.txt") });
        let err = resolve_include_sentinels(&mut doc, &manifest, &ModuleFiles::OnDisk, &mut IncludeCache::new())
            .expect_err("escape is refused");
        assert_eq!(err.code, "ERR_INCLUDE_PATH_INVALID");
    }

    #[test]
    fn reports_a_missing_file() {
        let (_dir, manifest) = fixture();
        let mut doc = json!({ "kind": "X", "a": sentinel(INCLUDE_TEXT_ENGINE, "nope.txt") });
        let err = resolve_include_sentinels(&mut doc, &manifest, &ModuleFiles::OnDisk, &mut IncludeCache::new())
            .expect_err("missing file is refused");
        assert_eq!(err.code, "ERR_INCLUDE_FILE_NOT_FOUND");
    }

    #[test]
    fn does_not_descend_into_a_nested_declaration() {
        let (_dir, manifest) = fixture();
        let mut doc = json!({
            "kind": "Run.Sequence",
            "with": [{ "kind": "Run.Value", "value": sentinel(INCLUDE_TEXT_ENGINE, "nope.txt") }],
            "own": sentinel(INCLUDE_TEXT_ENGINE, "theme.txt"),
        });
        resolve_include_sentinels(&mut doc, &manifest, &ModuleFiles::OnDisk, &mut IncludeCache::new()).unwrap();
        assert_eq!(doc["own"], json!("brand: blue\n"));
        assert!(is_tagged_sentinel(&doc["with"][0]["value"]));
    }

    /// A module fetched from a registry with no layer index has no files to
    /// embed from; that is said, rather than reported as a missing file at a
    /// cache path the author never wrote.
    #[test]
    fn refuses_an_embed_in_a_module_whose_files_cannot_be_located() {
        let (_dir, manifest) = fixture();
        let mut doc = json!({ "kind": "X", "theme": sentinel(INCLUDE_TEXT_ENGINE, "theme.txt") });
        let err = resolve_include_sentinels(&mut doc, &manifest, &ModuleFiles::Unlocatable, &mut IncludeCache::new())
            .expect_err("an unlocatable module's files are refused");
        assert_eq!(err.code, "ERR_MODULE_FILES_UNAVAILABLE");
        assert!(err.message.contains("republish the module"), "{err}");
    }

    #[test]
    fn resolves_a_module_path_to_an_absolute_location() {
        let (dir, manifest) = fixture();
        let mut doc = json!({ "kind": "X", "root": sentinel(MODULE_PATH_ENGINE, "./theme.txt") });
        resolve_include_sentinels(&mut doc, &manifest, &ModuleFiles::OnDisk, &mut IncludeCache::new()).unwrap();
        let resolved = PathBuf::from(doc["root"].as_str().expect("a path"));
        assert!(resolved.is_absolute());
        assert_eq!(resolved, std::path::absolute(dir.path().join("theme.txt")).unwrap());
    }

    #[test]
    fn reports_a_missing_module_path() {
        let (_dir, manifest) = fixture();
        let mut doc = json!({ "kind": "X", "root": sentinel(MODULE_PATH_ENGINE, "public") });
        let err = resolve_include_sentinels(&mut doc, &manifest, &ModuleFiles::OnDisk, &mut IncludeCache::new())
            .expect_err("nothing there is refused");
        assert_eq!(err.code, "ERR_MODULE_PATH_NOT_FOUND");
    }

    #[test]
    fn leaves_another_engines_marker_alone() {
        let (_dir, manifest) = fixture();
        let mut doc = json!({ "kind": "X", "r": sentinel("ref", "Other") });
        resolve_include_sentinels(&mut doc, &manifest, &ModuleFiles::OnDisk, &mut IncludeCache::new()).unwrap();
        assert!(is_tagged_sentinel(&doc["r"]));
    }
}
