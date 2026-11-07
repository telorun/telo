//! Per-tag engines, mirroring `../../../nodejs/src/engines/`.
//!
//! Each engine implements [`TemplatingEngine`](crate::engine::TemplatingEngine), the
//! contract of `engine.rs`; `builtins.rs` lists them.

pub mod cel;
pub mod hole_analysis;
pub mod include;
pub mod interpolate;
pub mod literal;
pub mod module_path;
pub mod r#ref;
pub mod sql;
