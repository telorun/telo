//! The `css-selector` Telo format: Selectors Level 4's `<complex-selector-list>` in the
//! snapshot profile. Mirrors `../../nodejs/src/css-selector-format.ts` and runs the same
//! conformance set, `sdk/formats/css-selector.json`.
//!
//! The Node checker hands the text to `css-selector-parser` 3.3.0 (syntax `selectors-4`,
//! no pseudo-elements, no namespaces, strict), so this file holds a twin of that parser
//! as the checker configures it — its grammar, its error sentences and the position each
//! reports, every offset counting UTF-16 code units — then the checker's own two steps:
//! a selector list after `of` in `:nth-child()` handed over as `:is(<list>)`, and what the
//! parser accepts beyond the spec refused (a relative selector outside `:has()`,
//! `:has()` nested in `:has()`).

use telorun_cel::es_to_lower_case;

use crate::schema_opaque_value::inherited_member;
use crate::telo_format::{fail, FormatFailure};

// The parser.

#[derive(Clone, Copy)]
enum Signature {
    NoArgument,
    /// A pseudo-class taking an argument of a kind, required unless `optional`.
    String { optional: bool },
    Selector { optional: bool },
    Formula { of_selector: bool },
    /// A name `Object.prototype` holds, which the definitions table answers with a function.
    Inherited,
}

fn pseudo_class(name: &str) -> Option<Signature> {
    const NO_ARGUMENT: [&str; 47] = [
        "link", "visited", "active", "hover", "focus", "first-child", "root", "last-child", "first-of-type", "last-of-type",
        "only-child", "only-of-type", "empty", "target", "enabled", "disabled", "checked", "indeterminate", "any-link",
        "local-link", "target-within", "scope", "past", "future", "focus-within", "focus-visible", "read-write", "read-only",
        "placeholder-shown", "default", "valid", "invalid", "in-range", "out-of-range", "required", "optional", "blank",
        "user-invalid", "playing", "paused", "autofill", "modal", "fullscreen", "picture-in-picture", "defined", "loading",
        "popover-open",
    ];
    Some(match name {
        "current" => Signature::Selector { optional: true },
        "lang" | "dir" => Signature::String { optional: false },
        "nth-child" | "nth-last-child" => Signature::Formula { of_selector: true },
        "nth-of-type" | "nth-last-of-type" | "nth-col" | "nth-last-col" => Signature::Formula { of_selector: false },
        "not" | "is" | "where" | "has" | "state" => Signature::Selector { optional: false },
        _ if NO_ARGUMENT.contains(&name) => Signature::NoArgument,
        _ if inherited_member(name).is_some() => Signature::Inherited,
        _ => return None,
    })
}

/// Where `css-selector-parser` says a pseudo-class it does not read here is defined.
fn pseudo_class_locations(name: &str) -> &'static [&'static str] {
    match name {
        "static" | "relative" | "absolute" => &["css-position-1", "css-position-2", "css-position-3", "css-position-4"],
        "fixed" => &["css-position-2", "css-position-3", "css-position-4"],
        "sticky" => &["css-position-3", "css-position-4"],
        "initial" => &["css-position-4"],
        "host" | "host-context" => &["css-scoping-1"],
        _ => &[],
    }
}

struct Selector {
    rules: Vec<Rule>,
}

struct Rule {
    combinator: Option<String>,
    items: Vec<Item>,
    nested: Option<Box<Rule>>,
}

enum Argument {
    Text,
    Selector(Selector),
    Formula,
    FormulaOfSelector(Rule),
}

enum Item {
    Other,
    PseudoClass { name: String, argument: Option<Argument> },
}

struct ParseError {
    message: String,
    position: i64,
}

const COMBINATORS: [&str; 4] = [">", "+", "~", "||"];
const ATTRIBUTE_OPERATORS: [&str; 6] = ["=", "~=", "|=", "^=", "$=", "*="];

fn unit(c: char) -> u16 {
    c as u16
}

struct Parser {
    text: Vec<u16>,
    pos: usize,
}

impl Parser {
    fn chr(&self) -> Option<u16> {
        self.text.get(self.pos).copied()
    }

