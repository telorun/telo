//! Native Rust controllers for `std/console`.
//!
//! One module per controller, matching the `nodejs/src/*-controller.ts` layout;
//! the module name is the `#fragment` a `pkg:cargo` PURL selects.
//!
//! `WriteLine` and `ReadLine` are ported. `WriteStream` and `StreamWait` remain
//! JavaScript-only: they carry `x-telo-stream` inputs and the Rust SDK has no
//! stream contract yet.

mod markup;
pub mod readline_controller;
pub mod writeline_controller;

pub use readline_controller::ReadLine;
pub use writeline_controller::WriteLine;
