//! A unit's `CHANGELOG.md` entry, and splicing it into the file.
//!
//! The block is `## <version> - <date>`, `### <Kind>`, `* <body>`, prepended
//! below the file's `# Changelog` heading; everything already written stays
//! untouched bytes. A changelog started under another first heading keeps its
//! history below, its heading becoming `# Changelog`.

use crate::bump_level::{FragmentKind, FRAGMENT_KIND_ORDER};

pub const CHANGELOG_HEADER: &str = "# Changelog";

/// Where a unit's changelog lives, relative to the unit.
pub const CHANGELOG_FILE: &str = "CHANGELOG.md";

pub struct ChangelogRelease<'a> {
    pub version: &'a str,
    /// `YYYY-MM-DD`.
    pub date: &'a str,
    pub entries: Vec<(FragmentKind, &'a str)>,
}

pub fn render_changelog_release(release: &ChangelogRelease<'_>) -> String {
    let mut lines = vec![format!("## {} - {}", release.version, release.date)];
    for kind in FRAGMENT_KIND_ORDER {
        let bodies: Vec<&str> = release.entries.iter().filter(|(k, _)| *k == kind).map(|(_, body)| *body).collect();
        if bodies.is_empty() {
            continue;
        }
        lines.push(format!("### {}", kind.as_str()));
        for body in bodies {
            lines.push(format!("* {body}"));
        }
    }
    lines.join("\n") + "\n"
}

/// `/^#[ \t]+[^\n]*(\n|$)/`: the first line when it is a first-level heading.
fn first_heading(text: &str) -> Option<&str> {
    let rest = text.strip_prefix('#')?;
    if !rest.starts_with([' ', '\t']) {
        return None;
    }
    let trimmed = rest.trim_start_matches([' ', '\t']);
    if trimmed.len() == rest.len() {
        return None;
    }
    Some(match text.find('\n') {
        Some(nl) => &text[..=nl],
        None => text,
    })
}

/// `/^#[ \t]+Changelog\b/`
fn is_changelog_heading(heading: &str) -> bool {
    let rest = heading[1..].trim_start_matches([' ', '\t']);
    rest.strip_prefix("Changelog")
        .is_some_and(|after| !after.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_'))
}

/// Insert a release block below the file's first-level heading, which becomes
/// `# Changelog`; a file with no such heading gets one.
pub fn prepend_changelog_release(existing: Option<&str>, block: &str) -> String {
    let text = existing.unwrap_or("");
    let Some(heading) = first_heading(text) else {
        let rest = text.trim();
        let tail = if rest.is_empty() { String::new() } else { format!("\n{rest}\n") };
        return format!("{CHANGELOG_HEADER}\n\n{block}{tail}");
    };
    let kept = if is_changelog_heading(heading) {
        if heading.ends_with('\n') { heading.to_string() } else { format!("{heading}\n") }
    } else {
        format!("{CHANGELOG_HEADER}\n")
    };
    let after = text[heading.len()..].trim_start_matches('\n');
    let tail = if after.is_empty() { String::new() } else { format!("\n{after}") };
    format!("{kept}\n{block}{tail}")
}
