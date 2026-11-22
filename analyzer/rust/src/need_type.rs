//! A module document's `needs:` block, read for the one position of a document that holds a
//! value the kernel resolves. A PARTIAL twin of `../../nodejs/src/need-type.ts`: only the
//! `parameters:` half of `readNeeds`, `needParametersPaths` and `isAtOrBeneathPath`, which the
//! include-placement pass and the module-file walk read. Owed to `3e-20 need types`, with the
//! need table and the rest of that file.

use serde_json::Value;

/// Each need's name and its `parameters:` value, in written order, for every need `readNeeds`
/// reads — an object naming a non-empty kind — that writes `parameters:`.
pub fn need_parameters(module_doc: &Value) -> Vec<(&str, &Value)> {
    let Some(needs) = module_doc.get("needs").and_then(Value::as_object) else { return Vec::new() };
    needs
        .iter()
        .filter(|(_, need)| need.get("kind").and_then(Value::as_str).is_some_and(|kind| !kind.is_empty()))
        .filter_map(|(name, need)| need.get("parameters").map(|parameters| (name.as_str(), parameters)))
        .collect()
}

/// The dotted path of every `parameters:` a module document's needs write — the one position of
/// a module document holding a value the kernel resolves, whose tags the need table judges.
pub fn need_parameters_paths(module_doc: &Value) -> Vec<String> {
    need_parameters(module_doc).into_iter().map(|(name, _)| format!("needs.{name}.parameters")).collect()
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
