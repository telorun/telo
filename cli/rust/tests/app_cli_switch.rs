//! `TELO_APP_CLI` end to end: this build carries no payload, so `1` changes
//! nothing, and any value but `1`, empty or unset is refused before anything
//! runs, naming the variable.

use std::process::Command;

fn telo(value: Option<&str>) -> std::process::Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_telo"));
    command.arg("--version").env_remove("TELO_APP_CLI");
    if let Some(value) = value {
        command.env("TELO_APP_CLI", value);
    }
    command.output().expect("telo runs")
}

#[test]
fn behaves_as_without_it_when_set_to_one_or_empty() {
    let plain = telo(None);
    assert_eq!(plain.status.code(), Some(0));
    for value in ["1", ""] {
        let switched = telo(Some(value));
        assert_eq!(switched.status.code(), Some(0), "{value:?}");
        assert_eq!(switched.stdout, plain.stdout, "{value:?}");
        assert!(switched.stderr.is_empty(), "{value:?}");
    }
}

#[test]
fn refuses_any_other_value_and_runs_nothing() {
    let refused = telo(Some("yes"));
    assert_eq!(refused.status.code(), Some(2));
    assert!(refused.stdout.is_empty());
    let stderr = String::from_utf8_lossy(&refused.stderr);
    assert!(stderr.starts_with("TELO_APP_CLI is set to 'yes'"), "{stderr}");
    assert!(stderr.contains("TELO_APP_CLI=1"), "{stderr}");
}
