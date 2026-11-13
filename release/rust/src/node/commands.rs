//! The release command tree — `add`, `status`, `order`, `check`, `apply`,
//! `verify`, `tag`, `adopt changesets` — over whatever host mounts it. The
//! Node twin registers these onto a yargs instance; here the same options are
//! declared as data and read by one small parser with yargs' reading of them:
//! `--name value` and `--name=value`, `--no-<flag>`, a list option taking every
//! value that follows it, and a flag nobody declared taking the next value.

use std::path::Path;

use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::bump_level::FragmentKind;
use crate::fragment::{normalize_unit_key, serialize_fragment, UnitKey};
use crate::ledger::LEDGER_PATH;
use crate::marker_reader::Severity;
use crate::release_plan::ReleaseDiagnostic;
use crate::ReleaseError;

use super::adopt_changesets::adopt_changesets;
use super::evidence::Argv;
use super::host::ReleaseHost;
use super::ledger_store::{write_fragment, write_ledger};
use super::operations::{
    apply_plan, candidate_id, create_tags, load_workspace_for, order_rows, plan_workspace_release, tags_to_create, verify_ledger, PlanOptions, PlanRun,
};
use super::render::{diagnostics_json, plan_payload, render_diagnostics, render_plan};
use super::workspace::ReleaseWorkspace;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OptionKind {
    String,
    Boolean,
    List,
}

#[derive(Debug, Clone)]
pub struct OptionSpec {
    /// The kebab-case name (`carried-by`).
    pub name: &'static str,
    pub short: Option<char>,
    pub kind: OptionKind,
    pub default: Option<Value>,
    pub describe: &'static str,
    pub demand: bool,
    pub choices: &'static [&'static str],
}

impl OptionSpec {
    pub const fn new(name: &'static str, kind: OptionKind, describe: &'static str) -> OptionSpec {
        OptionSpec { name, short: None, kind, default: None, describe, demand: false, choices: &[] }
    }
}

/// One command line as read.
#[derive(Debug, Clone, Default)]
pub struct ParsedArgs {
    pub command: Option<String>,
    pub positionals: Vec<String>,
    /// Every option, under its kebab-case and camelCase names.
    pub argv: Argv,
    pub help: bool,
}

impl ParsedArgs {
    pub fn string(&self, name: &str) -> Option<&str> {
        self.argv.get(name).and_then(Value::as_str)
    }

    pub fn flag(&self, name: &str) -> bool {
        self.argv.get(name).and_then(Value::as_bool).unwrap_or(false)
    }

    pub fn list(&self, name: &str) -> Vec<String> {
        match self.argv.get(name) {
            Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).map(str::to_string).collect(),
            Some(Value::String(one)) => vec![one.clone()],
            _ => Vec::new(),
        }
    }
}

