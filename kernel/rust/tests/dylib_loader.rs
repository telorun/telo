//! `pkg:telo/local/dylib` candidates resolved from a published module's
//! controller layers, fetched from a loopback registry.

mod support;

use serde_json::{json, Value};
use support::{
    build_console_cdylib, console_library, dylib_candidate, host_dylib_selector, regular, write_app,
    Layer, TestRegistry,
};
use telo_kernel::Kernel;

/// The standard library's candidate shape leads — a JS bundle this kernel cannot
/// host, then a crate source a published module does not build — and a candidate
/// stating another controller ABI and one for another host are skipped before
/// their layers are fetched; the host's candidate after them loads its cdylib out
/// of its materialized controller layer.
#[test]
fn loads_the_host_matching_dylib_skipping_candidates_for_another_abi_or_host() {
    let cdylib = std::fs::read(build_console_cdylib()).unwrap();
    let host = host_dylib_selector();
    let mut other_abi = host.clone();
    other_abi["abi"] = json!("telo-999");
    let other_os = if host["os"] == "darwin" { "linux" } else { "darwin" };
    let mut foreign = host.clone();
    foreign["os"] = json!(other_os);

    let entry = "writeline_controller";
    let controllers = [
        "pkg:telo/local/js?path=./nodejs/console.mjs#WritelineController".to_string(),
        "pkg:cargo/telorun-console?local_path=./rust#writeline_controller".to_string(),
        dylib_candidate("./rust/other-abi/console", &other_abi, entry),
        dylib_candidate("./rust/foreign/console", &foreign, entry),
        dylib_candidate("./rust/host/console", &host, entry),
    ];
    let layer = |selector: &Value, path: &str, content: &[u8]| Layer {
        role: "controller",
        selector: Some(selector.clone()),
        files: vec![regular(path, content)],
    };
    let registry = TestRegistry::start(false);
    let (owner, rest) = console_library(&controllers);
    let published = registry.publish(
        "telorun/console",
        "1.0.0",
        &owner,
        &rest,
        &[
            layer(&other_abi, "rust/other-abi/console", b"built against another ABI"),
            layer(&foreign, "rust/foreign/console", b"built for another host"),
            layer(&host, "rust/host/console", &cdylib),
        ],
    );
    let app_dir = tempfile::tempdir().unwrap();
    let app = write_app(app_dir.path(), &published.pinned);

    let mut kernel = Kernel::new();
    kernel.load(app.to_str().unwrap()).expect("the published module loads");
    let results = kernel.run_targets().expect("targets run");

    assert_eq!(results, vec![json!("Hello from Telo!")]);
    let requested = registry.requests();
    let fetched = |blob: &str| requested.iter().any(|path| path.ends_with(blob));
    assert!(!fetched(&published.blobs[0]), "the other-ABI layer was fetched: {requested:?}");
    assert!(!fetched(&published.blobs[1]), "the foreign layer was fetched: {requested:?}");
    assert!(fetched(&published.blobs[2]), "{requested:?}");
}
