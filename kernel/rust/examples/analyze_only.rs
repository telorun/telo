//! `cargo run -p telo-kernel --example analyze_only -- <entry manifest>`: loads the entry with
//! `analyze_only` and prints the refusal, if any, as `[<CODE>] <message>` and then each carried
//! diagnostic as `  [<CODE>] <message>` (`  <message>` with no code), exiting 1; a load nothing
//! refuses prints nothing and exits 0.
//!
//! It has no Node twin: it exists so the rust-parity sweep's `load` dimension can ask this
//! kernel what it refuses a load with, as a sweep-owned script asks the Node kernel through
//! its `analyzeOnly` load option. It is no CLI command and is never published.

use std::process::ExitCode;

use telo_kernel::{Kernel, LoadOptions};

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let (Some(entry), None) = (args.next(), args.next()) else {
        eprintln!("usage: analyze_only <entry manifest>");
        return ExitCode::from(2);
    };
    let mut kernel = Kernel::new();
    let Err(error) = kernel.load_with(&entry, LoadOptions { analyze_only: true }) else {
        return ExitCode::SUCCESS;
    };
    println!("[{}] {}", error.code, error.message);
    for diagnostic in &error.diagnostics {
        match &diagnostic.code {
            Some(code) => println!("  [{code}] {}", diagnostic.message),
            None => println!("  {}", diagnostic.message),
        }
    }
    ExitCode::from(1)
}
