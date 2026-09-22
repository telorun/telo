//! The `!module-path` tag, mirroring `../../../nodejs/src/engines/module-path.ts`:
//! a file or directory that ships inside the module, named by its location. Its
//! path grammar is `include::normalize_module_path`, beside the embeds' own;
//! resolving it to an absolute path is the kernel's.

/// Engine name for the tag naming a module file or directory, `!module-path`.
pub const MODULE_PATH_ENGINE: &str = "module-path";
