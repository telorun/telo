//! The planner seam an adapter uses to say a package keeps no static version
//! and why it contributes no layer — the Rust half of `tests/units.test.ts`.

use std::sync::Arc;

use indexmap::IndexMap;
use telorun_release::adapter::{AdapterRegistry, AnchorProbe, EcosystemAdapter, RecognizedPackage, VersionLocationSpec};
use telorun_release::release_settings::{read_release_marker, ReadReleaseOptions};
use telorun_release::shipped_adapters;
use telorun_release::units::{resolve_units, WorkspaceTree};

struct Fake;

impl EcosystemAdapter for Fake {
    fn ecosystem(&self) -> &'static str {
        "fake"
    }
    fn anchor_description(&self) -> &'static str {
        "a directory holding a fake.json"
    }
    fn version_file(&self) -> Option<VersionLocationSpec> {
        Some(VersionLocationSpec { file: "fake.json".into(), pointer: None })
    }
    fn recognize(&self, probe: &AnchorProbe<'_>) -> Option<RecognizedPackage> {
        probe.read_file("fake.json")?;
        Some(RecognizedPackage {
            name: None,
            contributes_layer: false,
            no_layer_reason: Some(format!("fake at `{}` declares no build", probe.anchor)),
            no_static_version: Some(format!("fake at `{}` keeps its version dynamic", probe.anchor)),
            version_files: Vec::new(),
        })
    }
}

struct Tree(IndexMap<String, String>, Vec<String>);

impl WorkspaceTree for Tree {
    fn directories(&self) -> &[String] {
        &self.1
    }
    fn files_under(&self, dir: &str) -> Vec<String> {
        self.0.keys().filter_map(|f| f.strip_prefix(&format!("{dir}/")).map(str::to_string)).collect()
    }
    fn read_file(&self, path: &str) -> Option<String> {
        self.0.get(path).cloned()
    }
}

fn resolve(unit: &str) -> (usize, Vec<(String, String)>, Vec<String>) {
    let mut adapters = shipped_adapters();
    adapters.push(Arc::new(Fake));
    let registry = AdapterRegistry::new(&adapters).expect("registers");
    let read = read_release_marker(&format!("release:\n  units:\n    - {unit}\n"), "telo-workspace.yaml", &adapters, &ReadReleaseOptions::default())
        .expect("reads");
    let files: IndexMap<String, String> =
        [("svc/fake.json", "{}"), ("svc/VERSION", "1.0.0\n")].into_iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    let tree = Tree(files, vec!["svc".to_string()]);
    let resolution = resolve_units(&read.release.expect("release"), &tree, &registry);
    (
        resolution.units.len(),
        resolution.diagnostics.iter().map(|d| (d.code.to_string(), d.message.clone())).collect(),
        resolution.units.iter().flat_map(|u| u.version_locations.iter().map(|l| l.file.clone())).collect(),
    )
}

#[test]
fn a_package_keeping_no_static_version_asks_for_a_declared_one() {
    let (units, diagnostics, _) = resolve("{ path: svc, ecosystem: fake, payload: ['**'] }");
    assert_eq!(units, 0);
    assert_eq!(
        diagnostics,
        vec![(
            "WORKSPACE_UNIT_VERSION_UNRESOLVED".to_string(),
            "Unit 'svc' declares no 'version:' and fake at `.` keeps its version dynamic. Declare 'version: <file>' or 'version: { file, pointer }', naming the file that holds the unit's version.".to_string()
        )]
    );
}

#[test]
fn a_declared_version_resolves_and_the_package_file_is_not_written() {
    let (units, diagnostics, locations) = resolve("{ path: svc, ecosystem: fake, version: VERSION, payload: ['**'] }");
    assert_eq!((units, diagnostics.len()), (1, 0));
    assert_eq!(locations, vec!["svc/VERSION".to_string()]);
}

#[test]
fn the_reason_for_no_layer_is_listed() {
    let (_, diagnostics, _) = resolve("{ path: svc, ecosystem: fake, version: VERSION }");
    assert!(diagnostics[0].1.starts_with("Unit 'svc' ships no layer: fake at `.` declares no build. Declare"));
}
