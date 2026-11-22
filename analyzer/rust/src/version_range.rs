//! The version-range grammar `requires:` declares, and the only one Telo reads. Mirrors
//! `../../nodejs/src/version-range.ts` over `module_version_order`'s precedence: a range is a
//! conjunction of explicit comparators (`>=0.80.0`, `>=0.40.0 <0.50.0`, `>=0.40.0,<0.50.0`);
//! `^` / `~`, a bare version, `||`, hyphen ranges and wildcards are refused, each with the
//! spelling to write instead where there is one. A need's `version:` reads the same grammar,
//! worded for that reading. Prereleases compare by plain precedence.

use std::cmp::Ordering;

use serde_json::Value;

use crate::module_version_order::{compare_parsed_module_versions, parse_module_version, ParsedModuleVersion};
use crate::position_metadata::is_js_whitespace;

/// The comparison a single term applies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComparatorOperator {
    AtLeast,
    Above,
    AtMost,
    Below,
}

impl ComparatorOperator {
    /// The operator as written.
    pub fn text(self) -> &'static str {
        match self {
            Self::AtLeast => ">=",
            Self::Above => ">",
            Self::AtMost => "<=",
            Self::Below => "<",
        }
    }

    pub fn is_lower(self) -> bool {
        matches!(self, Self::AtLeast | Self::Above)
    }

    pub fn is_upper(self) -> bool {
        matches!(self, Self::AtMost | Self::Below)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionComparator {
    pub operator: ComparatorOperator,
    /// The version as authored, for diagnostics and for the existence check.
    pub raw: String,
    pub parsed: ParsedModuleVersion,
}

/// A parsed range: every comparator must hold. Never empty, except for the `>=unreleased`
/// floor, which `requires_block` reads as `unreleased` with no comparator.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionRange {
    /// The range exactly as authored, quoted verbatim in diagnostics.
    pub raw: String,
    pub comparators: Vec<VersionComparator>,
    /// `>=unreleased`: met only by a build of the pending telo release, whose version carries
    /// the `+unreleased` build identifier.
    pub unreleased: bool,
}

/// Why a range string was refused, and the spelling to use instead when there is an
/// unambiguous one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionRangeError {
    pub message: String,
    pub hint: Option<String>,
}

/// What a range is being read for, which decides how a refusal explains itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RangeReading {
    Requires,
    Need,
}

/// Operators longest-first, so `>=` is matched before `>`.
const OPERATORS: [ComparatorOperator; 4] =
    [ComparatorOperator::AtLeast, ComparatorOperator::AtMost, ComparatorOperator::Above, ComparatorOperator::Below];

fn refuse(message: String, hint: Option<String>) -> Result<VersionRange, VersionRangeError> {
    Err(VersionRangeError { message, hint })
}

/// Refuse with `>=<version>` as the hint — only when that hint would itself parse.
fn hinted_refusal(message: String, version: &str) -> Result<VersionRange, VersionRangeError> {
    let hint = parse_module_version(version).map(|_| format!(">={version}"));
    refuse(message, hint)
}

/// ECMAScript's `trim`.
pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// The first ` - ` a hyphen range is split at (`/\s-\s/`), as its byte offset.
fn hyphen_at(text: &str) -> Option<usize> {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    chars.windows(3).find_map(|w| (is_js_whitespace(w[0].1) && w[1].1 == '-' && is_js_whitespace(w[2].1)).then_some(w[0].0))
}

/// `/(^|\.)[x*]$/i` or `/(^|\.)[x*]\./i`: a segment that is an `x` or `*` placeholder, at any
/// position.
fn is_wildcard(term: &str) -> bool {
    term.split('.').any(|segment| matches!(segment, "x" | "X" | "*"))
}

