//! `TELO_APP_CLI` — whether a packaged executable is its application or the
//! telo CLI it carries. Mirrors `../../nodejs/src/app-cli-switch.ts`.
//!
//! `1` means the CLI; unset or empty means the application; any other value is
//! refused before anything runs, with exit status 2 (`main`), as every
//! distribution refuses it. Every telo start reads it and removes it from
//! its own environment first, so no kernel, controller or child process sees
//! it. This build carries no payload, so the switch does nothing else here: a
//! start with `TELO_APP_CLI=1` behaves as one without it.

use std::ffi::OsString;

pub const APP_CLI_ENV: &str = "TELO_APP_CLI";

#[derive(Debug, PartialEq, Eq)]
pub enum AppCliSwitch {
    Application,
    Cli,
}

/// Read `TELO_APP_CLI` out of this process's environment, removing it. Called
/// first thing in `main`, before anything else reads the environment or a
/// thread exists.
pub fn take_app_cli_switch() -> Result<AppCliSwitch, String> {
    let value = std::env::var_os(APP_CLI_ENV);
    std::env::remove_var(APP_CLI_ENV);
    judge(value)
}

fn judge(value: Option<OsString>) -> Result<AppCliSwitch, String> {
    match value {
        None => Ok(AppCliSwitch::Application),
        Some(value) if value.is_empty() => Ok(AppCliSwitch::Application),
        Some(value) if value == "1" => Ok(AppCliSwitch::Cli),
        Some(value) => Err(format!(
            "{APP_CLI_ENV} is set to '{}', which telo does not read: set {APP_CLI_ENV}=1 to run a \
             packaged executable as the telo CLI, or leave it unset or empty to run its application.",
            value.to_string_lossy()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_one_as_the_cli_and_unset_or_empty_as_the_application() {
        assert_eq!(judge(None), Ok(AppCliSwitch::Application));
        assert_eq!(judge(Some("".into())), Ok(AppCliSwitch::Application));
        assert_eq!(judge(Some("1".into())), Ok(AppCliSwitch::Cli));
    }

    #[cfg(unix)]
    #[test]
    fn takes_the_variable_out_of_the_environment_children_inherit() {
        std::env::set_var(APP_CLI_ENV, "1");
        assert_eq!(take_app_cli_switch(), Ok(AppCliSwitch::Cli));
        let child = std::process::Command::new("sh")
            .args(["-c", "printf %s \"${TELO_APP_CLI-unset}\""])
            .output()
            .expect("sh runs");
        assert_eq!(String::from_utf8_lossy(&child.stdout), "unset");
    }

    #[test]
    fn refuses_any_other_value_naming_the_variable() {
        let refusal = judge(Some("yes".into())).unwrap_err();
        assert!(refusal.starts_with("TELO_APP_CLI is set to 'yes'"), "{refusal}");
        assert!(refusal.contains("TELO_APP_CLI=1"), "{refusal}");
    }
}
