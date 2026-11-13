//! The `helm` ecosystem's pure half: an anchor holding a `Chart.yaml` with a
//! name and a version is one chart. Its version is the chart's `version`; a
//! chart anchored in a unit deploys that unit, so its `appVersion` carries the
//! same version and is written with it.

use std::sync::{Arc, LazyLock};

use serde_json::Value;

use crate::adapter::{AnchorProbe, EcosystemAdapter, RecognizedPackage, VersionFileHandler, VersionLocationSpec};
use crate::marker_schema::{KeySchemas, KeyType, WorkspaceKeySchema};
use crate::version_files::{document_scalar, splice_scalar, splice_text};
use crate::yaml::{json_string, parse_json};
use crate::ReleaseError;

pub const CHART_YAML: &str = "Chart.yaml";

/// `version` and `appVersion` of a `Chart.yaml`, rewritten in place; an absent
/// `appVersion` is added on the line after `version`.
pub fn stamp_chart_version(text: &str, version: &str, at: &str) -> Result<Option<String>, ReleaseError> {
    let Some(node) = document_scalar(text, &["version".into()], at)?.filter(|n| n.string_value().is_some()) else {
        return Ok(None);
    };
    if let Some(app) = document_scalar(text, &["appVersion".into()], at)? {
        let (first, second) = if app.range.0 > node.range.0 { (&app, &node) } else { (&node, &app) };
        let once = splice_scalar(text, first, version, at)?;
        return splice_scalar(&once, second, version, at).map(Some);
    }
    let written = splice_scalar(text, &node, version, at)?;
    let line = format!("appVersion: {}\n", json_string(version));
    Ok(Some(match written[node.range.0..].find('\n') {
        Some(offset) => {
            let at_line = node.range.0 + offset + 1;
            splice_text(&written, at_line, at_line, &line)
        }
        None => format!("{written}\n{line}"),
    }))
}

struct ChartHandler;

impl VersionFileHandler for ChartHandler {
    fn file_name(&self) -> &'static str {
        CHART_YAML
    }

    fn read(&self, text: &str, at: &str) -> Result<Option<String>, ReleaseError> {
        Ok(document_scalar(text, &["version".into()], at)?.and_then(|node| node.string_value().map(str::to_string)))
    }

    fn write(&self, text: &str, version: &str, at: &str) -> Result<Option<String>, ReleaseError> {
        stamp_chart_version(text, version, at)
    }
}

pub struct HelmAdapter {
    handlers: Vec<Arc<dyn VersionFileHandler>>,
}

impl EcosystemAdapter for HelmAdapter {
    fn ecosystem(&self) -> &'static str {
        "helm"
    }

    fn anchor_description(&self) -> &'static str {
        "a directory holding a Chart.yaml with a name and a version"
    }

    fn keys(&self) -> KeySchemas {
        vec![(
            "registry",
            WorkspaceKeySchema {
                ty: KeyType::String,
                description: "OCI chart registry base the chart is pushed under, as `<registry>/<chart name>`.",
                examples: &["oci://ghcr.io/acme/charts"],
                entry: None,
            },
        )]
    }

    fn version_file(&self) -> Option<VersionLocationSpec> {
        Some(VersionLocationSpec { file: CHART_YAML.into(), pointer: None })
    }

    fn recognize(&self, probe: &AnchorProbe<'_>) -> Option<RecognizedPackage> {
        let Ok(Value::Object(chart)) = parse_json(&probe.read_file(CHART_YAML)?) else { return None };
        let name = chart.get("name").and_then(Value::as_str)?;
        chart.get("version").and_then(Value::as_str)?;
        Some(RecognizedPackage { name: Some(name.to_string()), contributes_layer: true, version_files: Vec::new() })
    }

    fn version_file_handlers(&self) -> Vec<Arc<dyn VersionFileHandler>> {
        self.handlers.clone()
    }
}

pub static HELM_ADAPTER: LazyLock<Arc<HelmAdapter>> =
    LazyLock::new(|| Arc::new(HelmAdapter { handlers: vec![Arc::new(ChartHandler)] }));
