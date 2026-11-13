//! The `npm` ecosystem's pure half: an anchor holding a `package.json` with a
//! version is one npm package; its version is that file's top-level `version`.
//! A private package supplies its version and edges but contributes no layer.

use std::sync::{Arc, LazyLock};

use serde_json::Value;

use crate::adapter::{AnchorProbe, EcosystemAdapter, RecognizedPackage, VersionFileHandler, VersionLocationSpec};
use crate::version_files::{document_scalar, splice_scalar};
use crate::ReleaseError;

pub const PACKAGE_JSON: &str = "package.json";

fn read_package_json(text: &str) -> Option<serde_json::Map<String, Value>> {
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}

/// The top-level `"version"` of a `package.json` rewritten in place.
pub fn stamp_package_version(text: &str, version: &str, at: &str) -> Result<Option<String>, ReleaseError> {
    let Some(node) = document_scalar(text, &["version".to_string()], at)? else { return Ok(None) };
    if node.string_value().is_none() {
        return Ok(None);
    }
    splice_scalar(text, &node, version, at).map(Some)
}

struct PackageJsonHandler;

impl VersionFileHandler for PackageJsonHandler {
    fn file_name(&self) -> &'static str {
        PACKAGE_JSON
    }

    fn read(&self, text: &str, _at: &str) -> Result<Option<String>, ReleaseError> {
        Ok(read_package_json(text).and_then(|pkg| pkg.get("version").and_then(Value::as_str).map(str::to_string)))
    }

    fn write(&self, text: &str, version: &str, at: &str) -> Result<Option<String>, ReleaseError> {
        stamp_package_version(text, version, at)
    }
}

pub struct NpmAdapter {
    handlers: Vec<Arc<dyn VersionFileHandler>>,
}

impl EcosystemAdapter for NpmAdapter {
    fn ecosystem(&self) -> &'static str {
        "npm"
    }

    fn anchor_description(&self) -> &'static str {
        "a directory holding a package.json with a version"
    }

    fn version_file(&self) -> Option<VersionLocationSpec> {
        Some(VersionLocationSpec { file: PACKAGE_JSON.into(), pointer: None })
    }

    fn recognize(&self, probe: &AnchorProbe<'_>) -> Option<RecognizedPackage> {
        let pkg = read_package_json(&probe.read_file(PACKAGE_JSON)?)?;
        pkg.get("version").and_then(Value::as_str)?;
        Some(RecognizedPackage {
            name: pkg.get("name").and_then(Value::as_str).map(str::to_string),
            contributes_layer: pkg.get("private") != Some(&Value::Bool(true)),
            version_files: Vec::new(),
        })
    }

    fn version_file_handlers(&self) -> Vec<Arc<dyn VersionFileHandler>> {
        self.handlers.clone()
    }
}

pub static NPM_ADAPTER: LazyLock<Arc<NpmAdapter>> =
    LazyLock::new(|| Arc::new(NpmAdapter { handlers: vec![Arc::new(PackageJsonHandler)] }));
