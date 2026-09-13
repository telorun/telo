//! The **layer index** of `kernel/specs/module-artifact.md` — the `layers:` block
//! a published `telo.yaml` carries, listing every layer of the module artifact
//! except the manifest layer itself. Mirrors `../../nodejs/src/artifact-layer-index.ts`.
//!
//! It lives in `telo.yaml` because an import is pinned to a hash of `telo.yaml`
//! and nothing else, so the chain reads `import pin -> telo.yaml -> blob digest ->
//! layer contents`. Each entry carries `blob` (addresses the layer, verifies the
//! transfer) and `integrity` (verifies the extracted file set).
//!
//! `matchCodeLayers` has no Rust counterpart: it serves `telo install`'s cache
//! warming, and this kernel has no install command.

use std::collections::HashSet;

use serde_json::Value;

use crate::artifact_selector::{
    normalize_selector, selector_key, ArtifactSelector, ArtifactSelectorError, LayerRole,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArtifactLayer {
    pub role: LayerRole,
    /// Present on the selector-keyed roles (`controller`, `library`, `native`) only.
    pub selector: Option<ArtifactSelector>,
    /// OCI blob digest — addresses the layer and verifies the transfer.
    pub blob: String,
    /// Content digest over the layer's files — verifies what is on disk.
    pub integrity: String,
}

/// A malformed index: an `INVALID_LAYER_INDEX` of its own, or an invalid
/// selector inside it, which keeps the selector's own code.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum LayerIndexError {
    #[error("{0}")]
    Index(String),
    #[error(transparent)]
    Selector(#[from] ArtifactSelectorError),
}

impl LayerIndexError {
    pub const CODE: &'static str = "INVALID_LAYER_INDEX";

    pub fn code(&self) -> &'static str {
        match self {
            LayerIndexError::Index(_) => Self::CODE,
            LayerIndexError::Selector(_) => ArtifactSelectorError::CODE,
        }
    }
}

