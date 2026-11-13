//! `telo` — command-line entry point for the Rust Telo kernel.

mod app_cli_switch;
mod check_session;
mod cli;
mod color_precedence;
mod commands;
mod controller_tool_probe;
mod exit_status;
mod logger;
mod manifest_freshness;
mod manifest_input;
mod output;
mod package;

use exit_status::EXIT_REFUSED;

fn main() {
    // First, before anything reads the environment: the colour bridge, then no kernel,
    // controller or child of this process sees `TELO_APP_CLI`.
    color_precedence::bridge_clicolor_force();
    if let Err(refusal) = app_cli_switch::take_app_cli_switch() {
        output::err_line(&refusal);
        std::process::exit(EXIT_REFUSED);
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    let exit_code = match cli::parse(&args) {
        Ok(invocation) => cli::dispatch(invocation),
        Err(message) => {
            eprintln!("{}\n\n{message}", cli::USAGE);
            EXIT_REFUSED
        }
    };
    std::process::exit(exit_code);
}
