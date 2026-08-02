//! `telo-rs run <manifest>`.
//! Mirrors `../../../nodejs/src/commands/run.ts`.
//!
//! Prints nothing on success: output is the manifest's business, and a target
//! that should be seen invokes something that writes.

use telo_kernel::{Kernel, KernelError};

pub fn run(manifest: &str) -> Result<(), KernelError> {
    let mut kernel = Kernel::new();
    kernel.load(manifest)?;
    kernel.run_targets()?;
    Ok(())
}
