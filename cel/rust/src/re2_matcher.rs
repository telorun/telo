//! No Node twin: re2js 2.8.3's `Matcher`, the stateful search `catalog-runtime.ts` asks for
//! a pattern's matches and replacements, over this crate's RE2 program. Recorded against
//! re2js 2.8.3 under Node v24.11.1 (V8 13.6.233.10-node.28).
//!
//! `find` answers each match in turn, leftmost-first, the next search beginning where the
//! last match ended; after an empty match it begins one character further on, so a match
//! never starts inside a character and an empty match is followed by the next. A search
//! asks for the whole match alone; a group's span is asked for, from the match's own start,
//! only when a group is read, and a group that took no part answers nothing.
//!
//! `replace_all` is re2js's `replaceAll` in its JavaScript mode: `$$` writes `$`, `$&` the
//! match, `` $` `` the text before it, `$'` the text after it, `$n` and `$nn` the group of
//! the longest number up to the group count, `$<name>` a named group; a number past the
//! count, `$0`, an unknown name, a `$<` with no `>` before a space or the end, and a `$`
//! ending the replacement are written as they stand. Positions are byte offsets on
//! character boundaries, as the program's own; re2js's are UTF-16 offsets of the same
//! places.

use crate::re2_program::{Re2Program, Re2Span};

/// A search through one text, as re2js's `Matcher` keeps it.
pub(crate) struct Re2Matcher<'p, 't> {
    program: &'p Re2Program,
    text: &'t str,
    /// The last match, if the last `find` found one.
    current: Option<Re2Span>,
    /// Every group's span of the last match, once a group was read.
    groups: Option<Vec<Option<Re2Span>>>,
    /// A search found nothing, and every later one would find the same.
    exhausted: bool,
}

impl<'p, 't> Re2Matcher<'p, 't> {
    pub(crate) fn new(program: &'p Re2Program, text: &'t str) -> Self {
        Self { program, text, current: None, groups: None, exhausted: false }
    }

    /// How many groups the pattern writes, the whole match not counted.
    pub(crate) fn group_count(&self) -> usize {
        self.program.group_count()
    }

    /// The next match: true, and it becomes the one the reads answer about, or false at the
    /// end of the matches.
    pub(crate) fn find(&mut self) -> bool {
        if self.exhausted {
            return false;
        }
        let start = match self.current {
            None => Some(0),
            Some(last) if last.start == last.end => {
                self.text[last.end..].chars().next().map(|next| last.end + next.len_utf8())
            }
            Some(last) => Some(last.end),
        };
        let found = start.and_then(|start| self.program.search(self.text, start, 1).groups).and_then(|groups| groups[0]);
        match found {
            Some(span) => {
                self.current = Some(span);
                self.groups = None;
                true
            }
            None => {
                self.exhausted = true;
                false
            }
        }
    }

    /// The span of the last match.
    pub(crate) fn span(&self) -> Re2Span {
        self.current.expect("a span is read after a match")
    }