/// Parse a range, or explain why it cannot be one. Never degrades to a permissive reading.
pub fn parse_version_range(raw: Option<&Value>, reading: RangeReading) -> Result<VersionRange, VersionRangeError> {
    let text = match raw {
        Some(Value::String(text)) if !js_trim(text).is_empty() => js_trim(text),
        other => return refuse(format!("expected a version range string, got {}", describe(other)), None),
    };

    if text.contains("||") {
        return refuse(
            match reading {
                RangeReading::Need => format!(
                    "'{text}' is a disjunction. A need's range must be a conjunction of comparators, because a need forwarded whole must state a range within the one it supplies, and containment is decided over the single interval a conjunction bounds"
                ),
                RangeReading::Requires => format!(
                    "'{text}' is a disjunction. A range must be a conjunction of comparators, because verification runs the CLI at its lowest and highest bound and a disjunction has neither"
                ),
            },
            None,
        );
    }
    if let Some(at) = hyphen_at(text) {
        return refuse(
            format!("'{text}' is a hyphen range"),
            Some(format!("{} rewritten as '>=' and '<=' comparators", js_trim(&text[..at]))),
        );
    }

    let terms = text.split(|c: char| is_js_whitespace(c) || c == ',').filter(|t| !t.is_empty());
    let mut comparators = Vec::new();

    for term in terms {
        if let Some(first) = term.chars().next().filter(|c| *c == '^' || *c == '~') {
            let version = &term[1..];
            let parsed = parse_module_version(version);
            let upper = match &parsed {
                Some(parsed) if parsed.major == 0 => format!("0.{}.0", parsed.minor.saturating_add(1)),
                Some(parsed) => format!("{}.0.0", parsed.major.saturating_add(1)),
                None => "1.0.0".to_string(),
            };
            return refuse(
                match reading {
                    RangeReading::Need => format!(
                        "'{term}' is not accepted: '{first}' would admit {version} up to {upper}, and a need's range states both bounds as comparators"
                    ),
                    RangeReading::Requires => format!(
                        "'{term}' is not accepted. Pre-1.0, '{first}' allows only {version} up to {upper}, and Telo ships breaking changes as minor bumps — so it pins this module to a single release generation, which is almost never what is meant"
                    ),
                },
                Some(match reading {
                    RangeReading::Need => format!(">={version} <{upper}"),
                    RangeReading::Requires => format!(">={version}"),
                }),
            );
        }
        if is_wildcard(term) {
            return refuse(format!("'{term}' is a wildcard range; write explicit comparators instead"), None);
        }
        if term.starts_with('=') {
            return hinted_refusal(format!("'{term}' pins one exact version"), term.trim_start_matches('='));
        }

        let Some(operator) = OPERATORS.into_iter().find(|op| term.starts_with(op.text())) else {
            return hinted_refusal(
                format!(
                    "'{term}' has no comparator. A bare version reads as an exact pin in semver, which is almost never meant here"
                ),
                term,
            );
        };
        let version = js_trim(&term[operator.text().len()..]);
        let Some(parsed) = parse_module_version(version) else {
            return refuse(
                format!("'{version}' in '{term}' is not a three-part version (X.Y.Z, optionally -prerelease)"),
                None,
            );
        };
        comparators.push(VersionComparator { operator, raw: version.to_string(), parsed });
    }

    if comparators.is_empty() {
        return refuse(format!("'{text}' declares no comparator"), None);
    }
    Ok(VersionRange { raw: text.to_string(), comparators, unreleased: false })
}

/// A version with its build metadata split off: precedence ignores it, and the `unreleased`
/// identifier is what a build of a pending release carries.
pub fn split_build_metadata(version: &str) -> (&str, bool) {
    match version.find('+') {
        None => (version, false),
        Some(plus) => (&version[..plus], version[plus + 1..].split('.').any(|id| id == "unreleased")),
    }
}

fn holds(comparator: &VersionComparator, parsed: &ParsedModuleVersion) -> bool {
    let order = compare_parsed_module_versions(parsed, &comparator.parsed);
    match comparator.operator {
        ComparatorOperator::AtLeast => order != Ordering::Less,
        ComparatorOperator::Above => order == Ordering::Greater,
        ComparatorOperator::AtMost => order != Ordering::Greater,
        ComparatorOperator::Below => order == Ordering::Less,
    }
}

