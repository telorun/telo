//! The `vcs-url` Telo format: a git repository's location in the SPDX / purl VCS
//! notation, `git+https://<host>[:<port>]/<path>`, with no revision. Mirrors
//! `../../nodejs/src/vcs-url-format.ts` and runs the same conformance set,
//! `sdk/formats/vcs-url.json`.

use crate::telo_format::{fail, FormatFailure};

const PREFIX: &str = "git+https://";

fn is_host_label(label: &str) -> bool {
    let bytes = label.as_bytes();
    !bytes.is_empty()
        && bytes[0].is_ascii_alphanumeric()
        && bytes[bytes.len() - 1].is_ascii_alphanumeric()
        && bytes.iter().all(|b| b.is_ascii_alphanumeric() || *b == b'-')
}

fn segment_failure(segment: &[char], base: usize) -> Option<FormatFailure> {
    let text: String = segment.iter().collect();
    if text.is_empty() || text == "." || text == ".." {
        return fail("a path segment must be a name, not empty, '.' or '..'", base);
    }
    for (i, ch) in segment.iter().enumerate() {
        if *ch == '%' {
            let hex = segment.get(i + 1..i + 3).is_some_and(|h| h.iter().all(char::is_ascii_hexdigit));
            if !hex {
                return fail("a '%' must be followed by two hexadecimal digits", base + i);
            }
        } else if ch.is_whitespace() || ch.is_control() {
            return fail("whitespace and control characters must be percent-encoded", base + i);
        }
    }
    None
}

pub(crate) fn check(value: &str) -> Option<FormatFailure> {
    let chars: Vec<char> = value.chars().collect();
    if !value.starts_with(PREFIX) {
        if value.get(..8).is_some_and(|head| head.eq_ignore_ascii_case("https://")) {
            return fail(format!("it names no version control tool: write git+{value}"), 0);
        }
        return fail("a VCS location starts with git+https://, as in git+https://github.com/acme/engine", 0);
    }
    for (mark, reason) in [
        ('@', "a VCS location carries no user name, password or revision ('@'); the revision is written in vcs.revision"),
        ('?', "a VCS location carries no query ('?')"),
        ('#', "a VCS location carries no fragment ('#'); the revision is written in vcs.revision"),
    ] {
        if let Some(at) = chars.iter().position(|c| *c == mark) {
            return fail(reason, at);
        }
    }
    let base = PREFIX.len();
    let rest = &chars[base..];
    let slash = rest.iter().position(|c| *c == '/');
    let authority: String = rest[..slash.unwrap_or(rest.len())].iter().collect();
    if authority.is_empty() {
        return fail("it names no host: write git+https://<host>/<path>", base);
    }
    let (host, port) = match authority.find(':') {
        Some(colon) => (&authority[..colon], Some((colon, &authority[colon + 1..]))),
        None => (authority.as_str(), None),
    };
    if host.is_empty() || !host.split('.').all(is_host_label) {
        return fail(
            format!(
                "the host '{host}' must be letters, digits, '-' and '.', each dot-separated label starting and ending with a letter or digit"
            ),
            base,
        );
    }
    if let Some((colon, port)) = port {
        let valid = !port.is_empty()
            && port.len() <= 5
            && port.bytes().all(|b| b.is_ascii_digit())
            && port.parse::<u32>().is_ok_and(|n| (1..=65535).contains(&n));
        if !valid {
            return fail(format!("the port '{port}' must be a number from 1 to 65535"), base + colon + 1);
        }
    }
    let Some(slash) = slash.filter(|slash| *slash != rest.len() - 1) else {
        return fail("it names no repository path: write git+https://<host>/<path>", chars.len());
    };
    let mut offset = base + slash + 1;
    for segment in rest[slash + 1..].split(|c| *c == '/') {
        if let Some(failure) = segment_failure(segment, offset) {
            return Some(failure);
        }
        offset += segment.len() + 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telo_format::assert_conformance;

    #[test]
    fn agrees_with_the_shared_conformance_set() {
        assert_conformance("vcs-url", include_str!("../../../sdk/formats/vcs-url.json"));
    }

    #[test]
    fn names_the_missing_tool() {
        let failure = check("https://github.com/acme/engine").unwrap();
        assert_eq!(failure.reason, "it names no version control tool: write git+https://github.com/acme/engine");
    }
}
