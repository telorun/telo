//! `telo check <paths..>`.
//! Mirrors `../../../nodejs/src/commands/check.ts`.
//!
//! Loads each path's graph, analyzes it with the analyzer's own passes and prints what
//! `telo check` prints: the same envelope, text, exit status and cache behaviour, for what
//! this analyzer covers. It may under-report and never over-report. A construct this build
//! cannot read — a file the YAML reader holds back, an import it cannot resolve, an input it
//! cannot open — is no diagnostic: it is held back like a parse failure, reported on stderr
//! as a host refusal, and makes the run fail.

use std::collections::HashSet;

use serde_json::json;
use telo_analyzer::{
    analyze, assemble_graph_diagnostics, find_positions, AnalysisDiagnostic, AnalysisOptions, LoadedGraph,
    ParseErrorOrigin,
};
use telo_kernel::controllers::module::module_controller::value_branch_accepts;
use telo_kernel::manifest_sources::local_manifest_cache_source::write_manifest_cache;
use telo_kernel::manifest_sources::origin_digests::write_origin_digests;

use crate::check_session::{cache_target_for, load_fresh_graph, open_session, CacheTarget, CheckSession, GraphFailure};
use crate::controller_tool_probe::{command_exists, probe_controller_tools};
use crate::exit_status::EXIT_FAILED;
use crate::logger::{display_source_path, format_analysis_diagnostics, load_failure, Counts, JsonDiagnostic, Logger};
use crate::manifest_input::{resolve_manifest_input, InputRefusal, ManifestInput};
use crate::output::Output;

/// The code of a host refusal: a construct this build cannot read.
const UNSUPPORTED: &str = "ERR_UNSUPPORTED_MANIFEST_FEATURE";

pub struct CheckArgs {
    pub paths: Vec<String>,
    pub cache_write: bool,
}

#[derive(Default)]
struct Outcome {
    error_count: usize,
    warn_count: usize,
    diagnostics: Vec<JsonDiagnostic>,
    /// A host refusal was reported for this path.
    refused: bool,
}

impl From<Counts> for Outcome {
    fn from(counts: Counts) -> Self {
        Self {
            error_count: counts.error_count,
            warn_count: counts.warn_count,
            diagnostics: counts.diagnostics,
            refused: false,
        }
    }
}

/// Returns the process exit code.
pub fn check(args: &CheckArgs, out: &Output) -> i32 {
    match run_check(args, out) {
        Ok(code) => code,
        Err(err) => {
            crate::output::err_line(&format!("telo check: writing output failed: {err}"));
            EXIT_FAILED
        }
    }
}

fn check_one(
    input: &ManifestInput,
    cache_target: Option<&CacheTarget>,
    session: &CheckSession,
    cache_write: bool,
    log: &Logger,
) -> std::io::Result<Outcome> {
    let entry_path = &input.entry_path;
    let is_url = entry_path.starts_with("http://") || entry_path.starts_with("https://");
    let display_path = || if is_url { entry_path.clone() } else { display_source_path(entry_path, &log.cwd) };

    // Freshness before analysis: a verdict computed from a moved tag would be reported as
    // authoritative.
    let (graph, digests) = match load_fresh_graph(entry_path, session, log) {
        Ok(loaded) => loaded,
        Err(GraphFailure::Entry(message)) | Err(GraphFailure::Freshness(message)) => {
            return Ok(load_failure(&display_path(), &message, None, log)?.into());
        }
        Err(GraphFailure::Refused { file, error }) => {
            let at = file.map(|file| format!("'{}': ", display_source_path(&file, &log.cwd))).unwrap_or_default();
            log.out.err_line(&format!("[{}] {at}{}", error.code, error.message))?;
            return Ok(Outcome { refused: true, ..Outcome::default() });
        }
    };

    let (held, refused) = report_unsupported_constructs(&graph, log)?;
    let analysis = analyze(&graph, &AnalysisOptions { accepts_value: &value_branch_accepts });
    let mut diagnostics = assemble_graph_diagnostics(&graph, analysis).diagnostics;
    diagnostics.retain(|d| !held.contains(&owning_file(&graph, d)));
    // Probing costs a process launch per tool the manifest actually calls for, and nothing
    // at all for a manifest of bundled controllers.
    let env: std::collections::HashMap<String, String> = std::env::vars_os().filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?))).collect();
    diagnostics.extend(probe_controller_tools(&graph, &env, &command_exists));
    let counts = format_analysis_diagnostics(&diagnostics, &graph, log, entry_path)?;

    if cache_write {
        if let Some(target) = cache_target {
            // Write-through, so the next check — and the next `telo run` from this
            // directory, which reads the same cache — is hermetic. Caching is an
            // optimization: a read-only filesystem warns rather than fails the check.
            let written = write_manifest_cache(&graph, &target.manifests_dir)
                .and_then(|_| write_origin_digests(&target.manifests_dir, &digests));
            if let Err(err) = written {
                log.out.err_line(&format!("{}\n", log.err().warn(&format!("[manifest-cache] write failed: {err}"))))?;
            }
        }
    }
    let mut outcome: Outcome = counts.into();
    outcome.refused = refused;
    Ok(outcome)
}

