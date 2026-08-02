//! `telo-rs` — command-line entry point for the Rust Telo kernel.

mod cli;
mod commands;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let exit_code = match cli::parse(&args) {
        Ok(command) => cli::dispatch(command),
        Err(message) => {
            eprintln!("{message}\n\n{}", cli::USAGE);
            2
        }
    };
    std::process::exit(exit_code);
}