    fn is(&self, c: char) -> bool {
        self.chr() == Some(unit(c))
    }

    fn next(&mut self) {
        self.pos += 1;
    }

    fn read_and_next(&mut self) -> u16 {
        let current = self.chr().unwrap_or(0);
        self.pos += 1;
        current
    }

    fn eof(&self) -> bool {
        self.pos >= self.text.len()
    }

    fn fail<T>(&self, message: impl Into<String>) -> Result<T, ParseError> {
        let position = (self.text.len() as i64 - 1).min(self.pos as i64);
        Err(ParseError { message: message.into(), position })
    }

    fn check(&self, condition: bool, message: &str) -> Result<(), ParseError> {
        if condition {
            Ok(())
        } else {
            self.fail(message)
        }
    }

    fn is_ident_start(c: Option<u16>) -> bool {
        c.is_some_and(|c| (b'a' as u16..=b'z' as u16).contains(&c) || (b'A' as u16..=b'Z' as u16).contains(&c) || c == unit('-') || c == unit('_') || c == unit('\\') || c >= 0xA0)
    }

    fn is_ident(c: Option<u16>) -> bool {
        c.is_some_and(|c| {
            (b'a' as u16..=b'z' as u16).contains(&c)
                || (b'A' as u16..=b'Z' as u16).contains(&c)
                || (b'0' as u16..=b'9' as u16).contains(&c)
                || c == unit('-')
                || c == unit('_')
                || c >= 0xA0
        })
    }

    fn is_hex(c: Option<u16>) -> bool {
        c.is_some_and(|c| c < 0x80 && (c as u8).is_ascii_hexdigit())
    }

    fn is_digit(c: Option<u16>) -> bool {
        c.is_some_and(|c| c < 0x80 && (c as u8).is_ascii_digit())
    }

    fn is_tag_start(&self) -> bool {
        self.is('*') || Self::is_ident_start(self.chr())
    }

    fn is_whitespace(c: Option<u16>) -> bool {
        matches!(c, Some(0x20 | 0x09 | 0x0A | 0x0D | 0x0C))
    }

    fn skip_whitespace(&mut self) {
        while Self::is_whitespace(self.chr()) {
            self.next();
        }
    }

    fn skip_single_whitespace(&mut self) {
        if matches!(self.chr(), Some(0x20 | 0x09 | 0x0C | 0x0A)) {
            self.next();
            return;
        }
        if self.is('\r') {
            self.next();
        }
        if self.is('\n') {
            self.next();
        }
    }

    fn match_multichar(&mut self, options: &[&str]) -> Option<String> {
        let mut best: Option<&str> = None;
        for option in options {
            let units: Vec<u16> = option.encode_utf16().collect();
            if self.text.get(self.pos..self.pos + units.len()) == Some(&units[..]) && best.is_none_or(|b| b.len() < option.len()) {
                best = Some(option);
            }
        }
        let found = best?;
        self.pos += found.len();
        Some(found.to_string())
    }

    fn parse_hex(&mut self) -> u16 {
        let mut hex = String::from(char::from_u32(self.read_and_next() as u32).unwrap_or('0'));
        let mut count = 1;
        while Self::is_hex(self.chr()) && count < 6 {
            hex.push(char::from_u32(self.read_and_next() as u32).unwrap_or('0'));
            count += 1;
        }
        self.skip_single_whitespace();
        (u32::from_str_radix(&hex, 16).unwrap_or(0) & 0xFFFF) as u16
    }

    fn parse_string(&mut self, quote: u16) -> Result<(), ParseError> {
        self.next();
        while !self.eof() {
            if self.chr() == Some(quote) {
                self.next();
                return Ok(());
            } else if self.is('\\') {
                self.next();
                if self.chr() == Some(quote) || self.is('\n') || self.is('\u{c}') {
                    self.next();
                } else if self.is('\r') {
                    self.next();
                    if self.is('\n') {
                        self.next();
                    }
                } else if Self::is_hex(self.chr()) {
                    self.parse_hex();
                } else {
                    self.next();
                }
            } else {
                self.next();
            }
        }
        Ok(())
    }

