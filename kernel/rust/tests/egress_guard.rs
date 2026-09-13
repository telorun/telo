//! `TELO_EGRESS=public-only` refuses a loopback registry before any request.
//!
//! Its own test binary, because the policy is read from the process
//! environment and no other test may observe it set.

mod support;

use support::TestRegistry;
use telo_analyzer::ManifestSource;
use telo_kernel::manifest_sources::oci_source::OciSource;

#[test]
fn public_only_egress_refuses_a_loopback_registry() {
    let registry = TestRegistry::start(false);
    let library = "kind: Telo.Library\nmetadata:\n  name: S3\n  version: 1.2.0\n";
    let pinned = registry.publish("aws/telo-s3", "1.2.0", library, "", &[]).pinned;
    std::env::set_var("TELO_EGRESS", "public-only");

    let err = OciSource::default()
        .read(&pinned)
        .err()
        .expect("a loopback registry is refused");

    assert!(err.to_string().contains("Egress to '127.0.0.1' denied"), "{err}");
    assert!(registry.requests().is_empty(), "{:?}", registry.requests());
}
