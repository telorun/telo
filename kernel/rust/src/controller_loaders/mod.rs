//! Per-scheme controller loaders, picked by PURL type.
//! Mirrors `../../../nodejs/src/controller-loaders/`.

pub mod cargo_loader;
pub mod dylib_loader;
pub mod native_abi;
pub mod purl;
