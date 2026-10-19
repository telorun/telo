//! The desktop file scope in `capabilities/default.json`, matched the way the
//! shell matches it on Linux and macOS: each `allow` path a glob pattern, with a
//! separator matched only by a literal `/` and a leading dot only by a literal
//! `.` (Tauri's fs-scope `MatchOptions` on unix). So `**` never reaches a
//! dot-file or a dot-directory; only a pattern that spells the dot does.

use glob::{MatchOptions, Pattern};

const HOME: &str = "/home/user";
const APPDATA: &str = "/home/user/.local/share/com.telo.studio";

const SCOPE_OPTIONS: MatchOptions = MatchOptions {
    case_sensitive: true,
    require_literal_separator: true,
    require_literal_leading_dot: true,
};

fn allowed_patterns() -> Vec<Pattern> {
    let capability: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/default.json")).expect("valid JSON");
    capability["permissions"]
        .as_array()
        .expect("a permissions list")
        .iter()
        .filter(|permission| permission["identifier"] == "fs:scope")
        .flat_map(|permission| permission["allow"].as_array().expect("an allow list"))
        .map(|entry| {
            let path = entry["path"].as_str().expect("a path");
            Pattern::new(&path.replace("$HOME", HOME).replace("$APPDATA", APPDATA)).expect("a glob")
        })
        .collect()
}

fn in_scope(path: &str) -> bool {
    allowed_patterns().iter().any(|pattern| pattern.matches_with(path, SCOPE_OPTIONS))
}

#[test]
fn env_files_in_a_workspace_are_in_scope() {
    for path in [
        "/home/user/projects/shop/.env",
        "/home/user/projects/shop/.env.local",
        "/home/user/projects/shop/apps/api/.env.production",
        "/home/user/projects/shop/telo.yaml",
    ] {
        assert!(in_scope(path), "{path} should be readable");
    }
}

#[test]
fn other_dot_files_stay_out_of_scope() {
    for path in [
        "/home/user/.ssh/id_ed25519",
        "/home/user/.aws/credentials",
        "/home/user/.ssh/.env",
        "/home/user/projects/shop/.secrets",
        "/home/user/projects/shop/.git/config",
        // direnv executes it: no write access.
        "/home/user/projects/shop/.envrc",
        "/home/user/.envrc",
    ] {
        assert!(!in_scope(path), "{path} should stay unreadable");
    }
}
