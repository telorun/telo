//! A release plan as a CommonMark document — release notes or a release PR's
//! body with no renderer of the host's own. Headings are levels 2 and 3 only:
//! the host owns level 1 and any introduction.
//!
//! Units carrying changelog entries come first, each under its own heading
//! with its entries exactly as `CHANGELOG.md` shows them; the rest share one
//! closing section. With a limit the document is the first stage that fits it,
//! each stage giving up what a reader needs least and saying so; with none
//! nothing is cut. Lengths count Unicode code points, the trailing newline
//! included.

use crate::bump_level::FragmentKind;
use crate::bump_reason_text::describe_reasons_with;
use crate::changelog::render_changelog_entries;
use crate::release_plan::{PlannedUnit, ReleasePlan};
use crate::ReleaseError;

/// What an empty plan says, in every output.
pub const NOTHING_TO_RELEASE: &str = "Nothing to release — every unit matches the ledger.";

/// No entry is cut shorter than this.
pub const MIN_ENTRY_CAP: usize = 200;

const NO_ENTRY_HEADING: &str = "## Units with no changelog entry";

pub fn code_point_length(text: &str) -> usize {
    text.chars().count()
}

/// `text` as a code span, its fence longer than any backtick run inside it.
fn code(text: &str) -> String {
    let mut longest = 0;
    let mut run = 0;
    for c in text.chars() {
        run = if c == '`' { run + 1 } else { 0 };
        longest = longest.max(run);
    }
    let fence = "`".repeat(longest + 1);
    let pad = if text.starts_with('`') || text.ends_with('`') { " " } else { "" };
    format!("{fence}{pad}{text}{pad}{fence}")
}

fn note(text: &str) -> String {
    format!("_{text}_")
}

/// Whitespace runs as one space, ends trimmed — the same set in both halves.
fn flatten(body: &str) -> String {
    body.split([' ', '\t', '\n', '\r', '\x0c', '\x0b']).filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ")
}

/// A body over `cap` code points, flattened and cut at its last space before
/// the cap (hard at the cap when it has none), ending in "…"; else `None`.
pub fn cut_entry(body: &str, cap: usize) -> Option<String> {
    let points: Vec<char> = flatten(body).chars().collect();
    if points.len() <= cap {
        return None;
    }
    let head = &points[..cap - 1];
    let mut end = head.len();
    if points[cap - 1] != ' ' {
        if let Some(space) = head.iter().rposition(|c| *c == ' ') {
            end = space;
        }
    }
    Some(head[..end].iter().collect::<String>() + "…")
}

fn unit_heading(unit: &PlannedUnit) -> String {
    format!("## {} {} → {}", code(&unit.key), unit.from, unit.to)
}

fn why(unit: &PlannedUnit) -> String {
    format!("{} — {}", unit.level.as_str(), describe_reasons_with(&unit.reasons, &code))
}

fn tag_line(unit: &PlannedUnit) -> String {
    match &unit.group {
        Some(group) => format!("Group {} · tag {}", code(group), code(&unit.tag)),
        None => format!("Tag {}", code(&unit.tag)),
    }
}

fn new_versions(units: &[&PlannedUnit]) -> String {
    format!("{}.", units.iter().map(|unit| format!("{} {}", code(&unit.key), unit.to)).collect::<Vec<_>>().join(", "))
}

struct Detail {
    /// The no-entry section as one paragraph, reasons dropped.
    compact: bool,
    /// The cap entries are cut to, when cutting.
    cap: Option<usize>,
}

