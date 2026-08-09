//! End-to-end: the kernel loads a manifest, imports an unmodified
//! standard-library module, builds and dlopens its Rust controller, and
//! dispatches one invocation through the contract.

use std::path::PathBuf;

use telo_kernel::Kernel;

fn fixture(name: &str) -> String {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
        .join("telo.yaml")
        .display()
        .to_string()
}

#[test]
fn runs_the_hello_world_manifest() {
    let mut kernel = Kernel::new();
    kernel.load(&fixture("hello-world")).expect("manifest loads");
    let results = kernel.run_targets().expect("targets run");

    // `console.WriteLine` returns the unrendered text, so the result proves the
    // Rust controller ran rather than merely that nothing failed.
    assert_eq!(results, vec![serde_json::json!("Hello from Telo!")]);
}

/// A field this kernel does not implement must stop the load, not be dropped.
/// The fixture is a manifest the Node kernel runs happily — the disagreement is
/// the point, and it has to be loud.
#[test]
fn refuses_a_manifest_using_a_feature_it_does_not_implement() {
    let mut kernel = Kernel::new();
    let err = kernel
        .load(&fixture("unsupported-variables"))
        .expect_err("load must fail");
    assert_eq!(err.code, "ERR_UNSUPPORTED_MANIFEST_FEATURE", "{err}");
    assert!(err.message.contains("variables"), "{err}");
}

#[test]
fn reports_a_kind_whose_controller_this_kernel_cannot_host() {
    let mut kernel = Kernel::new();
    let err = kernel
        .load(&fixture("javascript-only-kind"))
        .expect_err("load must fail");
    // The module itself loaded — the failure is scoped to the one kind that has
    // no Rust controller, which is what deferred resolution buys.
    assert_eq!(err.code, "ERR_CONTROLLER_NOT_FOUND", "{err}");
    assert!(err.message.contains("Console.WriteStream"), "{err}");
}
