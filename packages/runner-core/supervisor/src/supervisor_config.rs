//! What the supervisor is started with: `TELO_SUPERVISOR_LISTEN` and
//! `TELO_SUPERVISOR_TOKEN`, each removed from the environment once read, and
//! `--workspace <dir>`. No Node twin — the crate runs where no runtime is (see
//! the crate README).

use std::ffi::OsString;
use std::net::SocketAddr;
use std::path::PathBuf;

pub const LISTEN_VARIABLE: &str = "TELO_SUPERVISOR_LISTEN";
pub const TOKEN_VARIABLE: &str = "TELO_SUPERVISOR_TOKEN";
pub const DEFAULT_WORKSPACE: &str = "/workspace";

pub struct SupervisorConfig {
    pub listen: SocketAddr,
    pub token: Vec<u8>,
    /// What a relative `run.cwd` resolves against.
    pub workspace: PathBuf,
}

/// Reads the configuration and removes both variables from this process's
/// environment, so no run inherits them. Called before any thread starts.
pub fn from_process() -> Result<SupervisorConfig, String> {
    let listen = std::env::var_os(LISTEN_VARIABLE);
    let token = std::env::var_os(TOKEN_VARIABLE);
    std::env::remove_var(LISTEN_VARIABLE);
    std::env::remove_var(TOKEN_VARIABLE);
    let workspace = workspace_from(std::env::args_os().skip(1))?;
    let listen = listen
        .ok_or_else(|| format!("{LISTEN_VARIABLE} is required (an address such as 0.0.0.0:7070)"))?
        .into_string()
        .map_err(|_| format!("{LISTEN_VARIABLE} is not text"))?;
    let listen: SocketAddr = listen
        .parse()
        .map_err(|error| format!("{LISTEN_VARIABLE} {listen:?} is not an ip:port address: {error}"))?;
    let token = token
        .ok_or_else(|| format!("{TOKEN_VARIABLE} is required"))?
        .into_string()
        .map_err(|_| format!("{TOKEN_VARIABLE} is not text"))?;
    if token.trim().is_empty() {
        return Err(format!("{TOKEN_VARIABLE} must not be empty"));
    }
    Ok(SupervisorConfig { listen, token: token.into_bytes(), workspace })
}

fn workspace_from(mut args: impl Iterator<Item = OsString>) -> Result<PathBuf, String> {
    let mut workspace = PathBuf::from(DEFAULT_WORKSPACE);
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--workspace") => {
                let value = args.next().ok_or("--workspace takes a directory")?;
                workspace = PathBuf::from(value);
            }
            _ => return Err(format!("unknown argument {arg:?}; usage: supervisor [--workspace <dir>] [--slots <n>]")),
        }
    }
    if !workspace.is_absolute() {
        return Err(format!("--workspace {} must be an absolute path", workspace.display()));
    }
    Ok(workspace)
}
