//! The **selector** of `kernel/specs/module-artifact.md` — the tuple a bundled
//! controller candidate is chosen by, and the key a layer of a module artifact
//! is stored under. Mirrors `../../nodejs/src/artifact-selector.ts`.
//!
//! A selector is `format` plus the optional platform axes. Matching is one rule,
//! applied per axis: an axis the selector omits accepts anything, an axis it
//! states must be equal.
//!
//! The axis vocabulary is data (`analyzer/artifact-axes/axes.json`). Node
//! generates `artifact-axes.ts` from it; this file hand-writes [`PlatformAxis`]
//! instead — no Cargo build script exists in this repository to add one for four
//! names — and a test reads the same JSON and fails on any divergence in the
//! axis names, their order, or an axis's value form. The Rust and Node halves
//! also run one shared vector file (`analyzer/artifact-axes/layer-index-vectors.json`).
//!
//! PURL syntax is not parsed here: callers hand in a format and a decoded
//! qualifier map, exactly as in Node.

use std::collections::HashMap;

use serde_json::Value;

/// The role a layer plays in a module artifact.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LayerRole {
    Controller,
    Library,
    Native,
    Assets,
    Common,
}

impl LayerRole {
    pub const ALL: [LayerRole; 5] = [
        LayerRole::Controller,
        LayerRole::Library,
        LayerRole::Native,
        LayerRole::Assets,
        LayerRole::Common,
    ];

    pub fn name(self) -> &'static str {
        match self {
            LayerRole::Controller => "controller",
            LayerRole::Library => "library",
            LayerRole::Native => "native",
            LayerRole::Assets => "assets",
            LayerRole::Common => "common",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|role| role.name() == name)
    }

    /// `controller`, `library` and `native` are keyed by a selector, one layer
    /// per selector; `assets` and `common` are singletons.
    pub fn carries_selector(self) -> bool {
        matches!(self, LayerRole::Controller | LayerRole::Library | LayerRole::Native)
    }
}

/// A form an axis value must take beyond the shared token grammar.
#[derive(Debug)]
pub struct AxisValueForm {
    /// The pattern as `axes.json` spells it — compared verbatim by the test that
    /// keeps [`AxisValueForm::accepts`] honest.
    pub pattern: &'static str,
    /// The form as a reader writes it, e.g. `<family>-<version>`.
    pub form: &'static str,
    pub examples: &'static [&'static str],
    accepts: fn(&str) -> bool,
}

impl AxisValueForm {
    pub fn accepts(&self, value: &str) -> bool {
        (self.accepts)(value)
    }
}

/// `^[a-z][a-z0-9_]*-[0-9]+(\.[0-9]+)*$`, hand-matched: the family cannot hold a
/// `-`, so the first one separates it from a dotted run of digits.
fn is_family_version(value: &str) -> bool {
    let Some((family, version)) = value.split_once('-') else {
        return false;
    };
    let mut family_chars = family.chars();
    let family_ok = family_chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && family_chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
    family_ok
        && version
            .split('.')
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
}

static ABI_VALUE_FORM: AxisValueForm = AxisValueForm {
    pattern: "^[a-z][a-z0-9_]*-[0-9]+(\\.[0-9]+)*$",
    form: "<family>-<version>",
    examples: &["node-137", "telo-3"],
    accepts: is_family_version,
};

/// The selector platform axes, in canonical order. Closed as a set of axis
/// names; the set of values stays open. ORDER IS PART OF THE CONTRACT: a new
/// axis is appended, never inserted.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PlatformAxis {
    Os,
    Arch,
    Libc,
    Abi,
}

pub const AXIS_COUNT: usize = 4;

impl PlatformAxis {
    pub const ALL: [PlatformAxis; AXIS_COUNT] = [
        PlatformAxis::Os,
        PlatformAxis::Arch,
        PlatformAxis::Libc,
        PlatformAxis::Abi,
    ];

