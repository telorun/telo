//! The CLI's exit status (`cli/README.md`, "Exit status"): 0 when the command did its work,
//! 1 when the work failed, 2 when the invocation was refused before any work began.
//! Mirrors `../../nodejs/src/exit-status.ts`.

pub const EXIT_FAILED: i32 = 1;

/// A refused invocation: a command line the parser rejects, a start `TELO_APP_CLI`
/// refuses.
pub const EXIT_REFUSED: i32 = 2;
