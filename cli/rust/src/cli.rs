//! Argument parsing and command dispatch.
//! Mirrors `../../nodejs/src/cli.ts`.
//!
//! Hand-rolled rather than built on a parser crate: one command with one
//! positional argument does not need one, and the Node CLI's surface is the
//! reference for what this grows into, not a library's conventions.

use crate::commands;

pub const USAGE: &str = "\
telo-rs — the Rust Telo kernel

Usage:
  telo-rs run <manifest>    Load a manifest and run its targets

The manifest may be a file or a directory containing telo.yaml.";

pub enum Command {
    Run { manifest: String },
    Help,
}

pub fn parse(args: &[String]) -> Result<Command, String> {
    match args.split_first() {
        None => Ok(Command::Help),
        Some((command, rest)) if command == "help" || command == "--help" || command == "-h" => {
            let _ = rest;
            Ok(Command::Help)
        }
        Some((command, rest)) if command == "run" => match rest {
            [manifest] => Ok(Command::Run {
                manifest: manifest.clone(),
            }),
            [] => Err("`run` needs a manifest path".to_string()),
            _ => Err("`run` takes exactly one manifest path".to_string()),
        },
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
        Command::Run { manifest } => match commands::run::run(&manifest) {
            Ok(()) => 0,
            Err(err) => {
                eprintln!("{err}");
                1
            }
        },
    }
}
