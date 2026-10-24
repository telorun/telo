//! The `supervisor` executable. No Node twin — it runs where no runtime is (see
//! the crate README).

#[cfg(unix)]
fn main() -> std::process::ExitCode {
    use std::process::ExitCode;
    use telo_runner_supervisor::{serve, supervisor_config, supervisor_log};

    let config = match supervisor_config::from_process() {
        Ok(config) => config,
        Err(message) => {
            supervisor_log::error(&message);
            return ExitCode::from(2);
        }
    };
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            supervisor_log::error(&format!("cannot start the runtime: {error}"));
            return ExitCode::from(1);
        }
    };
    match runtime.block_on(serve::serve(config)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            supervisor_log::error(&error.to_string());
            ExitCode::from(1)
        }
    }
}

#[cfg(not(unix))]
fn main() -> std::process::ExitCode {
    eprintln!("supervisor error: the session supervisor runs on Linux only");
    std::process::ExitCode::from(2)
}
