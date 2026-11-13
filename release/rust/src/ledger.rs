//! `.changes/ledger.yaml` — what each unit looks like **as published**.
//!
//! A cache of the registries' answers, so a gate compares a payload with what
//! is published at its version with no network call. Layers nest by ecosystem
//! and anchor (`npm: { nodejs: <digest> }`); an anchor building several layers
//! holds a map of them, and a declared payload sits under the reserved key
//! `payload`. A candidate record sits beside the final entry. The pre-unit
//! shape (a top-level `modules:` map) is read only when the host says how its
//! flat layers nest, and is never written.

use std::collections::BTreeSet;

use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::bump_level::{is_release_version, is_unit_version};
use crate::fragment::{normalize_unit_key, UnitKey};
use crate::yaml::{parse_json, stringify_document, Out};
use crate::ReleaseError;

pub const LEDGER_PATH: &str = ".changes/ledger.yaml";

/// The reserved layer key a unit's declared `payload:` is recorded under.
pub const PAYLOAD_LAYER: &str = "payload";

/// One anchor's digest, or a map of layer key to digest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AnchorDigest {
    One(String),
    Keyed(IndexMap<String, String>),
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UnitLayers {
    /// `<ecosystem>: { <anchor>: <digest> }`.
    pub ecosystems: IndexMap<String, IndexMap<String, AnchorDigest>>,
    pub payload: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CandidateRecord {
    pub version: String,
    pub layers: UnitLayers,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LedgerEntry {
    pub version: Option<String>,
    pub registry: Option<String>,
    pub layers: UnitLayers,
    pub candidate: Option<CandidateRecord>,
}

#[derive(Debug, Clone, Default)]
pub struct Ledger {
    pub units: IndexMap<UnitKey, LedgerEntry>,
}

/// How a host nests a pre-unit ledger's flat layer map, keyed by unit.
pub type LegacyLedgerLayers = dyn Fn(&str, &IndexMap<String, String>) -> UnitLayers;

#[derive(Default)]
pub struct ParseLedgerOptions<'a> {
    pub legacy_layers: Option<&'a LegacyLedgerLayers>,
}

fn err(message: String) -> ReleaseError {
    ReleaseError::new(message)
}

pub fn parse_ledger(text: &str, at: &str, options: &ParseLedgerOptions<'_>) -> Result<Ledger, ReleaseError> {
    let value = parse_json(text).map_err(|e| err(format!("{at} is not valid YAML: {}", e.message)))?;
    let record = match value {
        Value::Null => return Ok(Ledger::default()),
        Value::Object(record) => record,
        _ => return Err(err(format!("{at} must be a YAML mapping."))),
    };
    if record.contains_key("modules") || record.contains_key("registry") {
        return parse_legacy(&record, at, options);
    }
    for key in record.keys() {
        if key != "units" {
            return Err(err(format!("{at}: unknown field '{key}'. The ledger carries 'units:'.")));
        }
    }
    let mut units = IndexMap::new();
    match record.get("units") {
        None | Some(Value::Null) => return Ok(Ledger::default()),
        Some(raw) => {
            for (key, entry) in mapping(raw, &format!("{at}: 'units'"))? {
                units.insert(normalize_unit_key(key), read_entry(entry, &format!("{at}: entry '{key}'"))?);
            }
        }
    }
    Ok(Ledger { units })
}

fn mapping<'a>(raw: &'a Value, at: &str) -> Result<&'a Map<String, Value>, ReleaseError> {
    match raw {
        Value::Object(map) => Ok(map),
        _ => Err(err(format!("{at} must be a mapping."))),
    }
}

fn registry_of(entry: &Map<String, Value>) -> Option<String> {
    entry.get("registry").and_then(Value::as_str).map(str::to_string)
}

fn read_entry(raw: &Value, at: &str) -> Result<LedgerEntry, ReleaseError> {
    let entry = mapping(raw, at)?;
    for field in entry.keys() {
        if !["version", "registry", "layers", "candidate"].contains(&field.as_str()) {
            return Err(err(format!(
                "{at} has unknown field '{field}'. An entry carries 'version:', 'registry:', 'layers:' and 'candidate:'."
            )));
        }
    }
    if entry.get("registry").is_some_and(|r| !r.is_string()) {
        return Err(err(format!("{at} has a non-string 'registry'.")));
    }
    let candidate = match entry.get("candidate") {
        None => None,
        Some(raw) => Some(read_candidate(raw, at)?),
    };
    let version = entry.get("version");
    if version.is_none() {
        if let Some(candidate) = candidate.clone() {
            if entry.contains_key("layers") {
                return Err(err(format!("{at} records layers but no 'version'. Layers are taken at a published version.")));
            }
            return Ok(LedgerEntry { version: None, registry: registry_of(entry), layers: UnitLayers::default(), candidate: Some(candidate) });
        }
    }
    let Some(version) = version.and_then(Value::as_str).filter(|v| is_release_version(v)) else {
        return Err(err(format!(
            "{at} has no major.minor.patch 'version'. The ledger records the version each digest was taken at; without it the digest says nothing."
        )));
    };
    Ok(LedgerEntry {
        version: Some(version.to_string()),
        registry: registry_of(entry),
        layers: read_layers(entry.get("layers"), at)?,
        candidate,
    })
}

