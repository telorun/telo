//! The `re2-pattern` Telo format: a regular expression RE2 and an ECMAScript `u`-mode
//! engine both accept and match identically, as one closed allowlist read by one
//! recursive-descent pass; any construct outside it is refused by name with its offset.
//! Mirrors `../../nodejs/src/re2-pattern-format.ts` reason for reason, an offset counting
//! UTF-16 code units, and runs the same conformance set, `sdk/formats/re2-pattern.json`.

use crate::telo_format::{fail, FormatFailure};

const MAX_REPEAT: f64 = 1000.0;

const GENERAL_CATEGORIES: [&str; 35] = [
    "L", "Lu", "Ll", "Lt", "Lm", "Lo", "M", "Mn", "Mc", "Me", "N", "Nd", "Nl", "No", "P", "Pc", "Pd", "Ps", "Pe", "Pi",
    "Pf", "Po", "S", "Sm", "Sc", "Sk", "So", "Z", "Zs", "Zl", "Zp", "Cc", "Cf", "Cs", "Co",
];

struct Refusal {
    reason: String,
    offset: usize,
}

fn refuse<T>(reason: impl Into<String>, offset: usize) -> Result<T, Refusal> {
    Err(Refusal { reason: reason.into(), offset })
}

struct Parser {
    units: Vec<u16>,
    at: usize,
}

impl Parser {
    fn peek(&self, offset: usize) -> Option<char> {
        self.units.get(self.at + offset).map(|u| char::from_u32(*u as u32).unwrap_or('\u{fffd}'))
    }

    fn text(&self, from: usize, to: usize) -> String {
        String::from_utf16_lossy(&self.units[from.min(self.units.len())..to.min(self.units.len())])
    }

