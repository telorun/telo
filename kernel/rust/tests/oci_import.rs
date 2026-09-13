//! A pinned `oci://` import resolved by the kernel from the workspace manifest
//! cache, the location both kernels share.

mod support;

use std::fs;

use support::{regular, tar_gz, Layer, TestRegistry, LEGACY_LAYER};
use telo_analyzer::sources::integrity::sha256_base64url;
use telo_kernel::Kernel;

const EMBEDDING_LIBRARY: &str = "kind: Telo.Library\nmetadata:\n  name: Lib\n  version: 1.0.0\n";
const EMBEDDING_DEFINITION: &str =
    "---\nkind: Telo.Definition\nmetadata:\n  name: Thing\n  description: !include-text NOTICE.txt\ncapability: Telo.Invocable\n";

fn app_importing(dir: &std::path::Path, source: &str) -> std::path::PathBuf {
    let app = dir.join("telo.yaml");
    fs::write(&app, format!("kind: Telo.Application\nmetadata:\n  name: App\nimports:\n  Lib: {source}\n")).unwrap();
    app
}

/// An embed in an imported module reads the file out of the module's own layers,
/// materialized for it, not beside the manifest's registry ref.
#[test]
fn resolves_an_embed_of_an_imported_module_from_its_layers() {
    let registry = TestRegistry::start(false);
    let published = registry.publish(
        "acme/lib",
        "1.0.0",
        EMBEDDING_LIBRARY,
        EMBEDDING_DEFINITION,
        &[Layer {
            role: "common",
            selector: None,
            files: vec![regular("NOTICE.txt", b"MIT\n")],
        }],
    );
    let workspace = tempfile::tempdir().unwrap();
    let app = app_importing(workspace.path(), &published.pinned);

    let mut kernel = Kernel::new();
    kernel.load(app.to_str().unwrap()).expect("the embed resolves from the common layer");

    assert!(registry.requests().iter().any(|path| path.ends_with(&published.blobs[0])), "{:?}", registry.requests());
}

/// A module published before layers has nowhere its files can be read from; that
/// is the error, not a missing file at a path the author never wrote.
#[test]
fn refuses_an_embed_of_a_module_published_without_layers() {
    let registry = TestRegistry::start(false);
    let manifest = format!("{EMBEDDING_LIBRARY}{EMBEDDING_DEFINITION}");
    let blob = registry.push_blob(tar_gz(&[
        regular("telo.yaml", manifest.as_bytes()),
        regular("NOTICE.txt", b"MIT\n"),
    ]));
    registry.push_manifest("acme/lib", "1.0.0", &[(LEGACY_LAYER, &blob)]);
    let workspace = tempfile::tempdir().unwrap();
    let app = app_importing(
        workspace.path(),
        &format!("oci://{}/acme/lib@1.0.0#sha256-{}", registry.host(), sha256_base64url(manifest.as_bytes())),
    );

    let err = Kernel::new().load(app.to_str().unwrap()).expect_err("the embed has no files to read");

    assert_eq!(err.code, "ERR_MODULE_FILES_UNAVAILABLE", "{err}");
}

#[test]
fn resolves_a_pinned_import_from_the_workspace_manifest_cache_with_no_network() {
    let workspace = tempfile::tempdir().unwrap();
    fs::write(workspace.path().join("telo-workspace.yaml"), "modules: []\n").unwrap();
    // A registry that holds nothing: any request reaching it is a cache miss.
    let registry = TestRegistry::start(false);
    let library = "kind: Telo.Library\nmetadata:\n  name: Lib\n  version: 1.0.0\n";
    let cached = workspace
        .path()
        .join(".telo/manifests/oci")
        .join(registry.host())
        .join("acme/lib/1.0.0/telo.yaml");
    fs::create_dir_all(cached.parent().unwrap()).unwrap();
    fs::write(&cached, library).unwrap();
    let app_dir = workspace.path().join("apps/app");
    fs::create_dir_all(&app_dir).unwrap();
    let app = app_dir.join("telo.yaml");
    fs::write(
        &app,
        format!(
            "kind: Telo.Application\nmetadata:\n  name: App\nimports:\n  Lib: oci://{}/acme/lib@1.0.0#sha256-{}\n",
            registry.host(),
            sha256_base64url(library.as_bytes())
        ),
    )
    .unwrap();

    let mut kernel = Kernel::new();
    kernel.load(app.to_str().unwrap()).expect("the cached import resolves");

    assert!(registry.requests().is_empty(), "{:?}", registry.requests());
}
