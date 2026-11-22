//! A module document's `needs:` block, read for the one position of a document that holds a
//! value the kernel resolves. A PARTIAL twin of `../../nodejs/src/need-type.ts`: only
//! `needParametersPaths` and `isAtOrBeneathPath`, which the include-placement pass reads.
//! Owed to `3e-20 need types`, with the need table and the rest of that file.

use serde_json::Value;

/// The dotted path of every `parameters:` a module document's needs write — the one position of
/// a module document holding a value the kernel resolves, whose tags the need table judges.
pub fn need_parameters_paths(module_doc: &Value) -> Vec<String> {
    let Some(needs) = module_doc.get("needs").and_then(Value::as_object) else { return Vec::new() };
    needs
        .iter()
        .filter(|(_, need)| {
            // A need counts when it is an object naming a non-empty kind (`readNeeds`).
            need.get("kind").and_then(Value::as_str).is_some_and(|kind| !kind.is_empty())
                && need.get("parameters").is_some()
        })
        .map(|(name, _)| format!("needs.{name}.parameters"))
        .collect()
}

/// Whether a dotted path lies at or beneath one of `paths`.
pub fn is_at_or_beneath_path(path: &str, paths: &[String]) -> bool {
    paths.iter().any(|p| {
        path == p
            || path.strip_prefix(p.as_str()).is_some_and(|rest| rest.starts_with('.') || rest.starts_with('['))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn names_the_parameters_of_each_readable_need() {
        let doc = json!({ "needs": {
            "dir": { "kind": "Telo.DurableDirectory", "parameters": { "size": "1Gi" } },
            "plain": { "kind": "Telo.PublicUrl" },
            "nokind": { "parameters": {} },
            "text": "x",
        } });
        assert_eq!(need_parameters_paths(&doc), ["needs.dir.parameters"]);
        let paths = need_parameters_paths(&doc);
        assert!(is_at_or_beneath_path("needs.dir.parameters", &paths));
        assert!(is_at_or_beneath_path("needs.dir.parameters.icon", &paths));
        assert!(is_at_or_beneath_path("needs.dir.parameters[0]", &paths));
        assert!(!is_at_or_beneath_path("needs.dir.parametersX", &paths));
    }
}
