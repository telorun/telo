//! The two vocabularies a release speaks, and the arithmetic between them.
//!
//! A **kind** is what an author writes in a fragment (`Added`, `Fixed`, …): it
//! decides both the level of the bump and the changelog section the entry
//! lands under. A **level** is what the version arithmetic consumes. An
//! unrecognised kind is refused rather than defaulted.

use std::cmp::Ordering;

use crate::locale_order::locale_compare;
use crate::ReleaseError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum BumpLevel {
    Patch,
    Minor,
    Major,
}

pub const BUMP_LEVELS: [BumpLevel; 3] = [BumpLevel::Patch, BumpLevel::Minor, BumpLevel::Major];

impl BumpLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            BumpLevel::Patch => "patch",
            BumpLevel::Minor => "minor",
            BumpLevel::Major => "major",
        }
    }

    pub fn parse(text: &str) -> Option<BumpLevel> {
        match text {
            "patch" => Some(BumpLevel::Patch),
            "minor" => Some(BumpLevel::Minor),
            "major" => Some(BumpLevel::Major),
            _ => None,
        }
    }
}

pub fn max_level(a: BumpLevel, b: BumpLevel) -> BumpLevel {
    a.max(b)
}

/// Whether `level` is above `ceiling`.
pub fn level_exceeds(level: BumpLevel, ceiling: BumpLevel) -> bool {
    level > ceiling
}

/// Fragment kinds, in changelog section order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FragmentKind {
    Added,
    Changed,
    Deprecated,
    Removed,
    Fixed,
    Security,
}

pub const FRAGMENT_KIND_ORDER: [FragmentKind; 6] = [
    FragmentKind::Added,
    FragmentKind::Changed,
    FragmentKind::Deprecated,
    FragmentKind::Removed,
    FragmentKind::Fixed,
    FragmentKind::Security,
];

impl FragmentKind {
    pub fn as_str(self) -> &'static str {
        match self {
            FragmentKind::Added => "Added",
            FragmentKind::Changed => "Changed",
            FragmentKind::Deprecated => "Deprecated",
            FragmentKind::Removed => "Removed",
            FragmentKind::Fixed => "Fixed",
            FragmentKind::Security => "Security",
        }
    }

    pub fn parse(text: &str) -> Option<FragmentKind> {
        FRAGMENT_KIND_ORDER.into_iter().find(|kind| kind.as_str() == text)
    }

    pub fn level(self) -> BumpLevel {
        match self {
            FragmentKind::Added | FragmentKind::Deprecated => BumpLevel::Minor,
            FragmentKind::Changed | FragmentKind::Removed => BumpLevel::Major,
            FragmentKind::Fixed | FragmentKind::Security => BumpLevel::Patch,
        }
    }
}

fn digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

/// `major.minor.patch` as three digit runs.
fn release_parts(text: &str) -> Option<[&str; 3]> {
    let mut parts = text.split('.');
    let (a, b, c) = (parts.next()?, parts.next()?, parts.next()?);
    (parts.next().is_none() && digits(a) && digits(b) && digits(c)).then_some([a, b, c])
}

pub fn is_release_version(text: &str) -> bool {
    release_parts(text).is_some()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CandidateVersion {
    pub final_version: String,
    pub id: String,
    pub k: u64,
}

/// `<final>-<id>.<k>`: `id` an identifier, `k` from 1.
pub fn parse_candidate_version(text: &str) -> Option<CandidateVersion> {
    let (final_version, rest) = text.split_once('-')?;
    if !is_release_version(final_version) {
        return None;
    }
    let (id, k) = rest.split_once('.')?;
    if !is_candidate_id(id) || !digits(k) || k.starts_with('0') {
        return None;
    }
    Some(CandidateVersion { final_version: final_version.to_string(), id: id.to_string(), k: k.parse().ok()? })
}

/// A final version or a candidate of one.
pub fn is_unit_version(text: &str) -> bool {
    is_release_version(text) || parse_candidate_version(text).is_some()
}

pub fn is_candidate_id(text: &str) -> bool {
    let mut chars = text.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic()) && chars.all(|c| c.is_ascii_alphanumeric())
}

pub fn candidate_version(final_version: &str, id: &str, k: u64) -> String {
    format!("{final_version}-{id}.{k}")
}

fn number(part: &str) -> f64 {
    part.parse::<f64>().unwrap_or(f64::INFINITY)
}

/// Apply `level` to a final `version`.
pub fn apply_bump(version: &str, level: BumpLevel) -> Result<String, ReleaseError> {
    let parts = release_parts(version).ok_or_else(|| {
        ReleaseError::new(format!(
            "'{version}' is not a major.minor.patch version, so no {} bump can be derived from it.",
            level.as_str()
        ))
    })?;
    let [major, minor, patch] = parts.map(number);
    let show = |n: f64| format!("{n:.0}");
    Ok(match level {
        BumpLevel::Major => format!("{}.0.0", show(major + 1.0)),
        BumpLevel::Minor => format!("{}.{}.0", show(major), show(minor + 1.0)),
        BumpLevel::Patch => format!("{}.{}.{}", show(major), show(minor), show(patch + 1.0)),
    })
}

/// Numeric comparison of final versions; an unparseable one sorts last.
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    match (release_parts(a), release_parts(b)) {
        (Some(pa), Some(pb)) => {
            for i in 0..3 {
                let diff = number(pa[i]) - number(pb[i]);
                if diff != 0.0 {
                    return if diff < 0.0 { Ordering::Less } else { Ordering::Greater };
                }
            }
            Ordering::Equal
        }
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => locale_compare(a, b),
    }
}
