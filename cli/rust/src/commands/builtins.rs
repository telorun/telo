//! `telo builtins [<name>…]`.
//! Mirrors `../../../nodejs/src/commands/builtins.ts`.
//!
//! The built-in vocabulary of the telo this binary is: the `Telo.Builtins`
//! archive rendered for this build, embedded byte for byte — the same bytes the
//! Node CLI imports from `@telorun/analyzer` — or only the named entries of it.

use telo_analyzer::builtin_vocabulary_slices::{select_builtins, SelectionError};

use crate::output;

/// The archive this build was rendered with. `build.rs` refuses a build without it.
pub const BUILTIN_VOCABULARY_ARCHIVE: &str =
    include_str!("../../../../analyzer/nodejs/src/builtin-vocabulary/builtins.yaml");

/// Returns the process exit code.
pub fn builtins(names: &[String]) -> i32 {
    let text = if names.is_empty() {
        BUILTIN_VOCABULARY_ARCHIVE.to_string()
    } else {
        match select_builtins(BUILTIN_VOCABULARY_ARCHIVE, names) {
            Ok(text) => text,
            Err(SelectionError::Unknown { message, .. })
            | Err(SelectionError::Malformed(message)) => {
                output::err_line(&message);
                return 1;
            }
        }
    };
    match output::raw(&text) {
        Ok(()) => 0,
        Err(err) => {
            output::err_line(&format!("telo builtins: writing to stdout failed: {err}"));
            1
        }
    }
}