    /// The text group `index` matched in the last match — the whole match at 0 — or nothing
    /// where it took no part. Panics with no match, or past the group count.
    pub(crate) fn group(&mut self, index: usize) -> Option<&'t str> {
        let span = self.group_span(index)?;
        Some(&self.text[span.start..span.end])
    }

    fn group_span(&mut self, index: usize) -> Option<Re2Span> {
        assert!(index <= self.group_count(), "group {index} is past the pattern's {} groups", self.group_count());
        let whole = self.span();
        if index == 0 {
            return Some(whole);
        }
        let program = self.program;
        let text = self.text;
        let groups = self.groups.get_or_insert_with(|| {
            let found = program
                .search(text, whole.start, program.group_count() + 1)
                .groups
                .expect("the match is found again from its own start");
            assert_eq!(found[0], Some(whole), "the match found again from its start is the same match");
            found
        });
        groups[index]
    }

    /// The text before the last match, and the text after it.
    fn before(&self) -> &'t str {
        &self.text[..self.span().start]
    }

    fn after(&self) -> &'t str {
        &self.text[self.span().end..]
    }

    /// re2js's `appendReplacementInternalJs`: the replacement with its `$` forms expanded
    /// for the last match, written onto `out`.
    fn expand(&mut self, replacement: &str, out: &mut String) {
        let bytes = replacement.as_bytes();
        let count = self.group_count();
        let mut last = 0;
        let mut i = 0;
        // A `$` in the replacement's last position is never read as a form.
        while i + 1 < bytes.len() {
            if bytes[i] != b'$' {
                i += 1;
                continue;
            }
            let next = bytes[i + 1];
            match next {
                b'$' | b'&' | b'`' | b'\'' => {
                    out.push_str(&replacement[last..i]);
                    match next {
                        b'$' => out.push('$'),
                        b'&' => out.push_str(self.group(0).expect("the whole match took part")),
                        b'`' => out.push_str(self.before()),
                        _ => out.push_str(self.after()),
                    }
                    i += 2;
                    last = i;
                }
                b'1'..=b'9' => {
                    out.push_str(&replacement[last..i]);
                    let mut n = (next - b'0') as usize;
                    let mut at = i + 2;
                    while let Some(&digit) = bytes.get(at) {
                        if !digit.is_ascii_digit() {
                            break;
                        }
                        let longer = n * 10 + (digit - b'0') as usize;
                        if longer > count {
                            break;
                        }
                        n = longer;
                        at += 1;
                    }
                    if n > count {
                        out.push('$');
                        out.push_str(&n.to_string());
                    } else if let Some(text) = self.group(n) {
                        out.push_str(text);
                    }
                    i = at;
                    last = at;
                }
                b'<' => {
                    out.push_str(&replacement[last..i]);
                    let name_start = i + 2;
                    let close = bytes[name_start..].iter().position(|b| *b == b'>' || *b == b' ').map(|n| name_start + n);
                    match close {
                        Some(close) if bytes[close] == b'>' => {
                            let name = &replacement[name_start..close];
                            match self.program.named_group(name) {
                                Some(index) => {
                                    if let Some(text) = self.group(index) {
                                        out.push_str(text);
                                    }
                                }
                                None => out.push_str(&replacement[i..=close]),
                            }
                            i = close + 1;
                        }
                        // No `>` before a space or the end: written as it stands, the space
                        // included.
                        Some(space) => {
                            out.push_str(&replacement[i..=space]);
                            i = space + 1;
                        }
                        None => {
                            out.push_str(&replacement[i..]);
                            i = bytes.len();
                        }
                    }
                    last = i;
                }
                _ => i += 1,
            }
        }
        out.push_str(&replacement[last..]);
    }
}