fn camel(name: &str) -> String {
    let mut out = String::new();
    let mut upper = false;
    for c in name.chars() {
        if c == '-' {
            upper = true;
        } else if upper {
            out.extend(c.to_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}

fn set(argv: &mut Argv, name: &str, value: Value) {
    let camel = camel(name);
    if camel != name {
        argv.insert(camel, value.clone());
    }
    argv.insert(name.to_string(), value);
}

fn is_flag(token: &str) -> bool {
    token.len() > 1 && token.starts_with('-')
}

/// A usage error: its message, printed alone, and exit status 2.
#[derive(Debug, Clone)]
pub struct UsageError(pub String);

struct Command {
    name: &'static str,
    describe: &'static str,
    options: Vec<OptionSpec>,
    positional: Option<(&'static str, &'static [&'static str])>,
}

fn global_options(host: &ReleaseHost) -> Vec<OptionSpec> {
    let mut options = vec![OptionSpec {
        short: Some('o'),
        default: Some(Value::String("text".into())),
        choices: &["text", "json"],
        ..OptionSpec::new("output", OptionKind::String, "Output format")
    }];
    options.extend(host.global_options.iter().cloned());
    options.push(OptionSpec {
        default: Some(Value::String("origin/main".into())),
        ..OptionSpec::new(
            "base",
            OptionKind::String,
            "Git ref the changed-files reading diffs against. Decides only whether a changelog entry is requested.",
        )
    });
    options.push(OptionSpec::new(
        "carried-by",
        OptionKind::String,
        "Git ref whose fragments are already carried: a pending fragment of the same path and content at its merge base with HEAD, or written on it since, is dropped from the plan (status, check, apply).",
    ));
    options
}

fn commands() -> Vec<Command> {
    vec![
        Command {
            name: "add",
            describe: "Write a pending fragment describing a change",
            options: vec![
                OptionSpec {
                    demand: true,
                    ..OptionSpec::new(
                        "unit",
                        OptionKind::List,
                        "Unit directory (packages/core, or kernel for a component with several packages). Repeat for a change spanning several units.",
                    )
                },
                OptionSpec {
                    default: Some(Value::String("Fixed".into())),
                    ..OptionSpec::new("kind", OptionKind::String, "Added | Changed | Deprecated | Removed | Fixed | Security")
                },
                OptionSpec { demand: true, ..OptionSpec::new("body", OptionKind::String, "The changelog line") },
            ],
            positional: None,
        },
        Command { name: "status", describe: "Show what would bump, from what to what, and why", options: Vec::new(), positional: None },
        Command { name: "order", describe: "List the units in publish order, one row per unit and package", options: Vec::new(), positional: None },
        Command {
            name: "check",
            describe: "The pull-request gate: fail when no consistent release plan can be formed",
            options: Vec::new(),
            positional: None,
        },
        Command {
            name: "apply",
            describe: "Write versions, changelogs and the ledger, and consume the fragments",
            options: vec![
                OptionSpec::new(
                    "candidate",
                    OptionKind::String,
                    "Version each planned unit as a candidate, <final>-<id>.<k> (id default rc); consumes no fragment",
                ),
                OptionSpec::new("date", OptionKind::String, "Release date for the changelog entries (YYYY-MM-DD). Defaults to today."),
            ],
            positional: None,
        },
        Command {
            name: "verify",
            describe: "Reconcile the ledger against the registries, per layer",
            options: vec![OptionSpec {
                default: Some(Value::Bool(false)),
                ..OptionSpec::new("write", OptionKind::Boolean, "Re-record the ledger from what the registries serve")
            }],
            positional: None,
        },
        Command {
            name: "tag",
            describe: "Tag <unit key>@<version> for each unit the last apply moved, on HEAD",
            options: vec![OptionSpec {
                default: Some(Value::Bool(false)),
                ..OptionSpec::new("dry-run", OptionKind::Boolean, "List the tags without creating them")
            }],
            positional: None,
        },
        Command {
            name: "adopt",
            describe: "Import a changesets setup once: units, groups, pending fragments and the npm ledger",
            options: Vec::new(),
            positional: Some(("tool", &["changesets"])),
        },
    ]
}

fn find<'a>(specs: &'a [OptionSpec], token: &str) -> Option<&'a OptionSpec> {
    specs.iter().find(|spec| spec.name == token || camel(spec.name) == token)
}

/// Read `args` against the global options and, once its name is read, the
/// command's.
pub fn parse_args(args: &[String], globals: &[OptionSpec], commands: &[(String, Vec<OptionSpec>)]) -> ParsedArgs {
    let mut parsed = ParsedArgs::default();
    let mut specs: Vec<OptionSpec> = globals.to_vec();
    let mut lists: IndexMap<String, Vec<Value>> = IndexMap::new();
    let mut i = 0;
    let mut rest_positional = false;
    while i < args.len() {
        let token = &args[i];
        i += 1;
        if rest_positional || !is_flag(token) {
            if parsed.command.is_none() {
                parsed.command = Some(token.clone());
                if let Some((_, options)) = commands.iter().find(|(name, _)| name == token) {
                    specs.extend(options.iter().cloned());
                }
            } else {
                parsed.positionals.push(token.clone());
            }
            continue;
        }
        if token == "--" {
            rest_positional = true;
            continue;
        }
        if token == "--help" || token == "-h" {
            parsed.help = true;
            continue;
        }
        let (name, inline) = if let Some(long) = token.strip_prefix("--") {
            match long.split_once('=') {
                Some((name, value)) => (name.to_string(), Some(value.to_string())),
                None => (long.to_string(), None),
            }
        } else {
            let short = &token[1..];
            let (letter, value) = match short.split_once('=') {
                Some((letter, value)) => (letter, Some(value.to_string())),
                None if short.chars().count() > 1 => (&short[..1], Some(short[1..].to_string())),
                None => (short, None),
            };
            let name = specs
                .iter()
                .find(|spec| spec.short.is_some_and(|c| c.to_string() == letter))
                .map(|spec| spec.name.to_string())
                .unwrap_or_else(|| letter.to_string());
            (name, value)
        };
        let negated = name.strip_prefix("no-").and_then(|bare| find(&specs, bare).filter(|s| s.kind == OptionKind::Boolean));
        if let (Some(spec), None) = (negated, &inline) {
            set(&mut parsed.argv, spec.name, Value::Bool(false));
            continue;
        }
        let spec = find(&specs, &name).cloned();
        let key = spec.as_ref().map_or(name.clone(), |s| s.name.to_string());
        match spec.map(|s| s.kind) {
            Some(OptionKind::Boolean) => {
                let value = match inline.as_deref() {
                    Some(text) => text != "false",
                    None if matches!(args.get(i).map(String::as_str), Some("true" | "false")) => {
                        i += 1;
                        args[i - 1] == "true"
                    }
                    None => true,
                };
                set(&mut parsed.argv, &key, Value::Bool(value));
            }
            Some(OptionKind::List) => {
                let values = lists.entry(key.clone()).or_default();
                if let Some(text) = inline {
                    values.push(Value::String(text));
                }
                while i < args.len() && !is_flag(&args[i]) {
                    values.push(Value::String(args[i].clone()));
                    i += 1;
                }
                set(&mut parsed.argv, &key, Value::Array(values.clone()));
            }
            _ => {
                let value = match inline {
                    Some(text) => text,
                    None if i < args.len() && !is_flag(&args[i]) => {
                        i += 1;
                        args[i - 1].clone()
                    }
                    None => String::new(),
                };
                set(&mut parsed.argv, &key, Value::String(value));
            }
        }
    }
    for spec in &specs {
        if !parsed.argv.contains_key(spec.name) {
            if let Some(default) = &spec.default {
                set(&mut parsed.argv, spec.name, default.clone());
            }
        }
    }
    parsed
}

fn validate(parsed: &ParsedArgs, specs: &[OptionSpec], command: Option<&Command>) -> Result<(), UsageError> {
    if let Some((name, choices)) = command.and_then(|c| c.positional) {
        match parsed.positionals.first() {
            None => return Err(UsageError("Not enough non-option arguments: got 0, need at least 1".into())),
            Some(given) if !choices.contains(&given.as_str()) => {
                return Err(UsageError(format!(
                    "Invalid values:\n  Argument: {name}, Given: \"{given}\", Choices: {}",
                    choices.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join(", ")
                )));
            }
            Some(_) => {}
        }
    }
    let missing: Vec<&str> = specs.iter().filter(|s| s.demand && !parsed.argv.contains_key(s.name)).map(|s| s.name).collect();
    match missing.len() {
        0 => {}
        1 => return Err(UsageError(format!("Missing required argument: {}", missing[0]))),
        _ => return Err(UsageError(format!("Missing required arguments: {}", missing.join(", ")))),
    }
    for spec in specs.iter().filter(|s| !s.choices.is_empty()) {
        if let Some(Value::String(given)) = parsed.argv.get(spec.name) {
            if !spec.choices.contains(&given.as_str()) {
                return Err(UsageError(format!(
                    "Invalid values:\n  Argument: {}, Given: \"{given}\", Choices: {}",
                    spec.name,
                    spec.choices.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join(", ")
                )));
            }
        }
    }
    Ok(())
}

fn help_text(host: &ReleaseHost, globals: &[OptionSpec], all: &[Command]) -> String {
    let mut out = format!("{} <command>\n\nCommands:\n", host.command);
    let mut rows: Vec<(String, String)> = all
        .iter()
        .map(|c| {
            let usage = match c.positional {
                Some((name, _)) => format!("{} {} <{name}>", host.command, c.name),
                None => format!("{} {}", host.command, c.name),
            };
            (usage, c.describe.to_string())
        })
        .collect();
    rows.extend(host.subcommands.iter().map(|s| (format!("{} {}", host.command, s.name), s.describe.clone())));
    let width = rows.iter().map(|(u, _)| u.len()).max().unwrap_or(0);
    for (usage, describe) in rows {
        out.push_str(&format!("  {usage:width$}  {describe}\n"));
    }
    out.push_str("\nOptions:\n");
    for spec in globals {
        let short = spec.short.map(|c| format!("-{c}, ")).unwrap_or_default();
        out.push_str(&format!("  {short}--{}  {}\n", spec.name, spec.describe));
    }
    out.push_str("  --help  Show help\n");
    out
}

fn report(host: &ReleaseHost, diagnostics: &[ReleaseDiagnostic]) -> usize {
    let out = &host.output;
    for line in render_diagnostics(diagnostics, out.err_style()) {
        out.err_line(&line);
    }
    diagnostics.iter().filter(|d| d.severity == Severity::Error).count()
}

/// Print, and stop where anything is an error: a machine reads these answers.
fn refuse_on_errors(host: &ReleaseHost, diagnostics: &[ReleaseDiagnostic]) -> Option<i32> {
    if report(host, diagnostics) == 0 {
        return None;
    }
    let mut payload = Map::new();
    payload.insert("ok".into(), Value::Bool(false));
    payload.insert("diagnostics".into(), diagnostics_json(diagnostics));
    host.output.emit(payload);
    Some(1)
}

fn ok_payload(ok: bool) -> Map<String, Value> {
    let mut payload = Map::new();
    payload.insert("ok".into(), Value::Bool(ok));
    payload
}

fn merge(into: &mut Map<String, Value>, from: Map<String, Value>) {
    for (key, value) in from {
        into.insert(key, value);
    }
}

fn plan(host: &ReleaseHost, workspace: &ReleaseWorkspace, args: &ParsedArgs, candidate: Option<String>) -> Result<PlanRun, ReleaseError> {
    let out = host.output.clone();
    let progress = move |unit: &crate::units::ResolvedUnit, index: usize, total: usize| {
        out.progress(&out.err_style().dim(&format!("  [{}/{total}] {}", index + 1, unit.key)));
    };
    plan_workspace_release(
        host,
        workspace,
        &args.argv,
        &PlanOptions {
            base_ref: args.string("base").unwrap_or("origin/main"),
            carried_by: args.string("carried-by").filter(|r| !r.is_empty()),
            candidate,
            on_unit: Some(&progress),
        },
    )
}

/// `<kind>-<slug>.yaml`: the pending directory sorts by kind.
pub fn fragment_filename(kinds: &[FragmentKind], body: &str) -> String {
    let kind = kinds.first().copied().unwrap_or(FragmentKind::Fixed);
    let lower = body.to_lowercase();
    let mut slug = String::new();
    let mut dash = false;
    for c in lower.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            slug.push(c);
            dash = false;
        } else if !dash {
            slug.push('-');
            dash = true;
        }
    }
    let slug = slug.strip_prefix('-').unwrap_or(&slug);
    let slug = slug.strip_suffix('-').unwrap_or(slug);
    let slug = slug.split('-').take(6).collect::<Vec<_>>().join("-");
    let slug = if slug.is_empty() { "change".to_string() } else { slug };
    format!("{}-{slug}.yaml", kind.as_str().to_lowercase())
}

/// The unit `key` names, with a message listing what does exist.
pub fn require_unit(workspace: &ReleaseWorkspace, key: &str) -> Result<UnitKey, ReleaseError> {
    let normalized = normalize_unit_key(key);
    let normalized = if normalized.is_empty() { ".".to_string() } else { normalized };
    if workspace.units.iter().any(|u| u.key == normalized) {
        return Ok(normalized);
    }
    let near: Vec<&str> = workspace
        .units
        .iter()
        .filter(|u| u.key.ends_with(&format!("/{normalized}")) || normalized.starts_with(&format!("{}/", u.key)))
        .map(|u| u.key.as_str())
        .collect();
    let hint = if near.is_empty() {
        let listed: Vec<&str> = workspace.units.iter().take(8).map(|u| u.key.as_str()).collect();
        format!(
            " Units are named by workspace-relative directory: {}{}.",
            listed.join(", "),
            if workspace.units.len() > 8 { ", …" } else { "" }
        )
    } else {
        format!(
            " A unit is named by its workspace-relative directory — did you mean {}?",
            near.iter().map(|k| format!("'{k}'")).collect::<Vec<_>>().join(" or ")
        )
    };
    Err(ReleaseError::new(format!("'{key}' is not a unit in this workspace.{hint}")))
}

/// Today as `YYYY-MM-DD`, in UTC.
fn today() -> String {
    let days = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() / 86_400).unwrap_or(0) as i64;
    // Howard Hinnant's civil-from-days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

fn strings(items: impl IntoIterator<Item = String>) -> Value {
    Value::Array(items.into_iter().map(Value::String).collect())
}

fn run_command(host: &ReleaseHost, name: &str, args: &ParsedArgs, cwd: &Path) -> Result<i32, ReleaseError> {
    let out = host.output.clone();
    match name {
        "add" => {
            let kind_text = args.string("kind").unwrap_or("Fixed");
            let Some(kind) = FragmentKind::parse(kind_text) else {
                return Err(ReleaseError::new(format!(
                    "'{kind_text}' is not a release kind. Use Added, Changed, Deprecated, Removed, Fixed or Security."
                )));
            };
            let workspace = load_workspace_for(host, cwd)?;
            let mut units: IndexMap<UnitKey, FragmentKind> = IndexMap::new();
            for key in args.list("unit") {
                units.insert(require_unit(&workspace, &key)?, kind);
            }
            let body = args.string("body").unwrap_or("");
            let kinds: Vec<FragmentKind> = units.values().copied().collect();
            let source = write_fragment(&workspace.root, &fragment_filename(&kinds, body), &serialize_fragment(&units, body))?;
            out.line(&format!("{}  {source}", out.style().ok("✓")));
            let mut payload = ok_payload(true);
            payload.insert("fragment".into(), Value::String(source));
            payload.insert("units".into(), strings(units.keys().cloned()));
            out.emit(payload);
            Ok(0)
        }
        "status" => {
            let workspace = load_workspace_for(host, cwd)?;
            let run = plan(host, &workspace, args, None)?;
            for line in render_plan(&run.plan, out.style()) {
                out.line(&line);
            }
            report(host, &run.plan.diagnostics);
            let mut payload = ok_payload(true);
            merge(&mut payload, plan_payload(&run.plan));
            out.emit(payload);
            Ok(0)
        }
        "order" => {
            let workspace = load_workspace_for(host, cwd)?;
            let (rows, diagnostics) = order_rows(host, &workspace, &args.argv)?;
            if let Some(code) = refuse_on_errors(host, &diagnostics) {
                return Ok(code);
            }
            report(host, &diagnostics);
            for row in &rows {
                out.line(
                    &[row.key.as_str(), row.ecosystem.as_deref().unwrap_or(""), &row.path, &row.version, row.destination.as_deref().unwrap_or("")]
                        .join("\t"),
                );
            }
            let mut payload = ok_payload(true);
            payload.insert("order".into(), Value::Array(rows.iter().map(|r| r.to_json()).collect()));
            out.emit(payload);
            Ok(0)
        }
        "check" => {
            let workspace = load_workspace_for(host, cwd)?;
            let run = plan(host, &workspace, args, None)?;
            for line in render_plan(&run.plan, out.style()) {
                out.line(&line);
            }
            let errors = report(host, &run.plan.diagnostics);
            let (extra_ok, extra) = match &host.check {
                Some(check) => {
                    let outcome = check(&workspace, &run.plan, &args.argv)?;
                    (outcome.ok, outcome.payload)
                }
                None => (true, Map::new()),
            };
            let ok = errors == 0 && extra_ok;
            let mut payload = ok_payload(ok);
            merge(&mut payload, plan_payload(&run.plan));
            merge(&mut payload, extra);
            out.emit(payload);
            Ok(if ok { 0 } else { 1 })
        }
        "apply" => {
            let candidate = candidate_id(args.string("candidate"))?;
            let workspace = load_workspace_for(host, cwd)?;
            let run = plan(host, &workspace, args, candidate)?;
            if report(host, &run.plan.diagnostics) > 0 {
                let mut payload = ok_payload(false);
                merge(&mut payload, plan_payload(&run.plan));
                out.emit(payload);
                return Ok(1);
            }
            if run.plan.units.is_empty() {
                out.line("Nothing to release — every unit matches the ledger.");
                let mut payload = ok_payload(true);
                payload.insert("units".into(), Value::Array(Vec::new()));
                payload.insert("written".into(), Value::Array(Vec::new()));
                out.emit(payload);
                return Ok(0);
            }
            let date = args.string("date").map(str::to_string).unwrap_or_else(today);
            let (applied, written) = apply_plan(host, &workspace, &run, &args.argv, &date)?;
            for unit in &applied {
                out.line(&format!("{}  {}  {} → {}", out.style().ok("✓"), unit.key, unit.from, unit.to));
            }
            for file in &written {
                out.line(&format!("   {}", out.style().dim(file)));
            }
            let mut payload = ok_payload(true);
            merge(&mut payload, plan_payload(&run.plan));
            payload.insert("written".into(), strings(written));
            out.emit(payload);
            Ok(0)
        }
        "verify" => {
            let workspace = load_workspace_for(host, cwd)?;
            let progress_out = out.clone();
            let progress = move |text: &str| progress_out.progress(&progress_out.err_style().dim(text));
            let verified = verify_ledger(host, &workspace, &args.argv, &progress)?;
            if let Some(code) = refuse_on_errors(host, &verified.diagnostics) {
                return Ok(code);
            }
            for finding in &verified.findings {
                let label = if finding.kind == "drift" { out.err_style().warn("drift") } else { out.err_style().dim("unverifiable") };
                out.err_line(&format!("{label}  {} {}: {}", finding.key, finding.layer, finding.detail));
            }
            let drifted: Vec<_> = verified.findings.iter().filter(|f| f.kind == "drift").collect();
            let write = args.flag("write");
            if write {
                write_ledger(&workspace.root, &verified.ledger)?;
                out.line(&format!("{}  {LEDGER_PATH} re-recorded from the registries", out.style().ok("✓")));
            } else if drifted.is_empty() {
                out.line(&format!("{}  {LEDGER_PATH} matches the registries", out.style().ok("✓")));
            }
            let mut payload = ok_payload(drifted.is_empty() || write);
            payload.insert("drifted".into(), Value::Array(drifted.iter().map(|f| f.to_json()).collect()));
            payload.insert(
                "unverifiable".into(),
                Value::Array(verified.findings.iter().filter(|f| f.kind == "unverifiable").map(|f| f.to_json()).collect()),
            );
            out.emit(payload);
            Ok(if !drifted.is_empty() && !write { 1 } else { 0 })
        }
        "tag" => {
            let dry_run = args.flag("dry-run");
            let workspace = load_workspace_for(host, cwd)?;
            let tags = tags_to_create(host, &workspace)?;
            if !dry_run {
                create_tags(&workspace, &tags)?;
            }
            for tag in &tags {
                let note = if tag.exists { out.style().dim("  (already on HEAD)") } else { String::new() };
                out.line(&format!("{}  {}{note}", out.style().ok("✓"), tag.tag));
            }
            if tags.is_empty() {
                out.line("Nothing to tag — the last commit moved no unit's version.");
            }
            let mut payload = ok_payload(true);
            payload.insert("tags".into(), strings(tags.iter().map(|t| t.tag.clone())));
            payload.insert("dryRun".into(), Value::Bool(dry_run));
            out.emit(payload);
            Ok(0)
        }
        "adopt" => {
            let result = adopt_changesets(host, cwd, &args.argv)?;
            for file in &result.written {
                out.line(&format!("{}  {file}", out.style().ok("✓")));
            }
            for file in &result.deleted {
                out.line(&format!("{}  deleted {file}", out.style().ok("✓")));
            }
            for left in &result.left_behind {
                out.err_line(&format!("{}  {left}", out.err_style().warn("rewrite")));
            }
            let mut payload = ok_payload(true);
            payload.insert("root".into(), Value::String(result.root.display().to_string()));
            payload.insert("written".into(), strings(result.written));
            payload.insert("deleted".into(), strings(result.deleted));
            payload.insert("leftBehind".into(), strings(result.left_behind));
            out.emit(payload);
            Ok(0)
        }
        other => match host.subcommands.iter().find(|s| s.name == other) {
            Some(sub) => (sub.run)(host, args).map(|()| 0),
            None => unreachable!("an unknown command is refused before it runs"),
        },
    }
}

/// Run one command line against `host`, from `cwd`; answers the exit status.
pub fn release_commands(host: &ReleaseHost, args: &[String], cwd: &Path) -> i32 {
    release_commands_with(host, args, cwd, &|_| {})
}

/// `release_commands`, with `middleware` shown the parsed line before
/// anything is written — where a host reads its own global options.
pub fn release_commands_with(host: &ReleaseHost, args: &[String], cwd: &Path, middleware: &dyn Fn(&ParsedArgs)) -> i32 {
    let globals = global_options(host);
    let all = commands();
    let mut table: Vec<(String, Vec<OptionSpec>)> = all.iter().map(|c| (c.name.to_string(), c.options.clone())).collect();
    table.extend(host.subcommands.iter().map(|s| (s.name.clone(), s.options.clone())));
    let parsed = parse_args(args, &globals, &table);
    middleware(&parsed);
    if parsed.help {
        print!("{}", help_text(host, &globals, &all));
        return 0;
    }
    let Some(name) = parsed.command.clone() else {
        host.output.err_line("Specify a release subcommand");
        return 2;
    };
    let Some((_, command_options)) = table.iter().find(|(n, _)| *n == name) else {
        host.output.err_line(&format!("Unknown argument: {name}"));
        return 2;
    };
    let mut specs = globals.clone();
    specs.extend(command_options.iter().cloned());
    if let Err(UsageError(message)) = validate(&parsed, &specs, all.iter().find(|c| c.name == name)) {
        host.output.err_line(&message);
        return 2;
    }
    match run_command(host, &name, &parsed, cwd) {
        Ok(code) => code,
        Err(err) => {
            let out = &host.output;
            out.err_line(&format!("{}  {}", out.err_style().error("error"), err.message));
            out.emit(ok_payload(false));
            1
        }
    }
}
