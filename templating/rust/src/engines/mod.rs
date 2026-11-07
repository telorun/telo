//! Per-tag engines, mirroring `../../../nodejs/src/engines/`.
//!
//! Each engine implements [`TemplatingEngine`](crate::engine::TemplatingEngine), the
//! contract of `engine.rs`. `ref`, `include` and `module_path` carry, for now, the part of
//! their engine both halves must agree on — their grammars.

pub mod cel;
pub mod include;
pub mod module_path;
pub mod r#ref;