    pub fn name(self) -> &'static str {
        match self {
            PlatformAxis::Os => "os",
            PlatformAxis::Arch => "arch",
            PlatformAxis::Libc => "libc",
            PlatformAxis::Abi => "abi",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|axis| axis.name() == name)
    }

    pub fn value_form(self) -> Option<&'static AxisValueForm> {
        match self {
            PlatformAxis::Abi => Some(&ABI_VALUE_FORM),
            PlatformAxis::Os | PlatformAxis::Arch | PlatformAxis::Libc => None,
        }
    }

    fn index(self) -> usize {
        self as usize
    }
}

/// A value per platform axis, absent where undetermined or unconstrained.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct AxisValues([Option<String>; AXIS_COUNT]);

impl AxisValues {
    pub fn get(&self, axis: PlatformAxis) -> Option<&str> {
        self.0[axis.index()].as_deref()
    }

    pub fn set(&mut self, axis: PlatformAxis, value: Option<String>) {
        self.0[axis.index()] = value;
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ArtifactSelector {
    /// The PURL name segment of a bundled candidate (`js`, `napi`, `dylib`, …).
    pub format: String,
    pub axes: AxisValues,
}

/// What a selector is matched against: the host a kernel runs on. An axis left
/// undetermined matches no selector that constrains it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PlatformTarget {
    pub format: Option<String>,
    pub axes: AxisValues,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{detail}")]
pub struct ArtifactSelectorError {
    pub detail: String,
}

impl ArtifactSelectorError {
    pub const CODE: &'static str = "INVALID_ARTIFACT_SELECTOR";

    fn new(detail: String) -> Self {
        Self { detail }
    }
}

/// A raw selector value: absent, or a JSON value of any type. Qualifier strings
/// arrive as `Value::String`, so both readers share one normalizer.
type RawValue<'a> = Option<&'a Value>;

/// JavaScript's `typeof`, which the Node half phrases these errors with.
fn js_typeof(raw: RawValue<'_>) -> &'static str {
    match raw {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_) | Value::Object(_)) => "object",
    }
}

fn is_token(value: &str) -> bool {
    let mut chars = value.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '.' | '-'))
}

/// Validate and normalize one selector value: the shared token grammar, plus the
/// axis's own value form where the vocabulary declares one.
pub fn normalize_axis_value(
    axis: &str,
    raw: Option<&Value>,
    describe: &str,
) -> Result<String, ArtifactSelectorError> {
    let Some(Value::String(raw)) = raw else {
        return Err(ArtifactSelectorError::new(format!(
            "{describe}: {axis} must be a string, got {}.",
            js_typeof(raw)
        )));
    };
    let value = raw.trim().to_lowercase();
    if !is_token(&value) {
        return Err(ArtifactSelectorError::new(format!(
            "{describe}: {axis} value '{raw}' is not a canonical token. \
             Use lowercase letters, digits, '.', '-' or '_', starting with a letter or digit."
        )));
    }
    if let Some(form) = PlatformAxis::from_name(axis).and_then(PlatformAxis::value_form) {
        if !form.accepts(&value) {
            let examples: Vec<String> = form.examples.iter().map(|e| format!("'{e}'")).collect();
            return Err(ArtifactSelectorError::new(format!(
                "{describe}: {axis} value '{raw}' must have the form {}, e.g. {}.",
                form.form,
                examples.join(" or ")
            )));
        }
    }
    Ok(value)
}

fn build_selector(
    format: RawValue<'_>,
    axis_value: impl Fn(PlatformAxis) -> Option<Value>,
    describe: &str,
) -> Result<ArtifactSelector, ArtifactSelectorError> {
    let mut selector = ArtifactSelector {
        format: normalize_axis_value("format", format, describe)?,
        axes: AxisValues::default(),
    };
    for axis in PlatformAxis::ALL {
        let raw = axis_value(axis);
        if matches!(&raw, Some(Value::String(s)) if s.is_empty()) || raw.is_none() {
            continue;
        }
        selector
            .axes
            .set(axis, Some(normalize_axis_value(axis.name(), raw.as_ref(), describe)?));
    }
    Ok(selector)
}

