//! The closed roster, refused by the load's analysis as the Node kernel refuses it: every
//! row of `analyzer/capability-conformance/vectors.json`, declared by an application, is
//! one `ERR_MANIFEST_VALIDATION_FAILED` carrying the row's code and message — and an
//! accepted row raises none. This kernel refuses every `extends:` after the analysis, so an
//! accepted row declaring one is held only to carrying no capability diagnostic.

use telo_kernel::Kernel;

const VECTORS: &str = include_str!("../../../analyzer/capability-conformance/vectors.json");

#[test]
fn answers_every_capability_conformance_vector() {
    let vectors: serde_json::Value = serde_json::from_str(VECTORS).expect("vectors parse");
    for row in vectors["rows"].as_array().expect("rows") {
        let id = row["id"].as_str().expect("id");
        let dir = tempfile::tempdir().expect("temp dir");
        let mut definition = "kind: Telo.Definition\nmetadata: { name: Thing }\n".to_string();
        if let Some(capability) = row.get("capability") {
            definition.push_str(&format!("capability: {capability}\n"));
        }
        if row["extends"].as_bool().expect("extends") {
            definition.push_str("extends: Lib.Base\n");
        }
        let manifest = format!("kind: Telo.Application\nmetadata: {{ name: Roster }}\n---\n{definition}");
        let path = dir.path().join("telo.yaml");
        std::fs::write(&path, manifest).expect("write manifest");

        let answer = Kernel::new().load(&path.display().to_string());
        let capability_findings = |error: &telo_kernel::KernelError| -> Vec<(String, String)> {
            error
                .diagnostics
                .iter()
                .filter(|d| d.code.as_deref().is_some_and(|code| code.starts_with("CAPABILITY_")))
                .map(|d| (d.code.clone().unwrap_or_default(), d.message.clone()))
                .collect()
        };
        match row["code"].as_str() {
            None => {
                if let Err(error) = answer {
                    assert_eq!(capability_findings(&error), vec![], "{id}");
                }
            }
            Some(code) => {
                let Err(error) = answer else { panic!("{id}: loaded") };
                assert_eq!(error.code, "ERR_MANIFEST_VALIDATION_FAILED", "{id}: {error}");
                assert_eq!(error.message, "Manifest validation failed", "{id}");
                let message = format!("Telo.Definition 'Thing': {}", row["message"].as_str().expect("message"));
                assert_eq!(capability_findings(&error), vec![(code.to_string(), message)], "{id}");
            }
        }
    }
}
