//! The Telo glob engine: `select_by_patterns` and `last_match_index` over the
//! grammar `packages/glob/conformance/README.md` specifies.
//!
//! The Node twin compiles each pattern to a JavaScript regular expression; this
//! one matches the same tokens directly. Both read a path as UTF-16 code units
//! (a JavaScript regex without the `u` flag does, so `?` takes one code unit),
//! and `**` stops at a line terminator, as the regex `.` does.

/// Hard deny tier: always subtracted, even when `apply_default_ignore` is `false`.
pub const HARD_IGNORE: &[&str] = &["node_modules/", ".git/", ".telo/"];

/// Soft deny tier: subtracted after the allowlist unless `apply_default_ignore`
/// is `false`.
pub const DEFAULT_IGNORE: &[&str] = &[".telobundle.*"];

/// Directories a walking caller may prune mid-descent; the hard tier denies
/// them regardless, so pruning changes no result.
pub const GLOB_PRUNE_DIRS: &[&str] = &["node_modules", ".git", ".telo"];

/// Whether a walk may skip a directory of this name ([`GLOB_PRUNE_DIRS`]).
pub fn is_pruned(name: &str) -> bool {
    GLOB_PRUNE_DIRS.contains(&name)
}

#[derive(Debug, Clone, Default)]
pub struct SelectOptions {
    /// Subtract the soft [`DEFAULT_IGNORE`] tier after the allowlist (default
    /// `true`). The hard [`HARD_IGNORE`] tier is always applied.
    pub apply_default_ignore: Option<bool>,
    /// Further patterns carved out after the allowlist.
    pub exclude: Vec<String>,
}

const SLASH: u16 = b'/' as u16;

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Literal(u16),
    /// `[^/]*`
    Star,
    /// `[^/]`
    One,
    /// `.*`
    Any,
    /// `(?:.*/)?`
    AnyDirs,
}

struct Compiled {
    negated: bool,
    tokens: Vec<Token>,
}

/// What the regex `.` refuses to match.
fn is_line_terminator(unit: u16) -> bool {
    matches!(unit, 0x0a | 0x0d | 0x2028 | 0x2029)
}

fn normalize(pattern: &str) -> String {
    let posix = pattern.replace('\\', "/");
    posix.strip_prefix("./").map(str::to_string).unwrap_or(posix)
}

/// One glob body as tokens, per the Telo glob grammar.
fn body_tokens(glob: &str, anchored: bool) -> Vec<Token> {
    let units: Vec<u16> = glob.encode_utf16().collect();
    let mut tokens = if anchored { Vec::new() } else { vec![Token::AnyDirs] };
    let mut i = 0;
    while i < units.len() {
        let unit = units[i];
        if unit == b'*' as u16 {
            if units.get(i + 1) == Some(&(b'*' as u16)) {
                i += 2;
                if units.get(i) == Some(&SLASH) {
                    tokens.push(Token::AnyDirs);
                    i += 1;
                } else {
                    tokens.push(Token::Any);
                }
            } else {
                tokens.push(Token::Star);
                i += 1;
            }
        } else if unit == b'?' as u16 {
            tokens.push(Token::One);
            i += 1;
        } else {
            tokens.push(Token::Literal(unit));
            i += 1;
        }
    }
    tokens
}

fn compile(pattern: &str) -> Compiled {
    let mut body = pattern;
    let mut negated = false;
    if let Some(rest) = body.strip_prefix('!') {
        negated = true;
        body = rest;
    }
    let body = body.strip_prefix("./").unwrap_or(body);
    let (mut anchored, body) = match body.strip_prefix('/') {
        Some(rest) => (true, rest),
        None => (false, body),
    };
    // Anchoring is decided from the original body: a sole trailing slash does
    // not anchor (so `node_modules/` stays floating), any other slash does.
    let without_trailing = body.strip_suffix('/').unwrap_or(body);
    anchored = anchored || without_trailing.contains('/');
    // A trailing-slash directory pattern selects the directory's contents.
    let body = if body.ends_with('/') { format!("{body}**") } else { body.to_string() };
    Compiled { negated, tokens: body_tokens(&body, anchored) }
}

