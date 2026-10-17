//! Argument parsing and command dispatch.
//! Mirrors `../../nodejs/src/cli.ts`.
//!
//! Hand-rolled rather than built on a parser crate: two commands taking only
//! positional arguments do not need one, and the Node CLI's surface is the
//! reference for what this grows into, not a library's conventions.

use telo_analyzer::builtin_vocabulary::builtin_vocabulary_version;

use crate::commands;
use crate::commands::builtins::BUILTIN_VOCABULARY_ARCHIVE;
use crate::output;

pub const USAGE: &str = "\
telo — the Rust Telo kernel

Usage:
  telo --version              Print the telo this is: X for a release, X+unreleased
                              for a build made while X is pending
  telo run <manifest>         Load a manifest and run its targets
  telo builtins [<name>...]   Print the built-in vocabulary of this telo, or only
                              the named entries: a kind (Application or
                              Telo.Application), a fragment (Step), a value type
                              (Telo.Url), a zone attribute (atomic) or a format
                              (css-selector)

The manifest may be a file or a directory containing telo.yaml.";

pub enum Command {
    Version,
    Run { manifest: String },
    Builtins { names: Vec<String> },
    Help,
}

pub fn parse(args: &[String]) -> Result<Command, String> {
    match args.split_first() {
        None => Ok(Command::Help),
        Some((command, rest)) if command == "help" || command == "--help" || command == "-h" => {
            let _ = rest;
            Ok(Command::Help)
        }
        // Answered before anything after it, as the Node CLI answers it.
        Some((command, _)) if command == "--version" => Ok(Command::Version),
        Some((command, rest)) if command == "run" => match rest {
            [manifest] => Ok(Command::Run {
                manifest: manifest.clone(),
            }),
            [] => Err("`run` needs a manifest path".to_string()),
            _ => Err("`run` takes exactly one manifest path".to_string()),
        },
        Some((command, rest)) if command == "builtins" => Ok(Command::Builtins {
            names: rest.to_vec(),
        }),
        Some((command, _)) => Err(format!("unknown command `{command}`")),
    }
}

/// Returns the process exit code.
pub fn dispatch(command: Command) -> i32 {
    match command {
        Command::Help => {
            println!("{USAGE}");
            0
        }
        Command::Version => version(),
        Command::Builtins { names } => commands::builtins::builtins(&names),
        Command::Run { manifest } => match commands::run::run(&manifest) {
            Ok(()) => 0,
            Err(err) => {
                eprintln!("{err}");
                1
            }
        },
    }
}

/// `telo --version`: the telo this is, `X` or `X+unreleased` — the release the
/// embedded built-in vocabulary is of. The Node CLI prints the kernel's
/// generated identity, which the same generator writes. Returns the exit code.
fn version() -> i32 {
    match builtin_vocabulary_version(BUILTIN_VOCABULARY_ARCHIVE) {
        Ok(version) => match output::raw(&format!("{version}\n")) {
            Ok(()) => 0,
            Err(err) => {
                output::err_line(&format!("telo --version: writing to stdout failed: {err}"));
                1
            }
        },
        Err(reason) => {
            output::err_line(&format!(
                "telo --version: the built-in vocabulary this build embeds is malformed: {reason}"
            ));
            1
        }
    }
}