    fn parse_identifier(&mut self) -> Result<Option<Vec<u16>>, ParseError> {
        if !Self::is_ident_start(self.chr()) {
            return Ok(None);
        }
        let mut result: Vec<u16> = Vec::new();
        while self.is('-') {
            result.push(unit('-'));
            self.next();
        }
        if result.len() == 1 && !Self::is_ident(self.chr()) && !self.is('\\') {
            return self.fail("Identifiers cannot consist of a single hyphen.");
        }
        if result.len() >= 2 {
            return self.fail("Identifiers cannot start with two hyphens with strict mode on.");
        }
        if Self::is_digit(self.chr()) {
            return self.fail("Identifiers cannot start with hyphens followed by digits.");
        }
        while !self.eof() {
            if Self::is_ident(self.chr()) {
                result.push(self.read_and_next());
            } else if self.is('\\') {
                self.next();
                self.check(!self.eof(), "Unexpected end of input.")?;
                if Self::is_hex(self.chr()) {
                    result.push(self.parse_hex());
                } else {
                    result.push(self.read_and_next());
                }
            } else {
                break;
            }
        }
        Ok(Some(result))
    }

    fn parse_pseudo_class_string(&mut self) -> Result<Vec<u16>, ParseError> {
        let mut result: Vec<u16> = Vec::new();
        while !self.eof() {
            if self.is(')') {
                break;
            } else if self.is('\\') {
                self.next();
                self.check(!self.eof(), "Unexpected end of input.")?;
                if Self::is_hex(self.chr()) {
                    result.push(self.parse_hex());
                } else {
                    result.push(self.read_and_next());
                }
            } else {
                result.push(self.read_and_next());
            }
        }
        let text = String::from_utf16_lossy(&result);
        Ok(text.trim_matches(telorun_cel_value::is_es_whitespace).encode_utf16().collect())
    }

    fn parse_selector(&mut self, relative: bool) -> Result<Selector, ParseError> {
        self.skip_whitespace();
        let mut rules = vec![self.parse_rule(relative)?];
        while self.is(',') {
            self.next();
            self.skip_whitespace();
            rules.push(self.parse_rule(relative)?);
        }
        Ok(Selector { rules })
    }

    fn parse_attribute(&mut self) -> Result<(), ParseError> {
        self.next();
        self.skip_whitespace();
        if self.is('|') || self.is('*') {
            return self.fail("Namespaces are not enabled.");
        }
        let identifier = self.parse_identifier()?;
        self.check(identifier.is_some(), "Expected attribute name.")?;
        if self.is('|') {
            let saved = self.pos;
            self.next();
            if Self::is_ident_start(self.chr()) {
                return self.fail("Namespaces are not enabled.");
            }
            self.pos = saved;
        }
        self.check(identifier.is_some_and(|name| !name.is_empty()), "Expected attribute name.")?;
        self.skip_whitespace();
        if self.is(']') {
            self.next();
            return Ok(());
        }
        let operator = self.match_multichar(&ATTRIBUTE_OPERATORS);
        self.check(operator.is_some(), "Expected a valid attribute selector operator.")?;
        self.skip_whitespace();
        self.check(!self.eof(), "Unexpected end of input.")?;
        if self.is('"') || self.is('\'') {
            let quote = self.chr().unwrap();
            self.parse_string(quote)?;
        } else {
            let value = self.parse_identifier()?;
            self.check(value.is_some_and(|v| !v.is_empty()), "Expected attribute value.")?;
        }
        self.skip_whitespace();
        if !self.is(']') {
            let modifier = self.parse_identifier()?;
            self.check(modifier.as_ref().is_some_and(|m| !m.is_empty()), "Expected end of attribute selector.")?;
            let modifier = String::from_utf16_lossy(&modifier.unwrap());
            let known = ["i", "I", "s", "S"].contains(&modifier.as_str()) || inherited_member(&modifier).is_some();
            self.check(known, "Unknown attribute case sensitivity modifier.")?;
            self.skip_whitespace();
        }
        self.check(!self.eof(), "Expected \"]\" but end of input reached.")?;
        if !self.is(']') {
            let found = String::from_utf16_lossy(&[self.chr().unwrap()]);
            return self.fail(format!("Expected \"]\" but \"{found}\" found."));
        }
        self.next();
        Ok(())
    }