fn read_candidate(raw: &Value, at: &str) -> Result<CandidateRecord, ReleaseError> {
    let candidate = mapping(raw, &format!("{at}: 'candidate'"))?;
    for field in candidate.keys() {
        if field != "version" && field != "layers" {
            return Err(err(format!("{at}: 'candidate' has unknown field '{field}'. It carries 'version:' and 'layers:'.")));
        }
    }
    let version = candidate.get("version").and_then(Value::as_str);
    let Some(version) = version.filter(|v| is_unit_version(v) && !is_release_version(v)) else {
        return Err(err(format!("{at}: 'candidate.version' must be a candidate version, '<final>-<id>.<k>'.")));
    };
    Ok(CandidateRecord { version: version.to_string(), layers: read_layers(candidate.get("layers"), &format!("{at}: 'candidate'"))? })
}

fn read_layers(raw: Option<&Value>, at: &str) -> Result<UnitLayers, ReleaseError> {
    let Some(raw) = raw.filter(|v| !v.is_null()) else {
        return Ok(UnitLayers::default());
    };
    let mut layers = UnitLayers::default();
    for (ecosystem, anchors) in mapping(raw, &format!("{at}: 'layers'"))? {
        if ecosystem == PAYLOAD_LAYER {
            let Some(digest) = anchors.as_str() else {
                return Err(err(format!("{at}: layer '{PAYLOAD_LAYER}' is not a digest string.")));
            };
            layers.payload = Some(digest.to_string());
            continue;
        }
        let mut by_anchor = IndexMap::new();
        for (anchor, digest) in mapping(anchors, &format!("{at}: layer '{ecosystem}'"))? {
            if let Some(digest) = digest.as_str() {
                by_anchor.insert(anchor.clone(), AnchorDigest::One(digest.to_string()));
                continue;
            }
            let mut keyed = IndexMap::new();
            for (layer, value) in mapping(digest, &format!("{at}: layer '{ecosystem}' '{anchor}'"))? {
                let Some(value) = value.as_str() else {
                    return Err(err(format!("{at}: layer '{ecosystem}' '{anchor}' '{layer}' is not a digest string.")));
                };
                keyed.insert(layer.clone(), value.to_string());
            }
            by_anchor.insert(anchor.clone(), AnchorDigest::Keyed(keyed));
        }
        layers.ecosystems.insert(ecosystem.clone(), by_anchor);
    }
    Ok(layers)
}

fn parse_legacy(record: &Map<String, Value>, at: &str, options: &ParseLedgerOptions<'_>) -> Result<Ledger, ReleaseError> {
    let Some(legacy) = options.legacy_layers else {
        return Err(err(format!(
            "{at} is written in the module ledger shape (a top-level 'modules:' map), which this host cannot re-key into units. Rewrite it with a host serving the ecosystem that wrote it."
        )));
    };
    for key in record.keys() {
        if key != "registry" && key != "modules" {
            return Err(err(format!("{at}: unknown field '{key}'. The ledger carries 'registry:' and 'modules:'.")));
        }
    }
    let inherited = match record.get("registry") {
        None => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(_) => return Err(err(format!("{at}: 'registry' must be the publish destination base, as a string."))),
    };
    let mut units = IndexMap::new();
    let modules = match record.get("modules") {
        None | Some(Value::Null) => return Ok(Ledger { units }),
        Some(raw) => mapping(raw, &format!("{at}: 'modules'"))?,
    };
    for (key, raw) in modules {
        let entry_at = format!("{at}: entry '{key}'");
        let entry = mapping(raw, &entry_at)?;
        for field in entry.keys() {
            if field != "version" && field != "registry" && field != "layers" {
                return Err(err(format!(
                    "{entry_at} has unknown field '{field}'. An entry carries 'version:', 'registry:' and 'layers:'."
                )));
            }
        }
        if entry.get("registry").is_some_and(|r| !r.is_string()) {
            return Err(err(format!("{entry_at} has a non-string 'registry'.")));
        }
        let Some(version) = entry.get("version").and_then(Value::as_str).filter(|v| is_release_version(v)) else {
            return Err(err(format!(
                "{entry_at} has no major.minor.patch 'version'. The ledger records the version each digest was taken at; without it the digest says nothing."
            )));
        };
        let mut flat = IndexMap::new();
        if let Some(raw_layers) = entry.get("layers").filter(|v| !v.is_null()) {
            for (layer, digest) in mapping(raw_layers, &format!("{entry_at}: 'layers'"))? {
                let Some(digest) = digest.as_str() else {
                    return Err(err(format!("{entry_at} layer '{layer}' is not a digest string.")));
                };
                flat.insert(layer.clone(), digest.to_string());
            }
        }
        let unit = normalize_unit_key(key);
        let registry = registry_of(entry).or_else(|| inherited.clone()).filter(|r| !r.is_empty());
        let layers = legacy(&unit, &flat);
        units.insert(unit, LedgerEntry { version: Some(version.to_string()), registry, layers, candidate: None });
    }
    Ok(Ledger { units })
}

