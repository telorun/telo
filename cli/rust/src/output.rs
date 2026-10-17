//! Where the CLI writes. Mirrors `../../nodejs/src/output.ts` in its stream
//! split only: stdout carries a command's document and nothing else, stderr the
//! human text — an error and why — so a document a caller pipes stays parseable.
//! The Node seam's formats, colour and progress line have no counterpart yet.

use std::io::{ErrorKind, Write};

/// Write a document to stdout verbatim, with no framing. A reader that closed
/// its end (`telo … | head`) has taken everything it wants, so that ends the
/// write without failing it, as the Node seam's `EPIPE` handling does; any other
/// failure is returned.
pub fn raw(content: &str) -> std::io::Result<()> {
    let mut stdout = std::io::stdout().lock();
    match stdout.write_all(content.as_bytes()).and_then(|()| stdout.flush()) {
        Err(err) if err.kind() == ErrorKind::BrokenPipe => Ok(()),
        other => other,
    }
}

/// One line of human text on stderr.
pub fn err_line(text: &str) {
    eprintln!("{text}");
}
