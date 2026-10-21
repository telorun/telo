//! A UTS #35 plural rule (Part 3 §5.1): relations joined by `and` and `or` (`and`
//! binding tighter), each an operand, an optional `% m`, `=` or `!=`, and a list of
//! values and `a..b` ranges holding integers only. The samples after `@` are not part
//! of the rule.

use crate::plural_operands::{operand_digits, OperandName, PluralOperands};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PluralRelation {
    pub operand: OperandName,
    pub modulus: Option<u64>,
    pub equal: bool,
    pub ranges: Vec<(u64, u64)>,
}

/// Alternatives, each a conjunction of relations; empty holds always.
pub(crate) type PluralRule = Vec<Vec<PluralRelation>>;

/// Above this a value's digits are never compared as a number: every bound is below it.
const LARGEST_BOUND: u64 = 1_000_000_000_000_000;

fn tokens(condition: &str) -> Option<Vec<&str>> {
    let bytes = condition.as_bytes();
    let mut out = Vec::new();
    let mut at = 0;
    loop {
        while at < bytes.len() && bytes[at].is_ascii_whitespace() {
            at += 1;
        }
        if at >= bytes.len() {
            return Some(out);
        }
        let start = at;
        if condition[at..].starts_with("..") || condition[at..].starts_with("!=") {
            at += 2;
        } else if matches!(bytes[at], b'=' | b'%' | b',') {
            at += 1;
        } else if bytes[at].is_ascii_lowercase() {
            while at < bytes.len() && bytes[at].is_ascii_lowercase() {
                at += 1;
            }
        } else if bytes[at].is_ascii_digit() {
            while at < bytes.len() && bytes[at].is_ascii_digit() {
                at += 1;
            }
        } else {
            return None;
        }
        out.push(&condition[start..at]);
    }
}

fn operand(token: &str) -> Option<OperandName> {
    Some(match token {
        "n" => OperandName::N,
        "i" => OperandName::I,
        "v" => OperandName::V,
        "w" => OperandName::W,
        "f" => OperandName::F,
        "t" => OperandName::T,
        "c" => OperandName::C,
        "e" => OperandName::E,
        _ => return None,
    })
}

pub(crate) fn parse_plural_rule(written: &str) -> Option<PluralRule> {
    let condition = written.split('@').next().unwrap_or("");
    let tokens = tokens(condition)?;
    let mut at = 0;
    let number = |at: &mut usize| -> Option<u64> {
        let token = tokens.get(*at)?;
        *at += 1;
        if !token.bytes().all(|b| b.is_ascii_digit()) || token.len() > 16 {
            return None;
        }
        token.parse::<u64>().ok().filter(|value| *value < LARGEST_BOUND)
    };
    let mut rule = Vec::new();
    if tokens.is_empty() {
        return Some(rule);
    }
    let mut conjunction = Vec::new();
    loop {
        let name = operand(tokens.get(at)?)?;
        at += 1;
        let mut modulus = None;
        if tokens.get(at) == Some(&"%") {
            at += 1;
            modulus = Some(number(&mut at).filter(|value| *value != 0)?);
        }
        let equal = match *tokens.get(at)? {
            "=" => true,
            "!=" => false,
            _ => return None,
        };
        at += 1;
        let mut ranges = Vec::new();
        loop {
            let low = number(&mut at)?;
            let mut high = low;
            if tokens.get(at) == Some(&"..") {
                at += 1;
                high = number(&mut at)?;
            }
            ranges.push((low, high));
            if tokens.get(at) != Some(&",") {
                break;
            }
            at += 1;
        }
        conjunction.push(PluralRelation { operand: name, modulus, equal, ranges });
        match tokens.get(at) {
            None => break,
            Some(&"or") => rule.push(std::mem::take(&mut conjunction)),
            Some(&"and") => {}
            Some(_) => return None,
        }
        at += 1;
    }
    rule.push(conjunction);
    Some(rule)
}

/// `digits` modulo `modulus`, read a digit at a time so any length is exact.
fn remainder(digits: &str, modulus: u64) -> u64 {
    digits.bytes().fold(0, |value, digit| (value * 10 + u64::from(digit - b'0')) % modulus)
}

fn holds(relation: &PluralRelation, operands: &PluralOperands) -> bool {
    let in_range = operand_digits(operands, relation.operand).is_some_and(|digits| {
        let value = match relation.modulus {
            Some(modulus) => Some(remainder(&digits, modulus)),
            None if digits.len() > 15 => None,
            None => digits.parse::<u64>().ok(),
        };
        value.is_some_and(|value| relation.ranges.iter().any(|(low, high)| value >= *low && value <= *high))
    });
    in_range == relation.equal
}

pub(crate) fn plural_rule_holds(rule: &PluralRule, operands: &PluralOperands) -> bool {
    rule.is_empty() || rule.iter().any(|conjunction| conjunction.iter().all(|relation| holds(relation, operands)))
}
