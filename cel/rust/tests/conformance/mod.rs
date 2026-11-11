//! The CEL conformance drivers, shared by the runners beside this directory — the twin of
//! drivers of `cel/nodejs/conformance/`, file for file (`emitter-identity.ts` has no twin,
//! this engine having no emitter; the runners sit one level up). This file is the one with
//! no Node twin: it is how Rust's integration tests share code across runners.
//!
//! - `conformance_value.rs` — `conformance-value.ts`
//! - `conformance_error.rs` — `conformance-error.ts`
//! - `language_replay.rs`   — `language-replay.ts`
//! - `dialect_replay.rs`    — `dialect-replay.ts`

pub mod conformance_error;
pub mod conformance_value;
pub mod dialect_replay;
pub mod language_replay;
