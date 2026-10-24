//! The supervisor's own log, one line per entry on stderr — the container's
//! output carries nothing else, since a run's output travels only the protocol.
//! No Node twin — the crate runs where no runtime is (see the crate README).

use std::io::Write;

pub fn info(message: &str) {
    write("info", message);
}

pub fn warn(message: &str) {
    write("warn", message);
}

pub fn error(message: &str) {
    write("error", message);
}

fn write(level: &str, message: &str) {
    // A log that cannot be written has nowhere left to report to.
    let _ = writeln!(std::io::stderr().lock(), "supervisor {level}: {message}");
}
