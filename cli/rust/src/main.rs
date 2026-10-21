//! `telo` — command-line entry point for the Rust Telo kernel.

mod app_cli_switch;
mod cli;
mod commands;
mod output;

fn main() {
    // First, before anything reads the environment: no kernel, controller or
    // child of this process sees `TELO_APP_CLI`.
    if let Err(refusal) = app_cli_switch::take_app_cli_switch() {
        output::err_line(&refusal);
        std::process::exit(2);
    }
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
