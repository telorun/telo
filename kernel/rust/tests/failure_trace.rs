//! A failure leaving a dispatch carries the frames of the target and the caller
//! (`kernel/specs/invocation-contract.md` §5.5), and no host stack for a structured refusal.

use std::path::PathBuf;

use telo_kernel::Kernel;

#[test]
fn a_structured_refusal_carries_frames_and_no_host_stack() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/failure-trace/telo.yaml")
        .display()
        .to_string();
    let mut kernel = Kernel::new();
    kernel.load(&manifest).expect("manifest loads");
    let err = kernel.run_targets().expect_err("the input is refused");

    assert_eq!(err.code, "ERR_INPUT_INVALID", "{err}");
    let frames: Vec<(&str, &str)> = err
        .trace
        .frames
        .iter()
        .map(|frame| (frame.kind.as_str(), frame.name.as_str()))
        .collect();
    assert_eq!(frames, vec![("Console.WriteLine", "writeLine"), ("Telo.Application", "FailureTrace")]);
    assert!(err.trace.frames.iter().all(|frame| frame.module.is_some() && frame.pointer.is_none()));
    assert_eq!(err.host_stack, None);
}
