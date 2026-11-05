//! The kernel half of a failure's trace (`kernel/specs/invocation-contract.md` §5.5):
//! the frames a dispatch exit adds. Mirrors `../../nodejs/src/failure-trace.ts`.
//!
//! Debt (stated in §5.5): frames carry `kind`, `name` and `module` only — no pointer,
//! no position — and `calledAt` is not read, so the caller's frame has no pointer.

use telorun_sdk_core::FailureFrame;

use crate::error::KernelError;
use crate::evaluation_context::ResourceInstance;

/// A resource as a frame names it.
pub fn frame_of_instance(instance: &ResourceInstance) -> FailureFrame {
    FailureFrame::new(&instance.kind, &instance.name, Some(instance.module.clone()))
}

/// What a failure leaving a dispatch gains: the target's frame when it has no trace
/// yet, and always the caller's.
pub fn record_dispatch_exit(err: &mut KernelError, target: &ResourceInstance, caller: Option<&FailureFrame>) {
    if err.trace.is_empty() {
        err.trace.append(|| frame_of_instance(target));
    }
    if let Some(caller) = caller {
        err.trace.append(|| caller.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hundred_deep_self_dispatch_keeps_sixty_four_frames_and_counts_the_cut() {
        let mut err = KernelError::new("X", "m");
        let caller = FailureFrame::new("Lib.K", "caller", None);
        for _ in 0..100 {
            err.trace.append(|| caller.clone());
        }
        assert_eq!(err.trace.frames.len(), 64);
        assert_eq!(err.trace.dropped_frames_count, 36);
    }
}
