//! Argument parsing and command dispatch.
//! Mirrors `../../nodejs/src/cli.ts`.
//!
//! Hand-rolled rather than built on a parser crate: a few commands taking positional
//! arguments and four global options do not need one, and the Node CLI's surface is the
//! reference for what this grows into, not a library's conventions. A refusal carries the
//! reason in the words yargs gives it, so the two CLIs answer a wrong command line alike.

use telo_analyzer::builtin_vocabulary::builtin_vocabulary_version;

use crate::commands;
use crate::commands::builtins::BUILTIN_VOCABULARY_ARCHIVE;
use crate::commands::check::CheckArgs;
use crate::exit_status::EXIT_FAILED;
use crate::output::{self, Output, OutputFormat, OUTPUT_FORMATS};

pub const USAGE: &str = "\
telo — the Rust Telo kernel

Usage:
  telo --version              Print the telo this is: X for a release, X+unreleased
                              for a build made while X is pending
  telo run <manifest>         Load a manifest and run its targets
  telo check <paths..>        Check one or more manifests for errors without
                              running them
  telo builtins [<name>...]   Print the built-in vocabulary of this telo, or only
                              the named entries: a kind (Application or
                              Telo.Application), a fragment (Step), a value type
                              (Telo.Url), a zone attribute (atomic) or a format
                              (css-selector)

Options:
  -o, --output <text|json>    The format of the CLI's own output (default text); json
                              is a machine contract and never carries colour
      --no-cache-write        Check without persisting the manifest cache

The manifest may be a file or a directory containing telo.yaml.";

pub enum Command {
    Version,
    Run { manifest: String },
    Check { paths: Vec<String> },
    Builtins { names: Vec<String> },
    Help,
}

/// The options every command accepts.
pub struct Globals {
    pub format: OutputFormat,
    pub cache_write: bool,
}

pub struct Invocation {
    pub command: Command,
    pub globals: Globals,
}

/// The reason a command line is refused, in yargs' words.
fn not_enough_following(name: &str) -> String {
    format!("Not enough arguments following: {name}")
}

fn invalid_output(given: &str) -> String {
    let choices: Vec<String> = OUTPUT_FORMATS.iter().map(|choice| format!("\"{choice}\"")).collect();
    format!("Invalid values:\n  Argument: output, Given: \"{given}\", Choices: {}", choices.join(", "))
}

/// Split the global options out of `args`, wherever they stand. Everything after
/// `run <manifest>` is the application's and is left whole.
fn take_globals(args: &[String]) -> Result<(Globals, Vec<String>), String> {
    let mut format = OutputFormat::Text;
    let mut cache_write = true;
    let mut rest: Vec<String> = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        if rest.first().is_some_and(|command| command == "run") && rest.len() >= 2 {
            rest.extend(args[index..].iter().cloned());
            break;
        }
        let output_value = match arg {
            "-o" | "--output" => {
                index += 1;
                let value = args.get(index).ok_or_else(|| not_enough_following(arg.trim_start_matches('-')))?;
                Some(value.as_str())
            }
            _ => arg.strip_prefix("--output="),
        };
        match (output_value, arg) {
            (Some(value), _) => format = OutputFormat::parse(value).ok_or_else(|| invalid_output(value))?,
            (None, "--no-cache-write") => cache_write = false,
            (None, "--cache-write") => cache_write = true,
            (None, _) => rest.push(arg.to_string()),
        }
        index += 1;
    }
    Ok((Globals { format, cache_write }, rest))
}

/// The positional paths of `check` and the options it does not know. An unknown option
/// takes the next token as its value unless that is an option too, as yargs reads one.
fn check_operands(args: &[String]) -> (Vec<String>, Vec<String>) {
    let (mut paths, mut unknown) = (Vec::new(), Vec::new());
    let mut tokens = args.iter().peekable();
    while let Some(token) = tokens.next() {
        if token.starts_with('-') && token.len() > 1 {
            unknown.push(token.clone());
            if !token.contains('=') && tokens.peek().is_some_and(|next| !next.starts_with('-')) {
                tokens.next();
            }
        } else {
            paths.push(token.clone());
        }
    }
    (paths, unknown)
}

