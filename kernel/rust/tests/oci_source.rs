//! The OCI manifest source and layer fetch against a loopback registry.

mod support;

use support::{regular, tar_gz, Layer, TestRegistry, LEGACY_LAYER};
use telo_analyzer::{parse_loaded_file, ManifestSource};
use telo_kernel::bundle::files_integrity::PayloadFile;
use telo_kernel::bundle::module_artifact::LayerFetcher;
use telo_kernel::bundle::module_manifest::read_owner_manifest;
use telo_kernel::manifest_sources::oci_source::OciSource;

const LIBRARY: &str = "kind: Telo.Library\nmetadata:\n  name: S3\n  version: 1.2.0\n";

#[test]
fn resolves_a_pinned_manifest_through_the_anonymous_bearer_challenge() {
    let registry = TestRegistry::start(true);
    let pinned = registry.publish("aws/telo-s3", "1.2.0", LIBRARY, "", &[]).pinned;

    let read = OciSource::default().read(&pinned).expect("pinned read");

    assert_eq!(read.text, LIBRARY);
    assert_eq!(read.source, format!("oci://{}/aws/telo-s3@1.2.0", registry.host()));
    assert!(registry.token_requests() > 0);
}

#[test]
fn refuses_a_manifest_whose_pin_does_not_match() {
    let registry = TestRegistry::start(false);
    let pinned = registry.publish("aws/telo-s3", "1.2.0", LIBRARY, "", &[]).pinned;
    let (base, _) = pinned.split_once('#').unwrap();

    let err = OciSource::default()
        .read(&format!("{base}#sha256-deadbeefdeadbeefdeadbeefdeadbeef"))
        .err()
        .expect("a mismatched pin is refused");

    assert!(err.to_string().contains("Integrity check failed for"), "{err}");
}

/// Every module published before layers is one blob carrying `telo.yaml` and its
/// whole payload; the read path wants only `telo.yaml`, which that blob has.
#[test]
fn reads_the_manifest_out_of_a_pre_layers_single_blob_artifact() {
    let registry = TestRegistry::start(false);
    let blob = registry.push_blob(tar_gz(&[
        regular("telo.yaml", LIBRARY.as_bytes()),
        regular("public/index.html", b"<h1>hi</h1>"),
    ]));
    registry.push_manifest("aws/telo-s3", "1.2.0", &[(LEGACY_LAYER, &blob)]);
    let reference = format!("oci://{}/aws/telo-s3@1.2.0", registry.host());

    let read = OciSource::default().read(&reference).expect("legacy read");

    assert_eq!(read.text, LIBRARY);
    let loaded = parse_loaded_file(&read.source, &reference, &read.text);
    assert!(read_owner_manifest(loaded.documents()).unwrap().layers.is_none());
}

#[test]
fn fetches_a_layer_by_its_blob_digest_and_refuses_other_bytes() {
    let registry = TestRegistry::start(false);
    let files = vec![
        PayloadFile::Regular {
            name: "native/tool".into(),
            content: b"#!/bin/sh\n".to_vec(),
            executable: true,
        },
        regular("native/libx.so.1.2", b"elf"),
        PayloadFile::Link {
            name: "native/libx.so".into(),
            link: "libx.so.1.2".into(),
        },
    ];
    let published = registry.publish(
        "aws/telo-s3",
        "1.2.0",
        LIBRARY,
        "",
        &[Layer {
            role: "common",
            selector: None,
            files: files.clone(),
        }],
    );
    let (pinned, blob) = (&published.pinned, &published.blobs[0]);
    let source = OciSource::default();

    assert_eq!(source.fetch_layer(pinned, blob).expect("honest fetch"), files);

    registry.tamper_blob(blob, tar_gz(&[regular("native/libx.so.1.2", b"not elf")]));
    let err = source.fetch_layer(pinned, blob).expect_err("other bytes are refused");
    assert_eq!(err.code, "ERR_MODULE_LAYER_INTEGRITY", "{err}");
    assert!(err.message.contains("Blob digest mismatch"), "{err}");
}

/// Registries answer a blob pull with a redirect to storage. The client follows
/// it itself — so the egress policy can judge the hop — and never hands the
/// registry's bearer token to the storage host.
#[test]
fn follows_a_blob_redirect_without_forwarding_the_token() {
    let registry = TestRegistry::start(true);
    let files = vec![regular("a.txt", b"a")];
    let published = registry.publish(
        "aws/telo-s3",
        "1.2.0",
        LIBRARY,
        "",
        &[Layer {
            role: "common",
            selector: None,
            files: files.clone(),
        }],
    );
    let blob = &published.blobs[0];
    registry.redirect(&format!("/v2/aws/telo-s3/blobs/{blob}"), &format!("/storage/{blob}"));

    let fetched = OciSource::default()
        .fetch_layer(&published.pinned, blob)
        .expect("the redirected blob is fetched");

    assert_eq!(fetched, files);
    let storage = format!("/storage/{blob}");
    assert!(registry.requests().contains(&storage), "{:?}", registry.requests());
    assert!(!registry.authorized_requests().contains(&storage), "{:?}", registry.authorized_requests());
}

/// A redirect to plain HTTP on a host that is not this machine is refused before
/// any request goes to it.
#[test]
fn refuses_a_redirect_to_plain_http_off_loopback() {
    let registry = TestRegistry::start(false);
    let published = registry.publish(
        "aws/telo-s3",
        "1.2.0",
        LIBRARY,
        "",
        &[Layer {
            role: "common",
            selector: None,
            files: vec![regular("a.txt", b"a")],
        }],
    );
    let blob = &published.blobs[0];
    registry.redirect(&format!("/v2/aws/telo-s3/blobs/{blob}"), "http://registry.example/storage/x");

    let err = OciSource::default()
        .fetch_layer(&published.pinned, blob)
        .expect_err("a plain-HTTP hop is refused");

    assert!(err.message.contains("which is not HTTPS"), "{err}");
}

/// A 401 whose token could not be obtained says what the token service answered.
#[test]
fn reports_why_no_token_was_obtained() {
    let registry = TestRegistry::start(true);
    let pinned = registry.publish("aws/telo-s3", "1.2.0", LIBRARY, "", &[]).pinned;
    registry.redirect("/token", "/no-token-service");

    let err = OciSource::default().read(&pinned).err().expect("an unauthenticated pull is refused");

    let message = err.to_string();
    assert!(message.contains("no anonymous token was obtained"), "{message}");
    assert!(message.contains("answered 404"), "{message}");
}
