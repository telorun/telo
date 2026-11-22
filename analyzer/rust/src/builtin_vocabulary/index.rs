//! The built-in vocabulary this build implements, byte for byte the `builtins.yaml` the
//! renderer writes beside `../../../nodejs/src/builtin-vocabulary/index.ts`: the `Telo.Builtins`
//! archive of this build's telo. A submodule of `builtin_vocabulary` because the Node half is a
//! directory module beside the reader `builtin-vocabulary.ts`; the archive is generated and never
//! tracked, so `build.rs` refuses a build without it, naming the renderer.

/// The rendered archive, embedded.
pub const BUILTIN_VOCABULARY_ARCHIVE: &str = include_str!("../../../nodejs/src/builtin-vocabulary/builtins.yaml");
