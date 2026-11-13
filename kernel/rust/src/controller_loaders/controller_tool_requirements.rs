//! Which external program a controller candidate needs, and what to say when it is
//! not there. Mirrors `../../../nodejs/src/controller-loaders/controller-tool-requirements.ts`.
//!
//! Two readers share it: a loader phrases a failed spawn with it, and `telo check`
//! probes the programs a manifest's closure calls for ahead of time. The rule and the
//! wording live here because the analyzer spawns nothing and the kernel cannot reach the
//! CLI. This kernel loads no `pkg:npm` controller, so only the check reads the npm half.

use std::collections::HashMap;

use crate::controller_loaders::purl::Purl;

/// One external program a controller needs, as it is looked up on `PATH`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolRequirement {
    pub tool: String,
    /// Why this controller needs it, as a clause: "… is delivered from npm".
    pub why: String,
    /// What the reader should do about it.
    pub install: String,
}

/// The package manager npm-delivered controllers are installed with: `TELO_PKG_MANAGER`
/// when it names one, else `npm`.
pub fn package_manager_name(env: &HashMap<String, String>) -> String {
    env.get("TELO_PKG_MANAGER")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or("npm")
        .to_string()
}

/// What a candidate needs beyond the kernel itself, or `None` when it needs nothing — the
/// bundled case.
pub fn tool_requirement(purl: &str, env: &HashMap<String, String>) -> Option<ToolRequirement> {
    match Purl::parse(purl)?.purl_type.as_str() {
        "npm" => Some(package_manager_requirement(env)),
        "cargo" => Some(cargo_requirement()),
        _ => None,
    }
}

/// The package manager an npm-delivered controller is installed with.
pub fn package_manager_requirement(env: &HashMap<String, String>) -> ToolRequirement {
    let tool = package_manager_name(env);
    let install = if tool == "npm" {
        "Install Node.js, which carries npm, or set TELO_PKG_MANAGER to a package manager that is on PATH.".to_string()
    } else {
        format!("Install {tool}, or set TELO_PKG_MANAGER to a package manager that is on PATH.")
    };
    ToolRequirement {
        tool,
        why: "this controller is delivered as an npm package, which has to be installed before it can be loaded".to_string(),
        install,
    }
}

/// The toolchain a `pkg:cargo` controller is compiled by.
pub fn cargo_requirement() -> ToolRequirement {
    ToolRequirement {
        tool: "cargo".to_string(),
        why: "this controller is a Rust crate, which has to be compiled before it can be loaded".to_string(),
        install: "Install a Rust toolchain (https://rustup.rs), which carries cargo and rustc.".to_string(),
    }
}

/// Whether a spawn failed because the program is not there. Spawn-level signals only: a
/// failed direct spawn reporting `NotFound`, or a shell's own "not found" status — 9009 on
/// Windows, 127 on POSIX. The failure's text is never matched, since it belongs to the tool.
pub fn is_command_not_found(spawn: &Result<std::process::ExitStatus, std::io::Error>) -> bool {
    match spawn {
        Err(err) => err.kind() == std::io::ErrorKind::NotFound,
        Ok(status) => matches!(status.code(), Some(9009) | Some(127)),
    }
}

/// The sentence a missing tool gets, wherever it is discovered. `subject` names what
/// wanted it.
pub fn missing_tool_message(requirement: &ToolRequirement, subject: &str) -> String {
    format!(
        "{subject} needs \"{}\", which is not on PATH: {}. {}",
        requirement.tool, requirement.why, requirement.install
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_candidates_need_nothing_and_the_others_name_their_tool() {
        let env = HashMap::new();
        assert_eq!(tool_requirement("pkg:telo/local/js?path=./x.mjs#Entry", &env), None);
        assert_eq!(tool_requirement("pkg:cargo/x?local_path=./rust#entry", &env).unwrap().tool, "cargo");
        let env = HashMap::from([("TELO_PKG_MANAGER".to_string(), " pnpm ".to_string())]);
        let npm = tool_requirement("pkg:npm/@telorun/x@1.0.0", &env).unwrap();
        assert_eq!(npm.tool, "pnpm");
        assert!(npm.install.starts_with("Install pnpm, or set TELO_PKG_MANAGER"));
        assert_eq!(
            missing_tool_message(&cargo_requirement(), "A controller of m"),
            "A controller of m needs \"cargo\", which is not on PATH: this controller is a Rust crate, \
             which has to be compiled before it can be loaded. Install a Rust toolchain (https://rustup.rs), \
             which carries cargo and rustc."
        );
    }
}