    fn parse_number(&mut self) -> Result<i64, ParseError> {
        let mut digits = String::new();
        while Self::is_digit(self.chr()) {
            digits.push(self.read_and_next() as u8 as char);
        }
        self.check(!digits.is_empty(), "Formula parse error.")?;
        Ok(digits.parse::<i64>().unwrap_or(i64::MAX))
    }

    fn parse_formula(&mut self) -> Result<(), ParseError> {
        if self.is('e') || self.is('o') {
            let ident = self.parse_identifier()?.map(|i| String::from_utf16_lossy(&i));
            if ident.as_deref() == Some("even") || ident.as_deref() == Some("odd") {
                self.skip_whitespace();
                return Ok(());
            }
        }
        let mut first = None;
        if self.is('-') {
            self.next();
        }
        if self.is('-') || self.is('+') || Self::is_digit(self.chr()) {
            if self.is('+') {
                self.next();
            }
            first = Some(self.parse_number()?);
            if !self.is('\\') && !self.is('n') {
                return Ok(());
            }
        }
        let _ = first;
        let identifier = if self.is('\\') {
            self.next();
            if Self::is_hex(self.chr()) {
                self.parse_hex()
            } else {
                self.read_and_next()
            }
        } else {
            self.read_and_next()
        };
        self.check(identifier == unit('n'), "Formula parse error: expected \"n\".")?;
        self.skip_whitespace();
        if self.is('+') || self.is('-') {
            self.next();
            self.skip_whitespace();
            self.parse_number()?;
        }
        Ok(())
    }

    fn parse_pseudo_argument(&mut self, name: &str, signature: Signature) -> Result<Option<Argument>, ParseError> {
        if !self.is('(') {
            let optional = match signature {
                Signature::NoArgument => true,
                Signature::String { optional } | Signature::Selector { optional } => optional,
                Signature::Formula { .. } | Signature::Inherited => false,
            };
            self.check(optional, &format!("Argument is required for pseudo-class \"{name}\"."))?;
            return Ok(None);
        }
        self.next();
        self.skip_whitespace();
        let argument = match signature {
            Signature::String { .. } => {
                let value = self.parse_pseudo_class_string()?;
                self.check(!value.is_empty(), "Expected pseudo-class argument value.")?;
                Argument::Text
            }
            Signature::Selector { .. } => Argument::Selector(self.parse_selector(true)?),
            Signature::Formula { of_selector } => {
                self.parse_formula()?;
                let mut argument = Argument::Formula;
                if of_selector {
                    self.skip_whitespace();
                    if self.is('o') || self.is('\\') {
                        let ident = self.parse_identifier()?.map(|i| String::from_utf16_lossy(&i));
                        self.check(ident.as_deref() == Some("of"), "Formula of selector parse error.")?;
                        self.skip_whitespace();
                        argument = Argument::FormulaOfSelector(self.parse_rule(false)?);
                    }
                }
                argument
            }
            Signature::NoArgument | Signature::Inherited => return self.fail("Invalid pseudo-class signature."),
        };
        self.skip_whitespace();
        self.check(!self.eof(), "Expected \")\" but end of input reached.")?;
        if !self.is(')') {
            let found = String::from_utf16_lossy(&[self.chr().unwrap()]);
            return self.fail(format!("Expected \")\" but \"{found}\" found."));
        }
        self.next();
        Ok(Some(argument))
    }

    fn parse_tag_name(&mut self) -> Result<(), ParseError> {
        if self.is('*') {
            self.next();
            return Ok(());
        }
        if Self::is_ident_start(self.chr()) {
            let name = self.parse_identifier()?;
            return self.check(name.is_some_and(|n| !n.is_empty()), "Expected tag name.");
        }
        self.fail("Expected tag name.")
    }

