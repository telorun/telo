//! Native Rust controllers for `std/console`.
//!
//! One module per controller, matching the `nodejs/src/*-controller.ts` layout;
//! the module name is the `#fragment` a `pkg:cargo` PURL selects.
//!
//! `WriteLine`, `Write` and `ReadLine` are ported (`Write` for text only — see
//! its module). `WriteStream` and `StreamWait` remain JavaScript-only: they
//! carry `Telo.Stream` inputs and the Rust SDK has no stream contract yet.

mod markup;
pub mod readline_controller;
pub mod write_controller;
pub mod writeline_controller;

pub use readline_controller::ReadLine;
pub use write_controller::Write;
pub use writeline_controller::WriteLine;
