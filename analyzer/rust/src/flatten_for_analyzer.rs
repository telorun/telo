//! The flattening of a loaded graph into the analyzer's one set of documents. A PARTIAL twin of
//! `../../nodejs/src/flatten-for-analyzer.ts`: only `stampedNeedParametersPaths`, which the
//! include-placement pass reads. Owed to `3b-6 registry and definitions`, with the flatten itself.
//!
//! The Rust loader writes no `metadata.requiredNeeds` stamp yet, so this finds none and can only
//! under-report: the stamp's copies of a need's parameters are the need table's to judge, and
//! the placement pass leaves them to it.

use serde_json::Value;

/// The dotted path of every `parameters:` the `metadata.requiredNeeds` stamp on an import
/// carries — the target's own, copied, never authored here.
pub fn stamped_need_parameters_paths(manifest: &Value) -> Vec<String> {
    let Some(stamp) = manifest.get("metadata").and_then(|metadata| metadata.get("requiredNeeds")).and_then(Value::as_object)
    else {
        return Vec::new();
    };
    stamp
        .iter()
        .filter(|(_, need)| need.get("parameters").is_some())
        .map(|(name, _)| format!("metadata.requiredNeeds.{name}.parameters"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn names_each_stamped_needs_parameters() {
        let import = json!({ "metadata": { "requiredNeeds": { "dir": { "parameters": {} }, "plain": {} } } });
        assert_eq!(stamped_need_parameters_paths(&import), ["metadata.requiredNeeds.dir.parameters"]);
        assert!(stamped_need_parameters_paths(&json!({ "metadata": {} })).is_empty());
    }
}