/// re2js's `matcher(text).replaceAll(replacement)` in its JavaScript mode: every match
/// replaced, the text between matches kept.
pub(crate) fn replace_all(program: &Re2Program, text: &str, replacement: &str) -> String {
    let mut matcher = Re2Matcher::new(program, text);
    let mut out = String::with_capacity(text.len());
    let mut kept = 0;
    while matcher.find() {
        let span = matcher.span();
        out.push_str(&text[kept..span.start]);
        kept = span.end;
        matcher.expand(replacement, &mut out);
    }
    out.push_str(&text[kept..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::regular_expression::{re2_pattern, Re2Flags};

    fn compiled(pattern: &str, flags: u32) -> std::sync::Arc<Re2Program> {
        let mut bits = Re2Flags::NONE;
        for flag in [Re2Flags::CASE_INSENSITIVE, Re2Flags::DOTALL, Re2Flags::MULTILINE] {
            if flags & flag.bits() != 0 {
                bits = bits | flag;
            }
        }
        re2_pattern(pattern, bits).expect("a recorded pattern compiles")
    }

    #[test]
    fn every_replacement_form_expands_as_re2js() {
        for &(pattern, flags, text, replacement, expected) in REPLACE_ROWS {
            let program = compiled(pattern, flags);
            assert_eq!(replace_all(&program, text, replacement), expected, "{pattern:?} over {text:?} by {replacement:?}");
        }
    }

    #[test]
    fn every_match_and_group_is_found_as_re2js() {
        for &(pattern, text, expected) in FIND_ROWS {
            let program = compiled(pattern, 0);
            let mut matcher = Re2Matcher::new(&program, text);
            let mut found = Vec::new();
            while matcher.find() {
                found.push((0..=matcher.group_count()).map(|n| matcher.group(n)).collect::<Vec<_>>());
            }
            assert!(!matcher.find(), "the matches stay ended");
            assert_eq!(found, expected, "{pattern:?} over {text:?}");
        }
    }

    // Recorded by executing re2js 2.8.3's RE2JS.compile(pattern, flags).matcher(text).replaceAll(replacement) and its find() / group(n) loop under Node v24.11.1 (V8 13.6.233.10-node.28, ICU 77.1),
    // against @telorun/cel 0.129.0 at 2ee5ef49.
    /// `(pattern, flags, text, replacement, answer)`.
    const REPLACE_ROWS: &[(&str, u32, &str, &str, &str)] = &[
        ("(\\w+)@(\\w+)", 0, "ann@x, bob@y", "$2:$1", "x:ann, y:bob"),
        ("(\\w+)@(\\w+)", 0, "ann@x", "$$1", "$1"),
        ("(\\w+)@(\\w+)", 0, "ann@x", "$$$1", "$ann"),
        ("(\\w+)@(\\w+)", 0, "ann@x", "[$&]", "[ann@x]"),
        ("b", 0, "abc", "[$`]", "a[a]c"),
        ("b", 0, "abc", "[$']", "a[c]c"),
        ("b", 0, "abcabc", "<$`|$&|$'>", "a<a|b|cabc>ca<abca|b|c>c"),
        ("(a)", 0, "a", "$0", "$0"),
        ("(a)", 0, "a", "$00", "$00"),
        ("(a)", 0, "a", "$1", "a"),
        ("(a)", 0, "a", "$2", "$2"),
        ("(a)", 0, "a", "$9", "$9"),
        ("(a)", 0, "a", "$10", "a0"),
        ("(a)", 0, "a", "$11", "a1"),
        ("(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)(l)", 0, "abcdefghijkl", "$12-$10-$1-$13-$123", "l-j-a-a3-l3"),
        ("(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)(l)", 0, "abcdefghijkl", "$01", "$01"),
        ("(a)", 0, "a", "x$", "x$"),
        ("(a)", 0, "a", "$", "$"),
        ("(a)", 0, "a", "$$", "$"),
        ("(a)", 0, "a", "$x", "$x"),
        ("(a)", 0, "a", "$-", "$-"),
        ("(a)", 0, "a", "${1}", "${1}"),
        ("(a)", 0, "a", "\\1", "\\1"),
        ("(?P<x>a)(?P<y>b)?", 0, "a ab", "[$<x>|$<y>]", "[a|] [a|b]"),
        ("(?<word>\\w+)", 0, "hi there", "<$<word>>", "<hi> <there>"),
        ("(?P<x>a)", 0, "a", "$<nope>", "$<nope>"),
        ("(?P<x>a)", 0, "a", "$<x", "$<x"),
        ("(?P<x>a)", 0, "a", "$<x y>z", "$<x y>z"),
        ("(?P<x>a)", 0, "a", "$< >", "$< >"),
        ("(?P<x>a)", 0, "a", "$<>", "$<>"),
        ("(?P<x>a)", 0, "a", "$<x>$<x>", "aa"),
        ("(?P<x>a)", 0, "a", "$<\u{1f600}>", "$<\u{1f600}>"),
        ("(a)", 0, "a", "$<1>", "$<1>"),
        ("(a)|(b)", 0, "ab", "[$1|$2]", "[a|][|b]"),
        ("(a)?b", 0, "b ab", "[$1]", "[] [a]"),
        ("(a*)*", 0, "b", "[$1]", "[]b[]"),
        ("(a|)+", 0, "aa", "[$1]", "[a][]"),
        ("", 0, "", "-", "-"),
        ("", 0, "abc", "-", "-a-b-c-"),
        ("", 0, "\u{1f600}\u{e9}", "-", "-\u{1f600}-\u{e9}-"),
        ("x*", 0, "\u{1f600}\u{1f600}", "-", "-\u{1f600}-\u{1f600}-"),
        ("a*", 0, "baaac", "-", "-b--c-"),
        ("a*", 0, "\u{1f600}a\u{1f600}", "<$&>", "<>\u{1f600}<a><>\u{1f600}<>"),
        ("\\b", 0, "ab cd", "|", "|ab| |cd|"),
        ("^", 4, "a\nb\n", ">", ">a\n>b\n>"),
        ("$", 4, "a\nb", "<", "a<\nb<"),
        ("\u{1f600}", 0, "a\u{1f600}b\u{1f600}", "$`", "aaba\u{1f600}b"),
        ("(\u{1f600})|(\u{e9})", 0, "\u{e9}\u{1f600}", "[$1,$2]", "[,\u{e9}][\u{1f600},]"),
        ("[\u{1f600}\u{e9}]*", 0, "\u{1f600}\u{e9}\u{1f600}x", "($&)", "(\u{1f600}\u{e9}\u{1f600})()x()"),
        ("(?i)A", 0, "aAa", "-", "---"),
        ("a", 1, "aAa", "-", "---"),
        ("(?s).", 0, "a\nb", ".", "..."),
        (".", 2, "a\nb", ".", "..."),
        ("(a|ab)(c|bcd)(d*)", 0, "abcd", "$1,$2,$3", "a,bcd,"),
        ("\\s+", 0, "a  b\tc", "_", "a_b_c"),
        ("\\d+", 0, "a1b22c333", "<$&>", "a<1>b<22>c<333>"),
        ("(\\d)(\\d)?", 0, "1 23", "$2$1", "1 32"),
        ("foo|bar", 0, "foobarbaz", "$&$&", "foofoobarbarbaz"),
        ("(?U)a+", 0, "aaa", "-", "---"),
        ("a+", 0, "aaa", "\u{1f600}$&\u{1f600}", "\u{1f600}aaa\u{1f600}"),
        ("(\u{e9})", 0, "caf\u{e9}", "$1$1", "caf\u{e9}\u{e9}"),
        ("\\pL+", 0, "h\u{e9}llo w\u{f6}rld", "[$&]", "[h\u{e9}llo] [w\u{f6}rld]"),
        ("(?P<n>.)\\b", 0, "ab cd", "$<n>!", "ab! !cd!"),
    ];

    /// `(pattern, text, every match's groups)`: `find()` until it answers false, and `group(n)` for
    /// each group from the whole match up, `None` where re2js answers null.
    const FIND_ROWS: &[(&str, &str, &[&[Option<&str>]])] = &[
        ("(a)|(b)", "ab", &[&[Some("a"), Some("a"), None], &[Some("b"), None, Some("b")]]),
        ("(?P<x>a)(?P<y>b)?", "a ab", &[&[Some("a"), Some("a"), None], &[Some("ab"), Some("a"), Some("b")]]),
        ("x*", "\u{1f600}a\u{1f600}", &[&[Some("")], &[Some("")], &[Some("")], &[Some("")]]),
        ("", "\u{e9}\u{1f600}", &[&[Some("")], &[Some("")], &[Some("")]]),
        ("a*", "baaac", &[&[Some("")], &[Some("aaa")], &[Some("")], &[Some("")]]),
        ("(a*)*", "aab", &[&[Some("aa"), Some("aa")], &[Some(""), Some("")], &[Some(""), Some("")]]),
        ("\\b", "ab cd", &[&[Some("")], &[Some("")], &[Some("")], &[Some("")]]),
        ("(\\d+)-(\\d+)?", "1-2 3- 4", &[&[Some("1-2"), Some("1"), Some("2")], &[Some("3-"), Some("3"), None]]),
        ("(?m)^(\\w)", "ab\ncd\n", &[&[Some("a"), Some("a")], &[Some("c"), Some("c")]]),
        ("[^a]", "a\u{1f600}ba", &[&[Some("\u{1f600}")], &[Some("b")]]),
        ("(\u{e9}|\u{1f600})+", "x\u{e9}\u{1f600}\u{e9}y", &[&[Some("\u{e9}\u{1f600}\u{e9}"), Some("\u{e9}")]]),
        ("(((a)))", "aa", &[&[Some("a"), Some("a"), Some("a"), Some("a")], &[Some("a"), Some("a"), Some("a"), Some("a")]]),
    ];
}
