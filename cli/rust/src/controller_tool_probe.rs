//! Report, at check time, the external programs this manifest's controllers will need and
//! this machine does not have. Mirrors `../../nodejs/src/controller-tool-probe.ts`.
//!
//! **Check may probe; boot may not.** The rule and the wording are the kernel's table
//! (`controller_tool_requirements.rs`); only the probing is here, because the analyzer must
//! stay runnable in a browser and can spawn nothing. **A warning, never an error**: the
//! machine running `telo check` is frequently not the one that will run the app.

use std::collections::HashMap;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use telo_analyzer::{AnalysisDiagnostic, DiagnosticData, DiagnosticSeverity, LoadedGraph, Range};
use telo_kernel::controller_loaders::controller_tool_requirements::{
    is_command_not_found, missing_tool_message, tool_requirement, ToolRequirement,
};

/// The diagnostic code a missing tool reports under.
pub const CONTROLLER_TOOL_MISSING: &str = "CONTROLLER_TOOL_MISSING";

/// How long a probe waits for a program to answer `--version`.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// Whether a program is on `PATH` — injectable, because the alternative is a test asserting
/// a property of the machine it runs on.
pub type Exists<'a> = dyn Fn(&str, &HashMap<String, String>) -> bool + 'a;

/// One kind's demand: the tools that could satisfy it, and where it was declared. A kind is
/// only in trouble when EVERY one of them is missing.
struct KindDemand {
    module: String,
    /// Canonical source of the module the kind was declared in, for locating the `imports:`
    /// entry that pulled it in.
    module_source: String,
    requirements: Vec<ToolRequirement>,
}

/// Where a diagnostic about `module_source` points: the `imports:` entry that pulled that
/// module in, in the file that wrote it.
fn import_site(graph: &LoadedGraph, module_source: &str) -> Option<(String, Option<Range>)> {
    for (importing_source, aliases) in &graph.import_edges {
        for (alias, edge) in aliases {
            if edge.target_source != module_source {
                continue;
            }
            let range = graph.modules.get(importing_source).and_then(|module| {
                module
                    .owner
                    .positions
                    .iter()
                    .find_map(|position| position.position_index.get(&format!("@key:imports.{alias}")).copied())
            });
            return Some((importing_source.clone(), range));
        }
    }
    None
}

/// What each kind in the graph needs beyond the kernel itself. A kind lists `controllers:`
/// as *candidates* and the kernel takes the first this host can load, so a kind with any
/// toolless candidate is dropped, and one whose candidates all need tools is reported only
/// if every one of those tools is absent.
fn kind_demands(graph: &LoadedGraph, env: &HashMap<String, String>) -> Vec<KindDemand> {
    let mut demands = Vec::new();
    for module in graph.modules.values() {
        let file = &module.owner;
        for manifest in file.documents() {
            let kind = manifest.get("kind").and_then(|kind| kind.as_str());
            if kind != Some("Telo.Definition") && kind != Some("Telo.Abstract") {
                continue;
            }
            let Some(candidates) = manifest.get("controllers").and_then(|c| c.as_array()) else { continue };
            let mut requirements = Vec::new();
            let mut toolless = false;
            for candidate in candidates.iter().filter_map(|c| c.as_str()) {
                match tool_requirement(candidate, env) {
                    None => {
                        toolless = true;
                        break;
                    }
                    Some(requirement) => requirements.push(requirement),
                }
            }
            if toolless || requirements.is_empty() {
                continue;
            }
            demands.push(KindDemand {
                module: if file.requested_url.is_empty() { file.source.clone() } else { file.requested_url.clone() },
                module_source: file.source.clone(),
                requirements,
            });
        }
    }
    demands
}

