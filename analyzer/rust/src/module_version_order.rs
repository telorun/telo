//! SemVer precedence for module versions, mirroring the parse and compare halves of
//! `../../nodejs/src/module-version-order.ts` — what version reconciliation orders by. An
//! unparseable version (a digest, a moving tag) is never ordered — and of the `requires:` /
//! `restrictions:` readers, which order a module's own versions by it. The upgrade helpers
//! serve `telo upgrade` and the editor, which no Rust host implements.

use std::cmp::Ordering;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedModuleVersion {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    /// Dot-separated prerelease identifiers, `None` for a release version.
    pub pre: Option<Vec<String>>,
}

fn is_numeric(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

/// `X.Y.Z`, `vX.Y.Z` or `X.Y.Z-pre.1`; `None` for anything that is not a three-part numeric core.
pub fn parse_module_version(raw: &str) -> Option<ParsedModuleVersion> {
    let version = raw.strip_prefix('v').unwrap_or(raw);
    let mut parts = version.split('-');
    let core = parts.next().unwrap_or("");
    let pre: Vec<&str> = parts.collect();
    let segments: Vec<&str> = core.split('.').collect();
    if segments.len() != 3 || !segments.iter().all(|s| is_numeric(s)) {
        return None;
    }
    // Node reads each segment as a double; a core no u64 holds is beyond any real version.
    let number = |s: &str| s.parse::<u64>().ok();
    Some(ParsedModuleVersion {
        major: number(segments[0])?,
        minor: number(segments[1])?,
        patch: number(segments[2])?,
        pre: (!pre.is_empty()).then(|| pre.join("-").split('.').map(str::to_string).collect()),
    })
}

/// SemVer precedence: the numeric core, then a release over a prerelease, then the
/// prerelease identifiers field by field (numeric below non-numeric, a shorter set lower).
pub fn compare_parsed_module_versions(a: &ParsedModuleVersion, b: &ParsedModuleVersion) -> Ordering {
    let core = a.major.cmp(&b.major).then(a.minor.cmp(&b.minor)).then(a.patch.cmp(&b.patch));
    if core != Ordering::Equal {
        return core;
    }
    let (a_pre, b_pre) = match (&a.pre, &b.pre) {
        (None, None) => return Ordering::Equal,
        (None, Some(_)) => return Ordering::Greater,
        (Some(_), None) => return Ordering::Less,
        (Some(a), Some(b)) => (a, b),
    };
    for index in 0..a_pre.len().max(b_pre.len()) {
        let (Some(ai), Some(bi)) = (a_pre.get(index), b_pre.get(index)) else {
            return if a_pre.len() < b_pre.len() { Ordering::Less } else { Ordering::Greater };
        };
        let order = match (is_numeric(ai), is_numeric(bi)) {
            (true, true) => {
                let (an, bn) = (ai.parse::<f64>().unwrap_or(f64::INFINITY), bi.parse::<f64>().unwrap_or(f64::INFINITY));
                an.partial_cmp(&bn).unwrap_or(Ordering::Equal)
            }
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            (false, false) => ai.encode_utf16().cmp(bi.encode_utf16()),
        };
        if order != Ordering::Equal {
            return order;
        }
    }
    Ordering::Equal
}

/// The order of two versions when both parse, `None` when either does not: the text-in
/// convenience over [`compare_parsed_module_versions`].
pub fn compare_module_versions(a: &str, b: &str) -> Option<Ordering> {
    Some(compare_parsed_module_versions(&parse_module_version(a)?, &parse_module_version(b)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn order(a: &str, b: &str) -> Ordering {
        compare_parsed_module_versions(&parse_module_version(a).unwrap(), &parse_module_version(b).unwrap())
    }

    #[test]
    fn orders_as_semver_and_refuses_what_it_cannot_read() {
        assert_eq!(order("1.2.0", "1.10.0"), Ordering::Less);
        assert_eq!(order("v1.0.0", "1.0.0"), Ordering::Equal);
        assert_eq!(order("1.0.0", "1.0.0-rc.1"), Ordering::Greater);
        assert_eq!(order("1.0.0-rc.2", "1.0.0-rc.10"), Ordering::Less);
        assert_eq!(order("1.0.0-rc", "1.0.0-rc.1"), Ordering::Less);
        assert_eq!(order("1.0.0-1", "1.0.0-alpha"), Ordering::Less);
        assert!(parse_module_version("latest").is_none());
        assert!(parse_module_version("1.0").is_none());
        assert!(parse_module_version("sha256:abc").is_none());
        assert_eq!(compare_module_versions("1.0.0", "0.9.0"), Some(Ordering::Greater));
        assert_eq!(compare_module_versions("1.0.0", "latest"), None);
    }
}