/// Render the ledger, keys sorted at every level.
pub fn serialize_ledger(ledger: &Ledger) -> String {
    let mut keys: Vec<&UnitKey> = ledger.units.keys().collect();
    keys.sort();
    let mut units = Vec::new();
    for key in keys {
        let entry = &ledger.units[key];
        let mut fields = Vec::new();
        if let Some(version) = &entry.version {
            fields.push(("version".to_string(), Out::Str(version.clone())));
        }
        if let Some(registry) = entry.registry.as_ref().filter(|r| !r.is_empty()) {
            fields.push(("registry".to_string(), Out::Str(registry.clone())));
        }
        if entry.version.is_some() {
            fields.push(("layers".to_string(), render_layers(&entry.layers)));
        }
        if let Some(candidate) = &entry.candidate {
            fields.push((
                "candidate".to_string(),
                Out::Map(vec![
                    ("version".to_string(), Out::Str(candidate.version.clone())),
                    ("layers".to_string(), render_layers(&candidate.layers)),
                ]),
            ));
        }
        units.push((key.clone(), Out::Map(fields)));
    }
    format!(
        "# Generated by `release apply` — what each unit looks like as published.\n# A cache of the registries' answers, so a PR gate needs no credentials.\n# `release verify` reconciles it against the registries.\n{}",
        stringify_document(&[("units".to_string(), Out::Map(units))], 0)
    )
}

fn sorted<V>(map: &IndexMap<String, V>) -> Vec<(&String, &V)> {
    let mut entries: Vec<(&String, &V)> = map.iter().collect();
    entries.sort_by(|a, b| a.0.cmp(b.0));
    entries
}

fn render_layers(layers: &UnitLayers) -> Out {
    let mut out = Vec::new();
    for (ecosystem, anchors) in sorted(&layers.ecosystems) {
        let mut by_anchor = Vec::new();
        for (anchor, digest) in sorted(anchors) {
            match digest {
                AnchorDigest::One(digest) => by_anchor.push((anchor.clone(), Out::Str(digest.clone()))),
                AnchorDigest::Keyed(keyed) => by_anchor.push((
                    anchor.clone(),
                    Out::Map(sorted(keyed).into_iter().map(|(k, v)| (k.clone(), Out::Str(v.clone()))).collect()),
                )),
            }
        }
        out.push((ecosystem.clone(), Out::Map(by_anchor)));
    }
    if let Some(payload) = &layers.payload {
        out.push((PAYLOAD_LAYER.to_string(), Out::Str(payload.clone())));
    }
    Out::Map(out)
}

/// A layer whose digest differs between two readings, or exists in only one.
/// `path` is `[ecosystem, anchor]`, `[ecosystem, anchor, layer]` or `["payload"]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayerChange {
    pub path: Vec<String>,
    pub before: Option<String>,
    pub after: Option<String>,
}

/// Every digest of a reading with its path, in key order.
pub fn layer_digests(layers: &UnitLayers) -> Vec<(Vec<String>, String)> {
    let mut out = Vec::new();
    for (ecosystem, anchors) in sorted(&layers.ecosystems) {
        for (anchor, digest) in sorted(anchors) {
            match digest {
                AnchorDigest::One(digest) => out.push((vec![ecosystem.clone(), anchor.clone()], digest.clone())),
                AnchorDigest::Keyed(keyed) => {
                    for (layer, value) in sorted(keyed) {
                        out.push((vec![ecosystem.clone(), anchor.clone(), layer.clone()], value.clone()));
                    }
                }
            }
        }
    }
    if let Some(payload) = &layers.payload {
        out.push((vec![PAYLOAD_LAYER.to_string()], payload.clone()));
    }
    out
}

/// Every layer on which two readings disagree.
pub fn diff_layers(before: &UnitLayers, after: &UnitLayers) -> Vec<LayerChange> {
    let index = |layers: &UnitLayers| -> IndexMap<String, (Vec<String>, String)> {
        layer_digests(layers).into_iter().map(|(path, digest)| (path.join("\0"), (path, digest))).collect()
    };
    let a = index(before);
    let b = index(after);
    let ids: BTreeSet<&String> = a.keys().chain(b.keys()).collect();
    let mut changes = Vec::new();
    for id in ids {
        let x = a.get(id);
        let y = b.get(id);
        if x.map(|v| &v.1) == y.map(|v| &v.1) {
            continue;
        }
        changes.push(LayerChange {
            path: x.or(y).map(|v| v.0.clone()).unwrap_or_default(),
            before: x.map(|v| v.1.clone()),
            after: y.map(|v| v.1.clone()),
        });
    }
    changes
}