    fn code_point(&self) -> (u32, usize) {
        let unit = self.units[self.at] as u32;
        if (0xD800..0xDC00).contains(&unit) {
            if let Some(low) = self.units.get(self.at + 1).map(|u| *u as u32).filter(|u| (0xDC00..0xE000).contains(u)) {
                return (0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00), 2);
            }
        }
        (unit, 1)
    }

    fn parse(&mut self) -> Result<(), Refusal> {
        self.alternation()?;
        if self.at < self.units.len() {
            return refuse("unmatched ')' — escape it as \\)", self.at);
        }
        Ok(())
    }

    fn alternation(&mut self) -> Result<(), Refusal> {
        self.concatenation()?;
        while self.peek(0) == Some('|') {
            self.at += 1;
            self.concatenation()?;
        }
        Ok(())
    }

    fn concatenation(&mut self) -> Result<(), Refusal> {
        loop {
            match self.peek(0) {
                None | Some('|') | Some(')') => return Ok(()),
                _ => {}
            }
            let start = self.at;
            let repeatable = self.atom()?;
            self.quantifier(start, repeatable)?;
        }
    }

    fn atom(&mut self) -> Result<bool, Refusal> {
        let start = self.at;
        let c = self.peek(0).expect("an atom starts at a character");
        match c {
            '^' | '$' => {
                self.at += 1;
                Ok(false)
            }
            '.' => refuse(
                "'.' matches a different set of characters in RE2 and ECMAScript — write the class it should match, e.g. [^\\n]",
                start,
            ),
            '(' => self.group().map(|_| true),
            '[' => self.character_class().map(|_| true),
            '\\' => self.escape(false),
            '*' | '+' | '?' => refuse(format!("'{c}' has nothing to repeat"), start),
            '{' => refuse("a '{' that does not repeat something — escape it as \\{", start),
            '}' => refuse("a lone '}' — escape it as \\}", start),
            ']' => refuse("a lone ']' — escape it as \\]", start),
            _ => {
                self.at += self.code_point().1;
                Ok(true)
            }
        }
    }

    fn group(&mut self) -> Result<(), Refusal> {
        let start = self.at;
        self.at += 1;
        if self.peek(0) == Some('?') {
            match self.peek(1) {
                Some(':') => self.at += 2,
                Some('=' | '!') => return refuse("lookahead is outside the format — RE2 has none", start),
                Some('<') if matches!(self.peek(2), Some('=' | '!')) => {
                    return refuse("lookbehind is outside the format — RE2 has none", start)
                }
                Some('<' | 'P') => return refuse("a named group is outside the format — write (…) or (?:…)", start),
                _ => return refuse("an inline flag group is outside the format — ECMAScript has none", start),
            }
        }
        self.alternation()?;
        if self.peek(0) != Some(')') {
            return refuse("unclosed group — expected ')'", start);
        }
        self.at += 1;
        Ok(())
    }

    /// `^\{(\d+)(,(\d*))?\}` at the cursor: its length, minimum and maximum.
    fn repetition(&self) -> Option<(usize, f64, Option<f64>)> {
        let mut i = self.at + 1;
        let digits = |from: usize| self.units[from.min(self.units.len())..].iter().take_while(|u| (b'0' as u16..=b'9' as u16).contains(u)).count();
        let min_length = digits(i);
        if min_length == 0 {
            return None;
        }
        let min: f64 = self.text(i, i + min_length).parse().ok()?;
        i += min_length;
        let mut max = None;
        if self.units.get(i) == Some(&(b',' as u16)) {
            i += 1;
            let max_length = digits(i);
            if max_length > 0 {
                max = Some(self.text(i, i + max_length).parse().ok()?);
            }
            i += max_length;
        }
        (self.units.get(i) == Some(&(b'}' as u16))).then_some((i + 1 - self.at, min, max))
    }

    fn quantifier(&mut self, atom_start: usize, repeatable: bool) -> Result<(), Refusal> {
        let mut quantified = false;
        match self.peek(0) {
            Some('*' | '+' | '?') => {
                self.at += 1;
                quantified = true;
            }
            Some('{') => {
                let start = self.at;
                let Some((length, min, max)) = self.repetition() else {
                    return refuse("a '{' that is not a repetition {n}, {n,} or {n,m} — escape it as \\{", start);
                };
                if min > MAX_REPEAT || max.is_some_and(|max| max > MAX_REPEAT) {
                    return refuse("a repetition count above 1000", start);
                }
                if max.is_some_and(|max| max < min) {
                    return refuse("a repetition whose maximum is below its minimum", start);
                }
                self.at += length;
                quantified = true;
            }
            _ => {}
        }
        if !quantified {
            return Ok(());
        }
        if !repeatable {
            return refuse("an assertion cannot be repeated", atom_start);
        }
        if self.peek(0) == Some('?') {
            self.at += 1;
        }
        if let Some(after @ ('*' | '+' | '?' | '{')) = self.peek(0) {
            return refuse(format!("'{after}' repeats a repetition"), self.at);
        }
        Ok(())
    }

    fn escape(&mut self, in_class: bool) -> Result<bool, Refusal> {
        let start = self.at;
        let Some(c) = self.peek(1) else { return refuse("a pattern ending in '\\'", start) };
        self.at += 2;
        if "tnrfv".contains(c) || "dDwW".contains(c) {
            return Ok(true);
        }
        if c == 'b' || c == 'B' {
            if in_class {
                return refuse(format!("\\{c} inside a class means different things in RE2 and ECMAScript"), start);
            }
            return Ok(false);
        }
        if c == 'x' {
            if self.peek(0) == Some('{') {
                return refuse("\\x{…} is RE2's spelling only — write \\xHH", start);
            }
            let hex = self.text(self.at, self.at + 2);
            if hex.len() != 2 || !hex.chars().all(|h| h.is_ascii_hexdigit()) {
                return refuse("\\x takes exactly two hexadecimal digits", start);
            }
            self.at += 2;
            return Ok(true);
        }
        if c == 'p' || c == 'P' {
            if self.peek(0) != Some('{') {
                return refuse(format!("\\{c} without braces — write \\{c}{{…}}"), start);
            }
            let Some(close) = self.units[self.at..].iter().position(|u| *u == b'}' as u16).map(|p| self.at + p) else {
                return refuse(format!("unclosed \\{c}{{"), start);
            };
            let name = self.text(self.at + 1, close);
            if !GENERAL_CATEGORIES.contains(&name.as_str()) {
                return refuse(
                    format!("\\{c}{{{name}}} is outside the format — only General_Category short names (L, Lu, Nd, …) are read alike"),
                    start,
                );
            }
            self.at = close + 1;
            return Ok(true);
        }
        if "^$\\.*+?()[]{}|/".contains(c) || (in_class && c == '-') {
            return Ok(true);
        }
        if c == 's' || c == 'S' {
            return refuse(format!("\\{c} matches a different set of characters in RE2 and ECMAScript — write the class it should match"), start);
        }
        if c == 'u' {
            return refuse("\\u is ECMAScript's spelling only — write \\xHH or the character itself", start);
        }
        if c == 'c' {
            return refuse("\\cX is ECMAScript's spelling only", start);
        }
        if c == 'k' || ('1'..='9').contains(&c) {
            return refuse("a backreference is outside the format — RE2 has none", start);
        }
        if c == '0' {
            return refuse("\\0 and octal escapes are outside the format — write \\xHH", start);
        }
        if "AzZQEC".contains(c) {
            return refuse(format!("\\{c} is RE2's spelling only"), start);
        }
        refuse(format!("\\{c} is not an escape both engines read alike"), start)
    }

    fn character_class(&mut self) -> Result<(), Refusal> {
        let start = self.at;
        self.at += 1;
        if self.peek(0) == Some('^') {
            self.at += 1;
        }
        if self.peek(0) == Some(']') {
            return refuse(
                "an empty class, or a ']' first in one, is read differently by RE2 and ECMAScript — escape it as \\]",
                self.at,
            );
        }
        loop {
            match self.peek(0) {
                None => return refuse("unclosed class — expected ']'", start),
                Some(']') => {
                    self.at += 1;
                    return Ok(());
                }
                _ => {}
            }
            let low_start = self.at;
            let low = self.class_atom()?;
            if self.peek(0) == Some('-') && self.peek(1) != Some(']') && self.peek(1).is_some() {
                self.at += 1;
                let high_start = self.at;
                let high = self.class_atom()?;
                let (Some(low), Some(high)) = (low, high) else {
                    return refuse("a range whose end is a class, not a character", if low.is_none() { low_start } else { high_start });
                };
                if high < low {
                    return refuse("a range whose end comes before its start", low_start);
                }
            }
        }
    }

    fn class_atom(&mut self) -> Result<Option<u32>, Refusal> {
        let start = self.at;
        let c = self.peek(0).expect("a class member starts at a character");
        if c == '[' {
            return refuse(
                if self.peek(1) == Some(':') { "a POSIX class is outside the format — ECMAScript has none" } else { "a '[' inside a class — escape it as \\[" },
                start,
            );
        }
        if c == '\\' {
            let kind = self.peek(1);
            self.escape(true)?;
            let Some(kind) = kind else { return Ok(None) };
            if "dDwWpP".contains(kind) {
                return Ok(None);
            }
            if kind == 'x' {
                return Ok(u32::from_str_radix(&self.text(self.at - 2, self.at), 16).ok());
            }
            return Ok(Some(match kind {
                't' => 9,
                'n' => 10,
                'r' => 13,
                'f' => 12,
                'v' => 11,
                other => other as u32,
            }));
        }
        let (point, length) = self.code_point();
        self.at += length;
        Ok(Some(point))
    }
}

pub fn check(value: &str) -> Option<FormatFailure> {
    let mut parser = Parser { units: value.encode_utf16().collect(), at: 0 };
    match parser.parse() {
        Ok(()) => None,
        Err(refusal) => fail(refusal.reason, refusal.offset),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn holds_the_entry_s_conformance_set() {
        crate::telo_format::assert_conformance("re2-pattern", include_str!("../../../sdk/formats/re2-pattern.json"));
    }
}