/// `sha256:` + 64 lowercase hex.
fn is_blob_digest(value: &str) -> bool {
    value
        .strip_prefix("sha256:")
        .is_some_and(|hex| hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

/// `sha256-` + 43 unpadded base64url characters.
fn is_content_digest(value: &str) -> bool {
    value.strip_prefix("sha256-").is_some_and(|digest| {
        digest.len() == 43
            && digest
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    })
}

fn digest(field: &str, raw: Option<&Value>, describe: &str) -> Result<String, LayerIndexError> {
    let raw = match raw {
        Some(Value::String(raw)) if !raw.is_empty() => raw,
        _ => {
            return Err(LayerIndexError::Index(format!(
                "{describe}: {field} is required and must be a string."
            )))
        }
    };
    if field == "blob" && !is_blob_digest(raw) {
        return Err(LayerIndexError::Index(format!(
            "{describe}: blob '{raw}' is not an OCI digest (expected 'sha256:' + 64 hex characters)."
        )));
    }
    if field == "integrity" && !is_content_digest(raw) {
        return Err(LayerIndexError::Index(format!(
            "{describe}: integrity '{raw}' is not a content digest (expected 'sha256-' + 43 base64url characters)."
        )));
    }
    Ok(raw.clone())
}

/// JavaScript's `String(value)`, which the Node half renders a bad role with.
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// Parse and validate a `layers:` value off an owner document. Order is
/// preserved — precedence among matching layers is declaration order.
///
/// A role this runtime does not know is SKIPPED, never rejected, and so is an
/// entry whose selector carries an unknown axis (spec §3.1); a structurally
/// invalid entry stays an error.
pub fn parse_layer_index(value: &Value, describe: &str) -> Result<Vec<ArtifactLayer>, LayerIndexError> {
    let Value::Array(entries) = value else {
        return Err(LayerIndexError::Index(format!(
            "{describe}: expected an array of layer entries."
        )));
    };
    let mut layers = Vec::new();
    let mut seen_selectors: HashSet<String> = HashSet::new();
    let mut seen_singletons: HashSet<LayerRole> = HashSet::new();

    for (index, raw) in entries.iter().enumerate() {
        let at = format!("{describe}[{index}]");
        let Value::Object(entry) = raw else {
            return Err(LayerIndexError::Index(format!("{at}: expected an object.")));
        };
        let role_name = match entry.get("role") {
            Some(Value::String(role)) if !role.is_empty() => role,
            other => {
                let got = match other {
                    None => "nothing".to_string(),
                    Some(value) => format!("'{}'", js_string(value)),
                };
                return Err(LayerIndexError::Index(format!(
                    "{at}: role is required and must be a non-empty string; got {got}."
                )));
            }
        };
        let blob = digest("blob", entry.get("blob"), &at)?;
        let integrity = digest("integrity", entry.get("integrity"), &at)?;
        let Some(role) = LayerRole::from_name(role_name) else {
            continue;
        };

        let selector = if role.carries_selector() {
            let Some(raw_selector) = entry.get("selector") else {
                return Err(LayerIndexError::Index(format!(
                    "{at}: a {} layer must declare a selector.",
                    role.name()
                )));
            };
            let Some(selector) = normalize_selector(raw_selector, &at)? else {
                continue;
            };
            // Scoped by role: a `js` controller layer and a `js` library layer
            // are different layers with the same selector.
            let key = format!("{}\0{}", role.name(), selector_key(&selector));
            if !seen_selectors.insert(key) {
                return Err(LayerIndexError::Index(format!(
                    "{at}: a second {} layer claims the selector {}. Each selector addresses exactly one layer of a role.",
                    role.name(),
                    selector_key(&selector)
                )));
            }
            Some(selector)
        } else {
            if entry.contains_key("selector") {
                return Err(LayerIndexError::Index(format!(
                    "{at}: a '{}' layer must not declare a selector — it is a singleton.",
                    role.name()
                )));
            }
            if !seen_singletons.insert(role) {
                return Err(LayerIndexError::Index(format!(
                    "{at}: a second '{}' layer is declared.",
                    role.name()
                )));
            }
            None
        };

        layers.push(ArtifactLayer {
            role,
            selector,
            blob,
            integrity,
        });
    }
    Ok(layers)
}

/// The singleton layer for a role, or `None` when the artifact has none.
pub fn singleton_layer(layers: &[ArtifactLayer], role: LayerRole) -> Option<&ArtifactLayer> {
    layers.iter().find(|layer| layer.role == role)
}

/// The layer of one code role carrying exactly `selector`. By exact key rather
/// than by re-matching a host: the candidate being resolved already is one
/// selector, and it is by construction the key of the layer that carries it.
pub fn code_layer_for<'a>(
    layers: &'a [ArtifactLayer],
    role: LayerRole,
    selector: &ArtifactSelector,
) -> Option<&'a ArtifactLayer> {
    let key = selector_key(selector);
    layers.iter().find(|layer| {
        layer.role == role
            && layer
                .selector
                .as_ref()
                .is_some_and(|candidate| selector_key(candidate) == key)
    })
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Map};

    use super::*;
    use crate::artifact_selector::{
        describe_selector, normalize_axis_value, selector_matches, PlatformAxis, PlatformTarget,
    };

    /// The same file `analyzer/nodejs/tests/layer-index-vectors.test.ts` runs.
    const VECTORS: &str = include_str!("../../artifact-axes/layer-index-vectors.json");

    fn selector(raw: &Value) -> ArtifactSelector {
        normalize_selector(raw, "selector")
            .expect("vector selector is valid")
            .expect("vector selector carries no unknown axis")
    }

    fn selector_json(selector: &ArtifactSelector) -> Value {
        let mut out = Map::new();
        out.insert("format".into(), json!(selector.format));
        for axis in PlatformAxis::ALL {
            if let Some(value) = selector.axes.get(axis) {
                out.insert(axis.name().into(), json!(value));
            }
        }
        Value::Object(out)
    }

    fn layer_json(layer: &ArtifactLayer) -> Value {
        let mut out = Map::new();
        out.insert("role".into(), json!(layer.role.name()));
        if let Some(selector) = &layer.selector {
            out.insert("selector".into(), selector_json(selector));
        }
        out.insert("blob".into(), json!(layer.blob));
        out.insert("integrity".into(), json!(layer.integrity));
        Value::Object(out)
    }

    #[test]
    fn agrees_with_the_shared_vectors() {
        let vectors: Value = serde_json::from_str(VECTORS).expect("vector file is JSON");

        for v in vectors["axisValues"].as_array().unwrap() {
            let got = normalize_axis_value(v["axis"].as_str().unwrap(), Some(&v["value"]), "selector");
            match v.get("error") {
                Some(error) => assert_eq!(json!(got.unwrap_err().detail), *error, "{v}"),
                None => assert_eq!(json!(got.unwrap()), v["normalized"], "{v}"),
            }
        }

        for v in vectors["selectorKeys"].as_array().unwrap() {
            let s = selector(&v["selector"]);
            assert_eq!(json!(selector_key(&s)), v["key"], "{v}");
            assert_eq!(json!(describe_selector(&s)), v["description"], "{v}");
        }

        for v in vectors["matching"].as_array().unwrap() {
            let mut target = PlatformTarget::default();
            for (key, value) in v["target"].as_object().unwrap() {
                let value = Some(value.as_str().unwrap().to_string());
                match PlatformAxis::from_name(key) {
                    Some(axis) => target.axes.set(axis, value),
                    None if key == "format" => target.format = value,
                    None => panic!("vector target names unknown axis {key}"),
                }
            }
            assert_eq!(
                json!(selector_matches(&selector(&v["selector"]), &target)),
                v["matches"],
                "{}",
                v["name"]
            );
        }

        for v in vectors["layerIndexes"].as_array().unwrap() {
            let got = match parse_layer_index(&v["layers"], "layers") {
                Ok(layers) => json!({ "value": layers.iter().map(layer_json).collect::<Vec<_>>() }),
                Err(err) => json!({ "error": { "code": err.code(), "message": err.to_string() } }),
            };
            let expected = match v.get("error") {
                Some(error) => json!({ "error": error }),
                None => json!({ "value": v["expected"] }),
            };
            assert_eq!(got, expected, "{}", v["name"]);
        }
    }
}