/// The file a diagnostic is shown in, by the rule the assembly files it by.
fn owning_file(graph: &LoadedGraph, d: &AnalysisDiagnostic) -> String {
    find_positions(graph, d.data.as_ref())
        .map(|positions| positions.file)
        .or_else(|| d.data.as_ref().and_then(|data| data.file_path.clone()))
        .unwrap_or_else(|| graph.root_source.clone())
}

/// Report every construct of the graph this build cannot read on stderr, naming the file,
/// document, line and column. Returns the files held back — whose diagnostics are dropped,
/// as a file that failed to parse has its analysis held back — and whether any was found.
fn report_unsupported_constructs(graph: &LoadedGraph, log: &Logger) -> std::io::Result<(HashSet<String>, bool)> {
    let mut held = HashSet::new();
    for module in graph.modules.values() {
        let file = &module.owner;
        for error in &file.parse_errors {
            let ParseErrorOrigin::Unsupported(construct) = &error.origin else { continue };
            let place = match error.range {
                Some(range) => format!(
                    "document {}, line {}, column {}",
                    error.document_index + 1,
                    range.start.line + 1,
                    range.start.character + 1
                ),
                None => format!("document {}", error.document_index + 1),
            };
            log.out.err_line(&format!(
                "[{UNSUPPORTED}] '{}', {place}: {}",
                display_source_path(&file.source, &log.cwd),
                construct.message()
            ))?;
            held.insert(file.source.clone());
        }
    }
    let refused = !held.is_empty();
    Ok((held, refused))
}

fn run_check(args: &CheckArgs, out: &Output) -> std::io::Result<i32> {
    let cwd = std::env::current_dir()?;
    let log = Logger::new(out, cwd.clone());

    // Each path resolved once, before the session opens.
    let inputs: Vec<(&String, Result<ManifestInput, InputRefusal>)> =
        args.paths.iter().map(|path| (path, resolve_manifest_input(path, &cwd))).collect();

    let mut targets: Vec<CacheTarget> = Vec::new();
    let mut cache_targets: Vec<Option<CacheTarget>> = Vec::new();
    for (_, input) in &inputs {
        let target = match input {
            Ok(input) => cache_target_for(input)?,
            Err(_) => None,
        };
        if let Some(target) = &target {
            match targets.iter_mut().find(|t| t.manifests_dir == target.manifests_dir) {
                Some(existing) => *existing = target.clone(),
                None => targets.push(target.clone()),
            }
        }
        cache_targets.push(target);
    }
    let session = open_session(&targets);

    let mut total_errors = 0;
    let mut total_warns = 0;
    let mut refused = false;
    let mut all_diagnostics: Vec<JsonDiagnostic> = Vec::new();
    for ((path, input), cache_target) in inputs.iter().zip(&cache_targets) {
        let outcome = match input {
            Ok(input) => check_one(input, cache_target.as_ref(), &session, args.cache_write, &log)?,
            Err(InputRefusal::Failure(message)) => load_failure(path, message, None, &log)?.into(),
            Err(InputRefusal::Unsupported(sentence)) => {
                out.err_line(&format!("[{UNSUPPORTED}] {sentence}"))?;
                Outcome { refused: true, ..Outcome::default() }
            }
        };
        total_errors += outcome.error_count;
        total_warns += outcome.warn_count;
        refused |= outcome.refused;
        all_diagnostics.extend(outcome.diagnostics);
    }

    if total_errors == 0 && total_warns == 0 {
        // A run that held something back has not found "no issues".
        if !refused {
            out.line(&format!("{}  No issues found", log.ok("✓")))?;
        }
    } else {
        let mut parts = Vec::new();
        if total_errors > 0 {
            parts.push(log.error(&format!("{total_errors} error{}", if total_errors != 1 { "s" } else { "" })));
        }
        if total_warns > 0 {
            parts.push(log.warn(&format!("{total_warns} warning{}", if total_warns != 1 { "s" } else { "" })));
        }
        out.line(&format!("\n{}", parts.join(", ")))?;
    }

    // Emitted even when clean: an empty `diagnostics` array is the answer, and a consumer
    // must not have to treat "no output" as success.
    out.emit(&json!({
        "ok": total_errors == 0 && !refused,
        "errorCount": total_errors,
        "warnCount": total_warns,
        "diagnostics": serde_json::to_value(&all_diagnostics).expect("diagnostics serialize"),
    }))?;

    Ok(if total_errors > 0 || refused { EXIT_FAILED } else { 0 })
}