pub fn parse(args: &[String]) -> Result<Invocation, String> {
    let (globals, rest) = take_globals(args)?;
    let command = match rest.split_first() {
        None => Command::Help,
        Some((command, _)) if command == "help" || command == "--help" || command == "-h" => Command::Help,
        // Answered before anything after it, as the Node CLI answers it.
        Some((command, _)) if command == "--version" => Command::Version,
        Some((command, rest)) if command == "run" => match rest {
            [manifest] => Command::Run { manifest: manifest.clone() },
            [] => return Err("`run` needs a manifest path".to_string()),
            _ => return Err("`run` takes exactly one manifest path".to_string()),
        },
        Some((command, rest)) if command == "check" => {
            let (paths, unknown) = check_operands(rest);
            // yargs judges the missing positional before an unknown option.
            if paths.is_empty() {
                return Err("Not enough non-option arguments: got 0, need at least 1".to_string());
            }
            if let Some(flag) = unknown.first() {
                return Err(format!("Unknown argument: {}", flag.trim_start_matches('-')));
            }
            Command::Check { paths }
        }
        Some((command, rest)) if command == "builtins" => Command::Builtins { names: rest.to_vec() },
        Some((command, _)) => return Err(format!("unknown command `{command}`")),
    };
    Ok(Invocation { command, globals })
}

/// Returns the process exit code.
pub fn dispatch(invocation: Invocation) -> i32 {
    match invocation.command {
        Command::Help => {
            println!("{USAGE}");
            0
        }
        Command::Version => version(),
        Command::Builtins { names } => commands::builtins::builtins(&names),
        Command::Check { paths } => {
            let out = Output::process(invocation.globals.format);
            commands::check::check(&CheckArgs { paths, cache_write: invocation.globals.cache_write }, &out)
        }
        Command::Run { manifest } => match commands::run::run(&manifest) {
            Ok(()) => 0,
            Err(err) => {
                eprintln!("{err}");
                EXIT_FAILED
            }
        },
    }
}

/// `telo --version`: the telo this is, `X` or `X+unreleased` — the release the embedded
/// built-in vocabulary is of. The Node CLI prints the kernel's generated identity, which the
/// same generator writes. Returns the exit code.
fn version() -> i32 {
    match builtin_vocabulary_version(BUILTIN_VOCABULARY_ARCHIVE) {
        Ok(version) => match output::raw(&format!("{version}\n")) {
            Ok(()) => 0,
            Err(err) => {
                output::err_line(&format!("telo --version: writing to stdout failed: {err}"));
                EXIT_FAILED
            }
        },
        Err(reason) => {
            output::err_line(&format!(
                "telo --version: the built-in vocabulary this build embeds is malformed: {reason}"
            ));
            EXIT_FAILED
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refusal(args: &[&str]) -> String {
        let args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
        parse(&args).err().expect("a refused command line")
    }

    #[test]
    fn refuses_a_command_line_in_the_words_yargs_uses() {
        assert_eq!(refusal(&["check"]), "Not enough non-option arguments: got 0, need at least 1");
        assert_eq!(
            refusal(&["check", "-o", "yaml", "x"]),
            "Invalid values:\n  Argument: output, Given: \"yaml\", Choices: \"text\", \"json\""
        );
        assert_eq!(refusal(&["check", "x", "--bogus"]), "Unknown argument: bogus");
        assert_eq!(refusal(&["check", "-z"]), "Not enough non-option arguments: got 0, need at least 1");
        assert_eq!(refusal(&["check", "--bogus", "x"]), "Not enough non-option arguments: got 0, need at least 1");
        assert_eq!(refusal(&["check", "x", "-o"]), "Not enough arguments following: o");
    }

    #[test]
    fn takes_the_global_options_wherever_they_stand_but_not_out_of_an_applications_arguments() {
        let args: Vec<String> = ["-o", "json", "check", "a", "--no-cache-write", "b"].map(String::from).to_vec();
        let invocation = parse(&args).unwrap();
        assert_eq!(invocation.globals.format, OutputFormat::Json);
        assert!(!invocation.globals.cache_write);
        assert!(matches!(invocation.command, Command::Check { paths } if paths == ["a", "b"]));
        let args: Vec<String> = ["run", "app.yaml", "-o", "json"].map(String::from).to_vec();
        assert_eq!(parse(&args).err().unwrap(), "`run` takes exactly one manifest path");
    }
}