/// Whether `version` satisfies every comparator. An unparseable `version` is `false` — never a
/// pass. Build metadata is ignored by the comparators, and is what the `unreleased` floor reads.
pub fn range_accepts(range: &VersionRange, version: &str) -> bool {
    let (core, unreleased) = split_build_metadata(version);
    let Some(parsed) = parse_module_version(core) else { return false };
    if range.unreleased && !unreleased {
        return false;
    }
    range.comparators.iter().all(|c| holds(c, &parsed))
}

/// The binding lower bound, or `None` when the range is open below.
pub fn lower_bound(range: &VersionRange) -> Option<&VersionComparator> {
    tightest(range, ComparatorOperator::is_lower, Ordering::Greater)
}

/// The binding upper bound, or `None` when the range is open above.
pub fn upper_bound(range: &VersionRange) -> Option<&VersionComparator> {
    tightest(range, ComparatorOperator::is_upper, Ordering::Less)
}

/// Of the comparators `side` selects, the first one no later one is `beyond` — the
/// tightest, the earlier winning a tie.
fn tightest(range: &VersionRange, side: fn(ComparatorOperator) -> bool, beyond: Ordering) -> Option<&VersionComparator> {
    range.comparators.iter().filter(|c| side(c.operator)).fold(None, |best: Option<&VersionComparator>, c| match best {
        Some(best) if compare_parsed_module_versions(&c.parsed, &best.parsed) != beyond => Some(best),
        _ => Some(c),
    })
}

/// One edge of a [`VersionInterval`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionIntervalBound {
    pub version: String,
    pub inclusive: bool,
}

/// A range reduced to its binding edges; an absent edge is open.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VersionInterval {
    pub min: Option<VersionIntervalBound>,
    pub max: Option<VersionIntervalBound>,
}

/// The interval `range` admits: its tightest lower and upper comparators, an exclusive one
/// winning a tie at the same version.
pub fn range_interval(range: &VersionRange) -> VersionInterval {
    let tightest = |side: fn(ComparatorOperator) -> bool, beyond: Ordering, exclusive: ComparatorOperator| {
        range.comparators.iter().filter(|c| side(c.operator)).fold(None, |best: Option<&VersionComparator>, c| match best {
            None => Some(c),
            Some(best) => {
                let order = compare_parsed_module_versions(&c.parsed, &best.parsed);
                if order == beyond || (order == Ordering::Equal && c.operator == exclusive) {
                    Some(c)
                } else {
                    Some(best)
                }
            }
        })
    };
    let bound = |c: &VersionComparator, inclusive: ComparatorOperator| VersionIntervalBound {
        version: c.raw.clone(),
        inclusive: c.operator == inclusive,
    };
    VersionInterval {
        min: tightest(ComparatorOperator::is_lower, Ordering::Greater, ComparatorOperator::Above)
            .map(|c| bound(c, ComparatorOperator::AtLeast)),
        max: tightest(ComparatorOperator::is_upper, Ordering::Less, ComparatorOperator::Below)
            .map(|c| bound(c, ComparatorOperator::AtMost)),
    }
}

/// True when every version `inner` admits, `outer` admits too, decided on the two ranges'
/// exact intervals.
pub fn range_within(inner: &VersionRange, outer: &VersionRange) -> bool {
    let (a, b) = (range_interval(inner), range_interval(outer));
    let order = |x: &VersionIntervalBound, y: &VersionIntervalBound| match (
        parse_module_version(&x.version),
        parse_module_version(&y.version),
    ) {
        (Some(x), Some(y)) => compare_parsed_module_versions(&x, &y),
        _ => Ordering::Equal,
    };
    if let Some(b_min) = &b.min {
        let Some(a_min) = &a.min else { return false };
        let cmp = order(a_min, b_min);
        if cmp == Ordering::Less || (cmp == Ordering::Equal && a_min.inclusive && !b_min.inclusive) {
            return false;
        }
    }
    if let Some(b_max) = &b.max {
        let Some(a_max) = &a.max else { return false };
        let cmp = order(a_max, b_max);
        if cmp == Ordering::Greater || (cmp == Ordering::Equal && a_max.inclusive && !b_max.inclusive) {
            return false;
        }
    }
    true
}

