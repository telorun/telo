//! The one finishing step of an analysis: every placed finding arrives here and is filtered
//! once. A partial twin of `../../nodejs/src/finishing-pipeline.ts`, holding its cover step — a
//! refusal a finding carries covers, under the written places it is indexed by (a declaration's
//! `cover_key`, a file's `file_cover_key`), every finding it says it covers — with Node's keys
//! and step order. Every finding here holds in the one configuration this analysis judges, so a
//! covered finding is dropped where Node's would hold nowhere.
//!
//! Owed: conditions over configurations and the merge with its labels, the dead-branch place
//! rule and dead branches' worlds, rule settling and the forwarded-duplicate subtraction
//! (3e-19), and the body-entry covers (3d-18). Nothing before them produces what they read.

use std::collections::HashMap;
use std::rc::Rc;

use serde_json::json;

use crate::placement::{CarriedCover, PlacedDiagnostic};
use crate::types::AnalysisDiagnostic;

/// The written declaration a finding is about, as covers index it.
pub fn cover_key(kind: Option<&str>, name: Option<&str>, file_path: Option<&str>) -> String {
    json!([kind, name, file_path]).to_string()
}

/// A written file, as covers index it.
pub fn file_cover_key(file_path: Option<&str>) -> String {
    json!(["file", file_path]).to_string()
}

/// The written declaration `d` is about, as covers index it.
fn own_key(d: &AnalysisDiagnostic) -> String {
    let data = d.data.as_ref();
    let resource = data.and_then(|data| data.resource.as_ref());
    cover_key(
        resource.map(|r| r.kind.as_str()),
        resource.map(|r| r.name.as_str()),
        data.and_then(|data| data.file_path.as_deref()),
    )
}

/// Every finding, finished: each one a refusal some finding carries covers is dropped, and the
/// rest are handed back in order, their provenance stripped.
pub fn finish_findings(findings: Vec<PlacedDiagnostic>) -> Vec<AnalysisDiagnostic> {
    let mut by_declaration: HashMap<String, Vec<Rc<CarriedCover>>> = HashMap::new();
    // A refusal a finding is covers where that finding holds.
    for finding in &findings {
        for each in &finding.provenance.refuses {
            let keys = each.keys.clone().unwrap_or_else(|| vec![own_key(&finding.diagnostic)]);
            for key in keys {
                by_declaration.entry(key).or_default().push(Rc::clone(each));
            }
        }
    }
    findings
        .into_iter()
        .filter(|finding| {
            let file = finding.diagnostic.data.as_ref().and_then(|data| data.file_path.as_deref());
            let covers = [own_key(&finding.diagnostic), file_cover_key(file)];
            !covers
                .iter()
                .filter_map(|key| by_declaration.get(key))
                .flatten()
                .any(|cover| (cover.covers)(&finding.diagnostic, &finding.provenance))
        })
        .map(|finding| finding.diagnostic)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::placement::Provenance;
    use crate::types::DiagnosticData;

    fn finding(code: &str, file: &str, refuses: Vec<Rc<CarriedCover>>) -> PlacedDiagnostic {
        let diagnostic = AnalysisDiagnostic::error(
            code,
            code,
            DiagnosticData { file_path: Some(file.to_string()), ..Default::default() },
        );
        PlacedDiagnostic { diagnostic, provenance: Provenance { file: Some(file.to_string()), refuses } }
    }

    #[test]
    fn drops_what_a_carried_refusal_covers_under_the_places_it_is_indexed_by() {
        let cover = Rc::new(CarriedCover {
            keys: Some(vec![file_cover_key(Some("/lib/telo.yaml"))]),
            covers: Rc::new(|d, provenance| d.code.as_deref() != Some("GATE") && provenance.file.as_deref() == Some("/lib/telo.yaml")),
        });
        let finished = finish_findings(vec![
            finding("GATE", "/lib/telo.yaml", vec![cover]),
            finding("COVERED", "/lib/telo.yaml", Vec::new()),
            finding("ELSEWHERE", "/app/telo.yaml", Vec::new()),
        ]);
        let codes: Vec<_> = finished.iter().map(|d| d.code.as_deref().unwrap()).collect();
        assert_eq!(codes, ["GATE", "ELSEWHERE"]);
    }

    #[test]
    fn indexes_a_cover_naming_no_places_by_its_own_declaration() {
        let cover = Rc::new(CarriedCover { keys: None, covers: Rc::new(|d, _| d.code.as_deref() == Some("SAME")) });
        let finished = finish_findings(vec![
            finding("REFUSAL", "/app/telo.yaml", vec![cover]),
            finding("SAME", "/app/telo.yaml", Vec::new()),
            finding("SAME", "/other/telo.yaml", Vec::new()),
        ]);
        let files: Vec<_> = finished.iter().map(|d| d.data.as_ref().unwrap().file_path.as_deref().unwrap()).collect();
        assert_eq!(files, ["/app/telo.yaml", "/other/telo.yaml"]);
        assert_eq!(cover_key(Some("K"), None, Some("f")), r#"["K",null,"f"]"#);
        assert_eq!(file_cover_key(None), r#"["file",null]"#);
    }
}
