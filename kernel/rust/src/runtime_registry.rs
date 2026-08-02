//! Runtime-label ↔ PURL-type mapping and controller-selection policy.
//! Mirrors `../../nodejs/src/runtime-registry.ts`.
//!
//! The one substantive difference from the Node file: this kernel's native PURL
//! type is `pkg:cargo`, so `runtime: auto` and `runtime: native` prefer the Rust
//! controller here and the Node.js controller there, from the same manifest.

use crate::KernelError;

/// The PURL-type prefix this kernel itself runs.
pub const KERNEL_NATIVE_PURL_TYPE: &str = "pkg:cargo";

/// Wildcard sentinel inside a resolved policy: "all remaining controllers in
/// declaration order, minus PURL types already listed earlier".
pub const POLICY_WILDCARD: &str = "*";

const LABEL_TO_PURL_TYPE: &[(&str, &str)] = &[("nodejs", "pkg:npm"), ("rust", "pkg:cargo")];

const SINGLE_ONLY_LABELS: &[&str] = &["auto", "native"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControllerPolicy {
    pub load: Vec<String>,
}

impl Default for ControllerPolicy {
    /// Equivalent to `runtime: auto` — kernel-native first, then any other
    /// declared controller in declaration order.
    fn default() -> Self {
        Self {
            load: vec![
                KERNEL_NATIVE_PURL_TYPE.to_string(),
                POLICY_WILDCARD.to_string(),
            ],
        }
    }
}

/// Resolve a `runtime:` field value into a canonical policy.
pub fn normalize_runtime(value: Option<&serde_json::Value>) -> Result<ControllerPolicy, KernelError> {
    let Some(value) = value else {
        return Ok(ControllerPolicy::default());
    };
    match value {
        serde_json::Value::String(label) => resolve_single(label),
        serde_json::Value::Array(entries) => {
            if entries.is_empty() {
                return Err(KernelError::runtime_invalid(
                    "runtime: [] has no useful meaning. Omit the field for `auto`, or list at least one runtime label.",
                ));
            }
            let mut load: Vec<String> = Vec::new();
            for (index, entry) in entries.iter().enumerate() {
                let Some(label) = entry.as_str() else {
                    return Err(KernelError::runtime_invalid(
                        "runtime list entries must be strings",
                    ));
                };
                if label == "any" {
                    if index != entries.len() - 1 {
                        return Err(KernelError::runtime_invalid(
                            "runtime: 'any' may only appear as the last entry in the list",
                        ));
                    }
                    load.push(POLICY_WILDCARD.to_string());
                    continue;
                }
                let purl_type = label_to_purl_type(label)?;
                if load.iter().any(|existing| existing == purl_type) {
                    return Err(KernelError::runtime_invalid(format!(
                        "runtime: '{label}' listed twice (resolves to {purl_type})"
                    )));
                }
                load.push(purl_type.to_string());
            }
            Ok(ControllerPolicy { load })
        }
        other => Err(KernelError::runtime_invalid(format!(
            "runtime must be a string or array of strings, got {other}"
        ))),
    }
}

fn resolve_single(label: &str) -> Result<ControllerPolicy, KernelError> {
    match label {
        "auto" => Ok(ControllerPolicy::default()),
        "native" => Ok(ControllerPolicy {
            load: vec![KERNEL_NATIVE_PURL_TYPE.to_string()],
        }),
        "any" => Ok(ControllerPolicy {
            load: vec![POLICY_WILDCARD.to_string()],
        }),
        other => Ok(ControllerPolicy {
            load: vec![label_to_purl_type(other)?.to_string()],
        }),
    }
}

fn label_to_purl_type(label: &str) -> Result<&'static str, KernelError> {
    if SINGLE_ONLY_LABELS.contains(&label) {
        return Err(KernelError::runtime_invalid(format!(
            "runtime label '{label}' describes a whole policy and is only valid as a single value, not inside a list"
        )));
    }
    LABEL_TO_PURL_TYPE
        .iter()
        .find(|(name, _)| *name == label)
        .map(|(_, purl_type)| *purl_type)
        .ok_or_else(|| {
            let mut known: Vec<&str> = LABEL_TO_PURL_TYPE.iter().map(|(name, _)| *name).collect();
            known.extend(["any", "auto", "native"]);
            known.sort_unstable();
            KernelError::runtime_invalid(format!(
                "Unknown runtime label '{label}'. Known: {}",
                known.join(", ")
            ))
        })
}

/// The PURL type of a candidate — everything up to the first `/` after the
/// scheme.
pub fn purl_type(purl: &str) -> &str {
    let scheme_end = match purl.find(':') {
        Some(index) => index + 1,
        None => return purl,
    };
    match purl[scheme_end..].find('/') {
        Some(offset) => &purl[..scheme_end + offset],
        None => purl,
    }
}

/// Apply the policy to a declared candidate list: explicit types in policy
/// order, then — where the wildcard sits — everything not already claimed, in
/// declaration order.
pub fn order_candidates(candidates: &[String], policy: &ControllerPolicy) -> Vec<String> {
    let explicit: Vec<&String> = policy
        .load
        .iter()
        .filter(|entry| *entry != POLICY_WILDCARD)
        .collect();
    let mut result: Vec<String> = Vec::new();

    for entry in &policy.load {
        for candidate in candidates {
            if result.contains(candidate) {
                continue;
            }
            let candidate_type = purl_type(candidate);
            let matches = if entry == POLICY_WILDCARD {
                !explicit.iter().any(|listed| listed.as_str() == candidate_type)
            } else {
                candidate_type == entry
            };
            if matches {
                result.push(candidate.clone());
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidates() -> Vec<String> {
        vec![
            "pkg:telo/local/js?path=./nodejs/x.mjs".to_string(),
            "pkg:cargo/telorun-console?local_path=./rust#writeline_controller".to_string(),
        ]
    }

    #[test]
    fn auto_prefers_the_kernels_own_runtime() {
        let ordered = order_candidates(&candidates(), &ControllerPolicy::default());
        assert!(ordered[0].starts_with("pkg:cargo"), "{ordered:?}");
        assert_eq!(ordered.len(), 2);
    }

    #[test]
    fn a_strict_label_drops_every_other_candidate() {
        let policy = normalize_runtime(Some(&serde_json::json!("rust"))).unwrap();
        let ordered = order_candidates(&candidates(), &policy);
        assert_eq!(ordered.len(), 1);
        assert!(ordered[0].starts_with("pkg:cargo"));
    }

    #[test]
    fn unknown_labels_are_rejected() {
        assert!(normalize_runtime(Some(&serde_json::json!("perl"))).is_err());
        assert!(normalize_runtime(Some(&serde_json::json!([]))).is_err());
    }
}