    fn parse_tag_name_with_namespace(&mut self) -> Result<(), ParseError> {
        if self.is('*') {
            let saved = self.pos;
            self.next();
            if !self.is('|') {
                self.pos = saved;
                return self.parse_tag_name();
            }
            self.next();
            if !self.is_tag_start() {
                self.pos = saved;
                return self.parse_tag_name();
            }
            return self.fail("Namespaces are not enabled.");
        }
        if self.is('|') {
            return self.fail("Namespaces are not enabled.");
        }
        if Self::is_ident_start(self.chr()) {
            let identifier = self.parse_identifier()?;
            self.check(identifier.is_some_and(|i| !i.is_empty()), "Expected tag name.")?;
            if !self.is('|') {
                return Ok(());
            }
            let saved = self.pos;
            self.next();
            if !self.is_tag_start() {
                self.pos = saved;
                return Ok(());
            }
            return self.fail("Namespaces are not enabled.");
        }
        self.fail("Expected tag name.")
    }

    fn parse_rule(&mut self, relative: bool) -> Result<Rule, ParseError> {
        let mut rule = Rule { combinator: None, items: Vec::new(), nested: None };
        if relative {
            if let Some(combinator) = self.match_multichar(&COMBINATORS) {
                rule.combinator = Some(combinator);
                self.skip_whitespace();
            }
        }
        while !self.eof() {
            if self.is_tag_start() {
                self.check(rule.items.is_empty(), "Unexpected tag/namespace start.")?;
                self.parse_tag_name_with_namespace()?;
                rule.items.push(Item::Other);
            } else if self.is('|') {
                let saved = self.pos;
                self.next();
                if self.is_tag_start() {
                    self.check(rule.items.is_empty(), "Unexpected tag/namespace start.")?;
                    self.pos = saved;
                    self.parse_tag_name_with_namespace()?;
                    rule.items.push(Item::Other);
                } else {
                    self.pos = saved;
                    break;
                }
            } else if self.is('.') || self.is('#') {
                let class = self.is('.');
                self.next();
                let name = self.parse_identifier()?;
                self.check(name.is_some_and(|n| !n.is_empty()), if class { "Expected class name." } else { "Expected ID name." })?;
                rule.items.push(Item::Other);
            } else if self.is('&') {
                return self.fail("Nesting selector is not enabled.");
            } else if self.is('[') {
                self.parse_attribute()?;
                rule.items.push(Item::Other);
            } else if self.is(':') {
                self.next();
                if self.is(':') {
                    return self.fail("Pseudo elements are not enabled.");
                }
                let name = self.parse_identifier()?.filter(|n| !n.is_empty());
                self.check(name.is_some(), "Expected pseudo-class name.")?;
                let name = String::from_utf16_lossy(&name.unwrap());
                let Some(signature) = pseudo_class(&name) else {
                    let locations = pseudo_class_locations(&name);
                    let mut message = format!("Unknown pseudo-class: \"{name}\"");
                    if !locations.is_empty() {
                        message.push_str(&format!(". It is defined in: {}", locations.join(", ")));
                    }
                    return self.fail(message + ".");
                };
                let argument = self.parse_pseudo_argument(&name, signature)?;
                rule.items.push(Item::PseudoClass { name, argument });
            } else {
                break;
            }
        }
        if rule.items.is_empty() {
            if self.eof() {
                return self.fail("Expected rule but end of input reached.");
            }
            let found = String::from_utf16_lossy(&[self.chr().unwrap()]);
            return self.fail(format!("Expected rule but \"{found}\" found."));
        }
        self.skip_whitespace();
        if !self.eof() && !self.is(',') && !self.is(')') {
            let combinator = self.match_multichar(&COMBINATORS);
            self.skip_whitespace();
            let mut nested = self.parse_rule(false)?;
            nested.combinator = combinator;
            rule.nested = Some(Box::new(nested));
        }
        Ok(rule)
    }
}

// The checker.

struct Rewritten {
    text: Vec<u16>,
    /// Each insertion's place in the rewritten text and its length, innermost pass last.
    passes: Vec<Vec<(usize, usize)>>,
}

impl Rewritten {
    /// An offset in the rewritten text mapped back to the author's text.
    fn original(&self, offset: usize) -> usize {
        self.passes.iter().rev().fold(offset, |offset, insertions| {
            offset - insertions.iter().filter(|(at, _)| *at < offset).map(|(_, length)| length).sum::<usize>()
        })
    }
}

