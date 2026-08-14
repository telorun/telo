//! Per-tag engines, mirroring `../../../nodejs/src/engines/`.
//!
//! The Node package defines a `TemplatingEngine` trait-like interface each
//! engine implements. There is no such abstraction here yet, because this kernel
//! recognises only the tags whose meaning it can honour — so each module carries
//! the part of its engine that both halves must agree on, and nothing more.

pub mod include;