/// Build a selector from a controller candidate's format and decoded qualifier
/// map. Qualifier keys other than the platform axes are ignored — `path` and
/// `local_path` live in the same map and are not part of the selector.
pub fn selector_from_qualifiers(
    format: &str,
    qualifiers: &HashMap<String, String>,
    describe: &str,
) -> Result<ArtifactSelector, ArtifactSelectorError> {
    let format = Value::String(format.to_string());
    build_selector(
        Some(&format),
        |axis| qualifiers.get(axis.name()).cloned().map(Value::String),
        describe,
    )
}

/// Validate and normalize a selector read off a published layer index.
///
/// `Ok(None)` when the selector carries an axis this runtime does not know: the
/// layer is for a newer runtime, and the caller skips it whole. The unknown axis
/// is never dropped. The known axes are still validated.
pub fn normalize_selector(
    value: &Value,
    describe: &str,
) -> Result<Option<ArtifactSelector>, ArtifactSelectorError> {
    let Value::Object(record) = value else {
        return Err(ArtifactSelectorError::new(format!(
            "{describe}: expected an object of selector axes."
        )));
    };
    let selector = build_selector(
        record.get("format"),
        |axis| record.get(axis.name()).cloned(),
        describe,
    )?;
    let carries_unknown_axis = record
        .keys()
        .any(|key| key != "format" && PlatformAxis::from_name(key).is_none());
    Ok((!carries_unknown_axis).then_some(selector))
}

/// The canonical key: sorted `axis=value` pairs joined by `;`.
pub fn selector_key(selector: &ArtifactSelector) -> String {
    let mut pairs = vec![format!("format={}", selector.format)];
    for axis in PlatformAxis::ALL {
        if let Some(value) = selector.axes.get(axis) {
            pairs.push(format!("{}={value}", axis.name()));
        }
    }
    pairs.sort();
    pairs.join(";")
}

/// Human-facing rendering for diagnostics.
pub fn describe_selector(selector: &ArtifactSelector) -> String {
    let platform: Vec<&str> = PlatformAxis::ALL
        .into_iter()
        .filter_map(|axis| selector.axes.get(axis))
        .collect();
    if platform.is_empty() {
        selector.format.clone()
    } else {
        format!("{} ({})", selector.format, platform.join("/"))
    }
}

/// The matching rule: every axis the selector states must equal the target's;
/// every axis it omits accepts anything.
pub fn selector_matches(selector: &ArtifactSelector, target: &PlatformTarget) -> bool {
    if let Some(format) = &target.format {
        if &selector.format != format {
            return false;
        }
    }
    PlatformAxis::ALL.into_iter().all(|axis| match selector.axes.get(axis) {
        None => true,
        Some(constraint) => target.axes.get(axis) == Some(constraint),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The vocabulary is `axes.json`; this enum restates it, so every property
    /// the JSON declares is compared here and a divergence fails the build's tests.
    #[test]
    fn axes_agree_with_the_shared_vocabulary() {
        let axes: Value =
            serde_json::from_str(include_str!("../../artifact-axes/axes.json")).expect("axes.json");
        let entries = axes.as_array().expect("axes.json is an array");

        let names: Vec<&str> = entries.iter().map(|e| e["name"].as_str().unwrap()).collect();
        let ours: Vec<&str> = PlatformAxis::ALL.iter().map(|a| a.name()).collect();
        assert_eq!(ours, names, "axis names or their order diverge from axes.json");

        for (axis, entry) in PlatformAxis::ALL.into_iter().zip(entries) {
            match (axis.value_form(), entry.get("valueForm")) {
                (None, None) => {}
                (Some(form), Some(declared)) => {
                    assert_eq!(form.pattern, declared["pattern"], "{} pattern", axis.name());
                    assert_eq!(form.form, declared["form"], "{} form", axis.name());
                    let examples: Vec<&str> = declared["examples"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|e| e.as_str().unwrap())
                        .collect();
                    assert_eq!(form.examples, examples.as_slice(), "{} examples", axis.name());
                    for example in form.examples {
                        assert!(form.accepts(example), "{} rejects its own example {example}", axis.name());
                    }
                }
                (ours, declared) => panic!(
                    "axis '{}': value form presence diverges (rust: {}, axes.json: {})",
                    axis.name(),
                    ours.is_some(),
                    declared.is_some()
                ),
            }
        }
    }
}