fn is_es_space_unit(unit: Option<u16>) -> bool {
    unit.and_then(|u| char::from_u32(u as u32)).is_some_and(telorun_cel_value::is_es_whitespace)
}

/// The index of the `)` closing the `(` at `open`, skipping strings, escapes and nested
/// parentheses.
fn closing_paren(text: &[u16], open: usize) -> Option<usize> {
    let mut depth = 0i64;
    let mut i = open;
    while i < text.len() {
        let c = text[i];
        if c == unit('\\') {
            i += 1;
        } else if c == unit('"') || c == unit('\'') {
            i += 1;
            while i < text.len() && text[i] != c {
                if text[i] == unit('\\') {
                    i += 1;
                }
                i += 1;
            }
        } else if c == unit('(') {
            depth += 1;
        } else if c == unit(')') {
            depth -= 1;
            if depth == 0 {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

/// The offsets of the top-level places in `text` that `test` accepts, outside strings,
/// parentheses and brackets.
fn top_level(text: &[u16], test: &dyn Fn(usize) -> bool) -> Vec<usize> {
    let mut found = Vec::new();
    let mut depth = 0i64;
    let mut i = 0;
    while i < text.len() {
        let c = text[i];
        if c == unit('\\') {
            i += 1;
        } else if c == unit('"') || c == unit('\'') {
            i += 1;
            while i < text.len() && text[i] != c {
                if text[i] == unit('\\') {
                    i += 1;
                }
                i += 1;
            }
        } else if c == unit('(') || c == unit('[') {
            depth += 1;
        } else if c == unit(')') || c == unit(']') {
            depth -= 1;
        } else if depth == 0 && test(i) {
            found.push(i);
        }
        i += 1;
    }
    found
}

fn starts_with_ignoring_ascii_case(text: &[u16], at: usize, word: &str) -> bool {
    let word: Vec<u16> = word.encode_utf16().collect();
    text.get(at..at + word.len()).is_some_and(|slice| {
        slice.iter().zip(&word).all(|(a, b)| a == b || (*a < 0x80 && (*a as u8).to_ascii_lowercase() as u16 == *b))
    })
}

/// `/:nth-(last-)?child\(/gi` from `from`: where it matches and where it ends.
fn find_nth_of(text: &[u16], from: usize) -> Option<(usize, usize)> {
    (from..text.len()).find_map(|at| {
        if starts_with_ignoring_ascii_case(text, at, ":nth-last-child(") {
            Some((at, at + 16))
        } else if starts_with_ignoring_ascii_case(text, at, ":nth-child(") {
            Some((at, at + 11))
        } else {
            None
        }
    })
}

/// One pass of [`with_of_lists_as_is`], over the outermost occurrences.
fn rewrite_once(text: &[u16]) -> (Vec<u16>, Vec<(usize, usize)>) {
    let mut insertions = Vec::new();
    let mut out: Vec<u16> = Vec::new();
    let mut cursor = 0;
    let mut last = 0;
    while let Some((at, end)) = find_nth_of(text, last) {
        last = end;
        let open = end - 1;
        let Some(close) = closing_paren(text, open) else { break };
        let argument = &text[open + 1..close];
        let of = top_level(argument, &|i| {
            i > 0 && is_es_space_unit(argument.get(i - 1).copied()) && starts_with_ignoring_ascii_case(argument, i, "of") && is_es_space_unit(argument.get(i + 2).copied())
        });
        let _ = at;
        let Some(of) = of.first().copied() else { continue };
        let list_start = open + 1 + of + 2;
        let list = &text[list_start..close];
        if top_level(list, &|i| list[i] == unit(',')).is_empty() {
            continue;
        }
        last = close;
        out.extend_from_slice(&text[cursor..list_start]);
        out.extend(" :is(".encode_utf16());
        insertions.push((out.len() - 5, 5));
        out.extend_from_slice(list);
        out.push(unit(')'));
        insertions.push((out.len() - 1, 1));
        cursor = close;
    }
    out.extend_from_slice(&text[cursor..]);
    (out, insertions)
}

/// `:nth-child(An+B of S1, S2)` → `:nth-child(An+B of :is(S1, S2))`, repeated until
/// nested ones are rewritten too.
fn with_of_lists_as_is(text: &str) -> Rewritten {
    let mut current = Rewritten { text: text.encode_utf16().collect(), passes: Vec::new() };
    loop {
        let (next, insertions) = rewrite_once(&current.text);
        if insertions.is_empty() {
            return current;
        }
        current.text = next;
        current.passes.push(insertions);
    }
}

struct Spec<'a> {
    lower: &'a [u16],
    cursor: usize,
}

impl Spec<'_> {
    fn locate(&mut self, name: &str) -> usize {
        let needle: Vec<u16> = format!(":{name}").encode_utf16().collect();
        let found = (self.cursor..self.lower.len()).find(|at| self.lower.get(*at..*at + needle.len()) == Some(&needle[..]));
        match found {
            Some(index) => {
                self.cursor = index + 1;
                index
            }
            None => 0,
        }
    }

    fn in_selector(&mut self, selector: &Selector, in_has: bool, enclosing: Option<(&str, usize)>) -> Option<(String, usize)> {
        for rule in &selector.rules {
            if let (Some(_), Some((name, offset))) = (&rule.combinator, enclosing) {
                return Some((format!("A leading combinator is valid only in :has(), not in :{name}()"), offset));
            }
            if let Some(problem) = self.in_rule(rule, in_has) {
                return Some(problem);
            }
        }
        None
    }

    fn in_rule(&mut self, rule: &Rule, in_has: bool) -> Option<(String, usize)> {
        for item in &rule.items {
            let Item::PseudoClass { name, argument } = item else { continue };
            let offset = self.locate(name);
            let problem = if name == "has" {
                if in_has {
                    return Some((":has() cannot be nested inside :has()".into(), offset));
                }
                match argument {
                    Some(Argument::Selector(selector)) => self.in_selector(selector, true, None),
                    _ => None,
                }
            } else {
                match argument {
                    Some(Argument::Selector(selector)) => self.in_selector(selector, in_has, Some((name, offset))),
                    Some(Argument::FormulaOfSelector(of)) => {
                        if of.combinator.is_some() {
                            return Some((format!("A leading combinator is not valid after 'of' in :{name}()"), offset));
                        }
                        self.in_rule(of, in_has)
                    }
                    _ => None,
                }
            };
            if problem.is_some() {
                return problem;
            }
        }
        rule.nested.as_ref().and_then(|nested| self.in_rule(nested, in_has))
    }
}

pub fn check(value: &str) -> Option<FormatFailure> {
    let rewritten = with_of_lists_as_is(value);
    let mut parser = Parser { text: rewritten.text.clone(), pos: 0 };
    let selector = match parser.parse_selector(false) {
        Ok(selector) => selector,
        Err(error) => {
            let reason = error.message.strip_suffix('.').unwrap_or(&error.message).to_string();
            let offset = if error.position >= 0 { rewritten.original(error.position as usize) } else { 0 };
            return fail(reason, offset);
        }
    };
    let lower: Vec<u16> = es_to_lower_case(&String::from_utf16_lossy(&rewritten.text)).encode_utf16().collect();
    let mut spec = Spec { lower: &lower, cursor: 0 };
    let (reason, offset) = spec.in_selector(&selector, false, None)?;
    fail(reason, rewritten.original(offset))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn holds_the_entry_s_conformance_set() {
        crate::telo_format::assert_conformance("css-selector", include_str!("../../../sdk/formats/css-selector.json"));
    }

    #[test]
    fn words_a_refusal_as_the_parser_does() {
        assert_eq!(check("div[").map(|f| (f.reason, f.offset)), Some(("Expected attribute name".into(), 3)));
        assert_eq!(check(":nosuchclass").map(|f| f.reason), Some("Unknown pseudo-class: \"nosuchclass\"".into()));
        assert_eq!(check(":has(:has(a))").map(|f| (f.reason, f.offset)), Some((":has() cannot be nested inside :has()".into(), 5)));
    }
}
