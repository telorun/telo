//! One finding, one identity across analyses; one defect, one identity across the places it
//! is reported at. Mirrors `../../nodejs/src/diagnostic-identity.ts`.

use std::collections::HashSet;

use serde_json::json;

use crate::types::{AnalysisDiagnostic, WrittenAt};

/// A diagnostic's identity: its code, its place (resource, file, path, range) and its message.
/// Two diagnostics with one identity report one defect, so a host combining several analyses —
/// `telo check app app/screens` — reports it once.
pub fn diagnostic_identity(d: &AnalysisDiagnostic) -> String {
    let data = d.data.as_ref();
    let resource = data.and_then(|data| data.resource.as_ref());
    json!([
        d.code,
        resource.map(|r| &r.kind),
        resource.map(|r| &r.name),
        data.and_then(|data| data.file_path.as_ref()),
        data.and_then(|data| data.path.as_ref()),
        d.range,
        d.message,
    ])
    .to_string()
}

/// Where the defect `d` reports is written: the place an import-anchored finding carries as
/// `data.writtenAt`, else `d`'s own place.
pub fn written_place_of(d: &AnalysisDiagnostic) -> WrittenAt {
    match d.data.as_ref() {
        Some(data) => data.written_at.clone().unwrap_or_else(|| WrittenAt::of(data)),
        None => WrittenAt::default(),
    }
}

/// A defect's identity: its code and where it is written. A finding re-reported at the import
/// reaching the module writing it and that module's own finding share one, though their
/// messages and places differ — what lets one cover the other.
pub fn defect_identity(d: &AnalysisDiagnostic) -> String {
    let at = written_place_of(d);
    json!([
        d.code,
        at.resource.as_ref().map(|r| &r.kind),
        at.resource.as_ref().map(|r| &r.name),
        at.file_path,
        at.path,
    ])
    .to_string()
}

/// Every diagnostic of `lists`, in the order each identity first appears, each identity once.
pub fn union_diagnostics(lists: &[&[AnalysisDiagnostic]]) -> Vec<AnalysisDiagnostic> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for list in lists {
        for d in *list {
            if seen.insert(diagnostic_identity(d)) {
                out.push(d.clone());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{DiagnosticData, DiagnosticResource};

    fn at(file: &str, path: &str, written: Option<WrittenAt>) -> AnalysisDiagnostic {
        AnalysisDiagnostic::error(
            "CAPABILITY_UNKNOWN",
            format!("at {file}"),
            DiagnosticData {
                resource: Some(DiagnosticResource { kind: "Telo.Definition".into(), name: "Greeter".into() }),
                file_path: Some(file.into()),
                path: Some(path.into()),
                written_at: written,
                ..Default::default()
            },
        )
    }

    #[test]
    fn a_re_report_and_the_finding_it_re_reports_are_one_defect_of_two_identities() {
        let own = at("/lib/telo.yaml", "capability", None);
        let written = WrittenAt::of(own.data.as_ref().unwrap());
        let re_report = AnalysisDiagnostic::error(
            "CAPABILITY_UNKNOWN",
            "Imported library 'Lib', reached through import 'Lib': at /lib/telo.yaml",
            DiagnosticData {
                file_path: Some("/app/telo.yaml".into()),
                path: Some("imports.Lib".into()),
                written_at: Some(written),
                ..Default::default()
            },
        );
        assert_eq!(defect_identity(&own), defect_identity(&re_report));
        assert_ne!(diagnostic_identity(&own), diagnostic_identity(&re_report));
    }

    #[test]
    fn a_union_keeps_each_identity_once_in_first_appearance_order() {
        let a = at("/a.yaml", "x", None);
        let b = at("/b.yaml", "y", None);
        let union = union_diagnostics(&[&[a.clone(), b.clone()], &[b.clone(), a.clone()]]);
        assert_eq!(union, [a, b]);
    }
}
