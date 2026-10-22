//! A host path a resource holds is refused at creation when it is relative or
//! names the other kind of entry than its slot says — before the kind's
//! controller is built, so neither fixture's controller exists.

use std::path::PathBuf;

use telo_kernel::Kernel;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
}

#[test]
fn refuses_a_relative_host_path() {
    let err = Kernel::new()
        .load(&fixture("host-path-relative").join("telo.yaml").display().to_string())
        .expect_err("load must fail");
    assert_eq!(err.code, "ERR_HOST_PATH_RELATIVE", "{err}");
    assert!(
        err.message.starts_with("HostPathRelative.Store/store: 'data' must be an absolute Telo.HostPath"),
        "{err}"
    );
}

#[test]
fn refuses_a_module_file_of_the_other_kind() {
    let dir = fixture("host-path-entry");
    let err = Kernel::new()
        .load(&dir.join("telo.yaml").display().to_string())
        .expect_err("load must fail");
    assert_eq!(err.code, "ERR_HOST_PATH_ENTRY_MISMATCH", "{err}");
    let notes = std::path::absolute(dir.join("notes.txt")).unwrap();
    assert_eq!(
        err.message,
        format!(
            "HostPathEntry.Store/store: '/root' takes the path of a directory, but '{}' is a file.",
            notes.display()
        )
    );
}