fn described(plan: &ReleasePlan, detail: &Detail) -> String {
    let with_entries: Vec<&PlannedUnit> = plan.units.iter().filter(|unit| !unit.entries.is_empty()).collect();
    let without: Vec<&PlannedUnit> = plan.units.iter().filter(|unit| unit.entries.is_empty()).collect();
    let mut blocks: Vec<String> = Vec::new();
    let mut cut = false;
    for unit in &with_entries {
        let bodies: Vec<(FragmentKind, String)> = unit
            .entries
            .iter()
            .map(|entry| {
                let shortened = detail.cap.and_then(|cap| cut_entry(&entry.body, cap));
                cut |= shortened.is_some();
                (entry.kind, shortened.unwrap_or_else(|| entry.body.clone()))
            })
            .collect();
        let entries: Vec<(FragmentKind, &str)> = bodies.iter().map(|(kind, body)| (*kind, body.as_str())).collect();
        let mut lines = vec![unit_heading(unit), String::new(), why(unit), String::new(), tag_line(unit), String::new()];
        lines.extend(render_changelog_entries(&entries));
        blocks.push(lines.join("\n"));
    }
    if !without.is_empty() {
        let lines = if detail.compact {
            vec![
                NO_ENTRY_HEADING.to_string(),
                String::new(),
                new_versions(&without),
                String::new(),
                note("Their reasons, groups and tags are left out to fit the length limit."),
            ]
        } else {
            let mut lines = vec![NO_ENTRY_HEADING.to_string(), String::new()];
            lines.extend(without.iter().map(|unit| {
                let group = unit.group.as_ref().map(|g| format!(" · group {}", code(g))).unwrap_or_default();
                format!("- {} {} → {} · {}{group} · tag {}", code(&unit.key), unit.from, unit.to, why(unit), code(&unit.tag))
            }));
            lines
        };
        blocks.push(lines.join("\n"));
    }
    if cut {
        blocks.insert(0, note("Entries cut to fit the length limit end in “…”."));
    }
    blocks.join("\n\n") + "\n"
}

fn listed(plan: &ReleasePlan) -> String {
    let units: Vec<&PlannedUnit> = plan.units.iter().collect();
    format!("{}\n\n{}\n", new_versions(&units), note("Changelog entries, reasons and tags are left out to fit the length limit."))
}

fn counted(plan: &ReleasePlan) -> String {
    let carrying = plan.units.iter().filter(|unit| !unit.entries.is_empty()).count();
    let moving = if plan.units.len() == 1 { "1 unit moves".to_string() } else { format!("{} units move", plan.units.len()) };
    format!("{moving}, {carrying} with changelog entries; the list is left out to fit the length limit.\n")
}

/// The largest cap at or above [`MIN_ENTRY_CAP`] whose document fits, if any.
fn fitting_cap(plan: &ReleasePlan, max_length: usize) -> Option<String> {
    let longest =
        plan.units.iter().flat_map(|unit| unit.entries.iter().map(|entry| code_point_length(&flatten(&entry.body)))).max().unwrap_or(0);
    let mut low = MIN_ENTRY_CAP;
    let mut high = longest.saturating_sub(1);
    let mut best = None;
    while low <= high {
        let cap = (low + high) / 2;
        let document = described(plan, &Detail { compact: true, cap: Some(cap) });
        if code_point_length(&document) <= max_length {
            best = Some(document);
            low = cap + 1;
        } else {
            high = cap - 1;
        }
    }
    best
}

/// The plan's document. With `max_length`, the first stage within it: the
/// whole document; the no-entry section compacted; long entries cut; every
/// unit as one paragraph; one counting sentence. A plan no stage fits is
/// refused, naming the shortest length its document can take.
pub fn render_plan_markdown(plan: &ReleasePlan, max_length: Option<usize>) -> Result<String, ReleaseError> {
    if plan.units.is_empty() {
        let empty = format!("{NOTHING_TO_RELEASE}\n");
        return match max_length {
            Some(max) if code_point_length(&empty) > max => Err(refusal(code_point_length(&empty), max)),
            _ => Ok(empty),
        };
    }
    let full = described(plan, &Detail { compact: false, cap: None });
    let Some(max) = max_length.filter(|max| code_point_length(&full) > *max) else {
        return Ok(full);
    };
    let has_no_entry_units = plan.units.iter().any(|unit| unit.entries.is_empty());
    let stages: [&dyn Fn() -> Option<String>; 4] = [
        &|| has_no_entry_units.then(|| described(plan, &Detail { compact: true, cap: None })),
        &|| fitting_cap(plan, max),
        &|| Some(listed(plan)),
        &|| Some(counted(plan)),
    ];
    let mut shortest = code_point_length(&full);
    for stage in stages {
        let Some(document) = stage() else { continue };
        let length = code_point_length(&document);
        if length <= max {
            return Ok(document);
        }
        shortest = shortest.min(length);
    }
    Err(refusal(shortest, max))
}

fn refusal(shortest: usize, max_length: usize) -> ReleaseError {
    ReleaseError::new(format!("No markdown document of this plan fits in {max_length} code points: the shortest takes {shortest}."))
}