fn matches(tokens: &[Token], text: &[u16]) -> bool {
    match tokens.split_first() {
        None => text.is_empty(),
        Some((Token::Literal(unit), rest)) => text.first() == Some(unit) && matches(rest, &text[1..]),
        Some((Token::One, rest)) => text.first().is_some_and(|unit| *unit != SLASH) && matches(rest, &text[1..]),
        Some((Token::Star, rest)) => {
            for take in 0..=text.len() {
                if matches(rest, &text[take..]) {
                    return true;
                }
                if text.get(take) == Some(&SLASH) {
                    break;
                }
            }
            false
        }
        Some((Token::Any, rest)) => {
            for take in 0..=text.len() {
                if matches(rest, &text[take..]) {
                    return true;
                }
                if text.get(take).is_some_and(|unit| is_line_terminator(*unit)) {
                    break;
                }
            }
            false
        }
        Some((Token::AnyDirs, rest)) => {
            if matches(rest, text) {
                return true;
            }
            for (slash, unit) in text.iter().enumerate() {
                if is_line_terminator(*unit) {
                    break;
                }
                if *unit == SLASH && matches(rest, &text[slash + 1..]) {
                    return true;
                }
            }
            false
        }
    }
}

fn test(compiled: &Compiled, rel: &str) -> bool {
    let units: Vec<u16> = rel.encode_utf16().collect();
    matches(&compiled.tokens, &units)
}

/// Last match wins: the final pattern matching `rel` decides it.
fn decide(rel: &str, compiled: &[Compiled]) -> bool {
    let mut selected = false;
    for pattern in compiled {
        if test(pattern, rel) {
            selected = !pattern.negated;
        }
    }
    selected
}

/// The index of the last pattern matching `rel`, or `None` when none does.
/// The ignore tiers are not applied: this answers which entry of one authored
/// list decides a path, a negated one included.
pub fn last_match_index<S: AsRef<str>>(rel: &str, patterns: &[S]) -> Option<usize> {
    let mut index = None;
    for (i, pattern) in patterns.iter().enumerate() {
        if test(&compile(&normalize(pattern.as_ref())), rel) {
            index = Some(i);
        }
    }
    index
}

/// The paths of `rel_paths` that `patterns` select (positive patterns opt in,
/// `!` patterns carve out, last match wins), less [`HARD_IGNORE`] always,
/// [`DEFAULT_IGNORE`] unless opted out, and `options.exclude`; sorted by
/// UTF-16 code unit.
pub fn select_by_patterns<S: AsRef<str>>(rel_paths: &[String], patterns: &[S], options: &SelectOptions) -> Vec<String> {
    if patterns.is_empty() {
        return Vec::new();
    }
    let select: Vec<Compiled> = patterns.iter().map(|p| compile(&normalize(p.as_ref()))).collect();
    let hard: Vec<Compiled> = HARD_IGNORE.iter().map(|p| compile(p)).collect();
    let soft: Vec<Compiled> = if options.apply_default_ignore == Some(false) {
        Vec::new()
    } else {
        DEFAULT_IGNORE.iter().map(|p| compile(p)).collect()
    };
    let exclude: Vec<Compiled> = options.exclude.iter().map(|p| compile(&normalize(p))).collect();
    let mut matched: Vec<String> = rel_paths
        .iter()
        .filter(|rel| {
            !rel.is_empty()
                && decide(rel, &select)
                && !decide(rel, &hard)
                && (soft.is_empty() || !decide(rel, &soft))
                && (exclude.is_empty() || !decide(rel, &exclude))
        })
        .cloned()
        .collect();
    matched.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    matched
}
