//! What `telo package` writes and a packaged executable carries.
//! Mirrors `../../../nodejs/src/package/`.
//!
//! Only the detection half exists here: this build can tell that an executable carries an
//! application, and cannot read it (`telo check` refuses one — see `manifest_input.rs`).

pub mod app_trailer;
pub mod pe_image;
pub mod pe_resources;
