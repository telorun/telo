//! Helpers shared by the conformance runner and the codec's tests. A subdirectory, because
//! a file directly under `tests/` is an integration test of its own in Cargo's layout.

pub mod cel_conformance_dialect;
pub mod cel_conformance_value;
