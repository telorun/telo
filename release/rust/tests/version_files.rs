//! The version-file writers the planner's conformance rows do not drive — the
//! Rust half of the Node package's `tests/version-files.test.ts` for them.

use telorun_release::adapters::cargo::stamp_path_dependency_requirements;

const MANIFEST: &str = "[package]\nname = \"app\"\nversion = \"1.0.0\"\n\n[dependencies]\ncore = { path = \"../core\", version = \"^1.0.0\" }\npinned = { path = \"../core\", version = \">=1, <2\" }\nother = { path = \"../other\", version = \"1.0.0\" }\n\n[target.'cfg(unix)'.build-dependencies.core-build]\npackage = \"core\"\npath = \"../core\"\nversion = \"1.0\"\n";

#[test]
fn a_plain_requirement_on_the_crate_at_the_path_moves_keeping_its_operator() {
    let expected = MANIFEST.replace("version = \"^1.0.0\"", "version = \"^1.1.0-rc.1\"").replace("version = \"1.0\"\n", "version = \"1.1.0-rc.1\"\n");
    assert_eq!(stamp_path_dependency_requirements(MANIFEST, "crates/app", "crates/core", "1.1.0-rc.1"), expected);
}

#[test]
fn a_crate_at_another_path_leaves_the_manifest_unchanged() {
    assert_eq!(stamp_path_dependency_requirements(MANIFEST, "crates/app", "crates/elsewhere", "2.0.0"), MANIFEST);
}