/// Probe for each required tool once and report the ones that are absent. One diagnostic
/// per (tool, module), not per kind.
pub fn probe_controller_tools(
    graph: &LoadedGraph,
    env: &HashMap<String, String>,
    exists: &Exists,
) -> Vec<AnalysisDiagnostic> {
    let demands = kind_demands(graph, env);
    if demands.is_empty() {
        return Vec::new();
    }
    let mut present: HashMap<String, bool> = HashMap::new();
    for requirement in demands.iter().flat_map(|demand| &demand.requirements) {
        if !present.contains_key(&requirement.tool) {
            present.insert(requirement.tool.clone(), exists(&requirement.tool, env));
        }
    }
    let mut reported: Vec<(String, &KindDemand, &ToolRequirement)> = Vec::new();
    for demand in &demands {
        if demand.requirements.iter().any(|requirement| present[&requirement.tool]) {
            continue;
        }
        for requirement in &demand.requirements {
            let key = format!("{}\0{}", requirement.tool, demand.module);
            match reported.iter_mut().find(|(k, _, _)| *k == key) {
                Some(entry) => *entry = (key, demand, requirement),
                None => reported.push((key, demand, requirement)),
            }
        }
    }
    reported
        .into_iter()
        .map(|(_, demand, requirement)| {
            let site = import_site(graph, &demand.module_source);
            AnalysisDiagnostic {
                range: site.as_ref().and_then(|(_, range)| *range),
                severity: Some(DiagnosticSeverity::Warning),
                code: Some(CONTROLLER_TOOL_MISSING.to_string()),
                source: Some("telo-check".to_string()),
                message: format!(
                    "{} This machine is not necessarily the one that will run the app, so this is a warning rather than an error.",
                    missing_tool_message(requirement, &format!("A controller of {}", demand.module))
                ),
                tags: None,
                data: site.map(|(file_path, _)| DiagnosticData { file_path: Some(file_path), ..Default::default() }),
            }
        })
        .collect()
}

/// Whether `tool` answers `--version`. Its exit code is not the question — a program that
/// ran at all is present; only a failure to launch it, per the kernel's table, is absence.
/// A probe that cannot answer (a timeout) must not invent a warning about the manifest.
pub fn command_exists(tool: &str, env: &HashMap<String, String>) -> bool {
    let mut command = if cfg!(windows) {
        let mut shell = Command::new("cmd");
        shell.args(["/C", tool, "--version"]);
        shell
    } else {
        let mut direct = Command::new(tool);
        direct.arg("--version");
        direct
    };
    // Layered over the ambient environment: `env` says which package manager to look for,
    // and replacing it would hand the spawn an environment with no `PATH`.
    command.envs(env).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    let started = Instant::now();
    let outcome = match command.spawn() {
        Err(err) => Err(err),
        Ok(mut child) => loop {
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) if started.elapsed() >= PROBE_TIMEOUT => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return true;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(10)),
                Err(err) => break Err(err),
            }
        },
    };
    !is_command_not_found(&outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn graph_of(manifest: &str) -> LoadedGraph {
        let file = telo_analyzer::parse_loaded_file("/app/telo.yaml", "/app/telo.yaml", manifest);
        let mut modules = indexmap::IndexMap::new();
        modules.insert("/app/telo.yaml".to_string(), telo_analyzer::LoadedModule { owner: file });
        LoadedGraph {
            root_source: "/app/telo.yaml".to_string(),
            modules,
            requested: HashMap::new(),
            import_edges: HashMap::new(),
            parse_diagnostics: Vec::new(),
            migration_diagnostics: Vec::new(),
            errors: Vec::new(),
        }
    }

    const KINDS: &str = "kind: Telo.Library\nmetadata: { name: A }\n---\nkind: Telo.Definition\nmetadata: { name: Rusty }\ncapability: Telo.Invocable\ncontrollers: [\"pkg:cargo/rusty?local_path=./rust#entry\"]\n---\nkind: Telo.Definition\nmetadata: { name: Both }\ncapability: Telo.Invocable\ncontrollers: [\"pkg:cargo/both?local_path=./rust#entry\", \"pkg:telo/local/js?path=./x.mjs#Both\"]\n";

    #[test]
    fn warns_once_per_missing_tool_for_a_kind_with_no_toolless_candidate() {
        let graph = graph_of(KINDS);
        let env = HashMap::new();
        let found = probe_controller_tools(&graph, &env, &|_, _| false);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].code.as_deref(), Some(CONTROLLER_TOOL_MISSING));
        assert_eq!(found[0].severity, Some(DiagnosticSeverity::Warning));
        assert!(
            found[0].message.starts_with("A controller of /app/telo.yaml needs \"cargo\", which is not on PATH:"),
            "{}",
            found[0].message
        );
        assert!(found[0].message.ends_with("so this is a warning rather than an error."));
        assert!(probe_controller_tools(&graph, &env, &|_, _| true).is_empty());
    }
}
