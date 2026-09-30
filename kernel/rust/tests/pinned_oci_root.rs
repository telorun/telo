//! `telo run oci://…@<version>#sha256-<pin>`: the root application is read from
//! a registry and verified against its pin before anything is loaded from it.

mod support;

use support::TestRegistry;
use telo_analyzer::sources::integrity::sha256_base64url;
use telo_kernel::Kernel;

const LIBRARY: &str = "kind: Telo.Library\nmetadata:\n  name: Lib\n  version: 1.0.0\n";
const TAMPERED: &str = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/// An application importing a library from the same registry, so whether the
/// load went past the root is visible as a request for the library.
fn publish_app(registry: &TestRegistry) -> (String, String) {
    let library = registry.publish("acme/lib", "1.0.0", LIBRARY, "", &[]).pinned;
    let app = format!(
        "kind: Telo.Application\nmetadata:\n  name: HelloApp\n  version: 0.1.0\nimports:\n  Lib: {library}\n"
    );
    let pinned = registry.publish("demo/hello-app", "0.1.0", &app, "", &[]).pinned;
    (pinned, format!("sha256-{}", sha256_base64url(app.as_bytes())))
}

#[test]
fn loads_a_pinned_root_application() {
    let registry = TestRegistry::start(false);
    let (pinned, _) = publish_app(&registry);

    let mut kernel = Kernel::new();
    kernel.load(&pinned).expect("the pinned root loads");

    assert_eq!(kernel.run_targets().expect("no targets to run"), Vec::<serde_json::Value>::new());
    assert!(
        registry.requests().iter().any(|path| path == "/v2/acme/lib/manifests/1.0.0"),
        "{:?}",
        registry.requests()
    );
}

#[test]
fn refuses_a_root_whose_pin_does_not_match_before_loading_anything_from_it() {
    let registry = TestRegistry::start(false);
    let (pinned, actual) = publish_app(&registry);
    let (base, _) = pinned.split_once('#').unwrap();
    let tampered = format!("{base}#{TAMPERED}");

    let err = Kernel::new().load(&tampered).expect_err("a mismatched pin is refused");

    let message = err.to_string();
    assert!(message.contains(&format!("Integrity check failed for {tampered}")), "{message}");
    assert!(message.contains(&format!("expected {TAMPERED}, got {actual}")), "{message}");
    assert!(
        !registry.requests().iter().any(|path| path.starts_with("/v2/acme/lib/")),
        "{:?}",
        registry.requests()
    );
}