/// True when no version can satisfy the range — `>=0.90.0 <0.80.0`.
pub fn is_unsatisfiable(range: &VersionRange) -> bool {
    let (Some(low), Some(high)) = (lower_bound(range), upper_bound(range)) else { return false };
    match compare_parsed_module_versions(&low.parsed, &high.parsed) {
        Ordering::Greater => true,
        // `>=X <X` and `>X <=X` admit nothing; `>=X <=X` admits exactly X.
        Ordering::Equal => low.operator == ComparatorOperator::Above || high.operator == ComparatorOperator::Below,
        Ordering::Less => false,
    }
}

/// ECMAScript's `typeof` of a manifest value, as the refusals name it.
pub(crate) fn describe(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Array(_)) => "an array",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Object(_)) => "object",
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn parsed(raw: &str) -> VersionRange {
        parse_version_range(Some(&json!(raw)), RangeReading::Requires)
            .unwrap_or_else(|error| panic!("expected '{raw}' to parse: {}", error.message))
    }

    fn refusal(raw: Option<Value>) -> VersionRangeError {
        parse_version_range(raw.as_ref(), RangeReading::Requires).expect_err("a refused range")
    }

    fn refused(raw: &str) -> VersionRangeError {
        refusal(Some(json!(raw)))
    }

    #[test]
    fn accepts_a_single_lower_bound() {
        let range = parsed(">=0.80.0");
        assert_eq!(range.comparators.len(), 1);
        assert_eq!((range.comparators[0].operator, range.comparators[0].raw.as_str()), (ComparatorOperator::AtLeast, "0.80.0"));
    }

    #[test]
    fn accepts_a_conjunction_separated_by_spaces_or_commas() {
        for raw in [">=0.40.0 <0.50.0", ">=0.40.0,<0.50.0", ">=0.40.0, <0.50.0"] {
            let operators: Vec<_> = parsed(raw).comparators.iter().map(|c| c.operator).collect();
            assert_eq!(operators, [ComparatorOperator::AtLeast, ComparatorOperator::Below], "{raw}");
        }
    }

    #[test]
    fn refuses_caret_and_tilde_and_names_the_spelling_to_use_instead() {
        for raw in ["^0.40.0", "~0.40.0"] {
            let error = refused(raw);
            assert_eq!(error.hint.as_deref(), Some(">=0.40.0"));
            assert!(error.message.contains("0.41.0"), "{}", error.message);
        }
        assert_eq!(
            parse_version_range(Some(&json!("^1.2.0")), RangeReading::Need).expect_err("refused").hint.as_deref(),
            Some(">=1.2.0 <2.0.0")
        );
    }

    #[test]
    fn refuses_a_bare_version_which_semver_would_read_as_an_exact_pin() {
        assert_eq!(refused("0.80.0").hint.as_deref(), Some(">=0.80.0"));
        assert_eq!(refused("=0.80.0").hint.as_deref(), Some(">=0.80.0"));
    }

    #[test]
    fn refuses_disjunctions_hyphen_ranges_and_wildcards() {
        assert!(refused(">=0.1.0 || >=0.2.0").message.contains("disjunction"));
        let hyphen = refused("0.40.0 - 0.50.0");
        assert!(hyphen.message.contains("hyphen"));
        assert_eq!(hyphen.hint.as_deref(), Some("0.40.0 rewritten as '>=' and '<=' comparators"));
        for wild in ["*", "x", "0.x", "1.2.x", "1.2.*", "1.*.0", "X.1.0"] {
            assert!(refused(wild).message.contains("wildcard"), "{wild}");
        }
    }

    #[test]
    fn never_emits_a_hint_it_would_reject_on_the_next_run() {
        for bad in ["1.2.*", "0.76", "2024.1", "=0.76"] {
            if let Some(hint) = refused(bad).hint {
                assert!(parse_version_range(Some(&json!(hint)), RangeReading::Requires).is_ok(), "{bad} -> {hint}");
            }
        }
        assert_eq!(refused("0.80.0").hint.as_deref(), Some(">=0.80.0"));
    }

    #[test]
    fn refuses_non_strings_empty_strings_and_unparseable_versions() {
        assert_eq!(refusal(None).message, "expected a version range string, got undefined");
        assert_eq!(refusal(Some(json!(42))).message, "expected a version range string, got number");
        assert_eq!(refused("   ").message, "expected a version range string, got string");
        assert_eq!(
            refused(">=1.2").message,
            "'1.2' in '>=1.2' is not a three-part version (X.Y.Z, optionally -prerelease)"
        );
    }

    #[test]
    fn applies_every_comparator() {
        let range = parsed(">=0.40.0 <0.50.0");
        assert!(range_accepts(&range, "0.40.0"));
        assert!(range_accepts(&range, "0.49.9"));
        assert!(!range_accepts(&range, "0.39.9"));
        assert!(!range_accepts(&range, "0.50.0"));
    }

    #[test]
    fn compares_prereleases_by_plain_precedence() {
        let range = parsed(">=0.80.0");
        assert!(range_accepts(&range, "0.81.0-rc.1"));
        assert!(!range_accepts(&range, "0.80.0-rc.1"));
    }

    #[test]
    fn refuses_an_unparseable_version_rather_than_passing_it() {
        assert!(!range_accepts(&parsed(">=0.1.0"), "latest"));
    }

    #[test]
    fn reports_the_binding_bound_when_several_point_the_same_way() {
        let range = parsed(">=0.40.0 >=0.45.0 <0.60.0 <0.50.0");
        assert_eq!(lower_bound(&range).map(|c| c.raw.as_str()), Some("0.45.0"));
        assert_eq!(upper_bound(&range).map(|c| c.raw.as_str()), Some("0.50.0"));
        assert!(upper_bound(&parsed(">=0.80.0")).is_none());
    }

    #[test]
    fn reduces_a_range_to_its_binding_edges_with_their_inclusivity() {
        let bound = |version: &str, inclusive| Some(VersionIntervalBound { version: version.into(), inclusive });
        assert_eq!(
            range_interval(&parsed(">=0.40.0 >0.40.0 <=0.60.0 <0.50.0")),
            VersionInterval { min: bound("0.40.0", false), max: bound("0.50.0", false) }
        );
        assert_eq!(range_interval(&parsed(">=0.100.0")), VersionInterval { min: bound("0.100.0", true), max: None });
        assert!(range_within(&parsed(">=0.50.0 <0.60.0"), &parsed(">=0.40.0")));
        assert!(!range_within(&parsed(">=0.40.0"), &parsed(">=0.40.0 <0.60.0")));
        assert!(!range_within(&parsed(">=0.40.0"), &parsed(">0.40.0")));
    }

    #[test]
    fn detects_bounds_that_exclude_each_other() {
        assert!(is_unsatisfiable(&parsed(">=0.90.0 <0.80.0")));
        assert!(is_unsatisfiable(&parsed(">=0.80.0 <0.80.0")));
        assert!(is_unsatisfiable(&parsed(">0.80.0 <=0.80.0")));
        assert!(!is_unsatisfiable(&parsed(">=0.80.0 <=0.80.0")));
        assert!(!is_unsatisfiable(&parsed(">=0.80.0")));
    }

    #[test]
    fn reads_an_unreleased_build_by_its_build_metadata() {
        assert_eq!(split_build_metadata("0.121.0+unreleased"), ("0.121.0", true));
        assert_eq!(split_build_metadata("0.121.0+build.7"), ("0.121.0", false));
        assert_eq!(split_build_metadata("0.121.0"), ("0.121.0", false));
    }
}
