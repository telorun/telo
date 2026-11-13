//! `telorun-glob` — the Telo glob: a `.gitignore`-style pattern set matched
//! against relative POSIX paths.
//!
//! The twin of `@telorun/glob` (`packages/glob/nodejs`): every file twins the
//! Node file of its name, kebab-case becoming snake_case, and this file twins
//! `index.ts`. The grammar is `packages/glob/conformance/README.md`, and
//! `packages/glob/conformance/glob.json` is run against both halves.

pub mod glob_select;

pub use glob_select::{
    is_pruned, last_match_index, select_by_patterns, SelectOptions, DEFAULT_IGNORE, GLOB_PRUNE_DIRS, HARD_IGNORE,
};
