//! `telo builtins [<name>…]`.
//! Mirrors `../../../nodejs/src/commands/builtins.ts`.
//!
//! The built-in vocabulary of the telo this binary is: the `Telo.Builtins`
//! archive `telo-analyzer` embeds — the same bytes the Node CLI imports from
//! `@telorun/analyzer` — or only the named entries of it.

use telo_analyzer::builtin_vocabulary::BUILTIN_VOCABULARY_ARCHIVE;
use telo_analyzer::builtin_vocabulary_slices::{select_builtins, SelectionError};

use crate::output;

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
