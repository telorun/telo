//! A number's text and its plural category, from its value alone: an integer written
//! exactly; a double as its shortest round-trip decimal, rounded half-to-even to the
//! pattern's maximum fraction digits, trailing zeros dropped down to its minimum, a zero
//! result unsigned, a non-finite one refused. Then the language's pattern, grouping,
//! digits and symbols. Plural selection reads the operands of that rounded decimal.

use crate::cldr_locale::{number_entry_for, plural_rule_set_for};
use crate::cldr_tables::CldrNumberEntry;
use crate::decimal_pattern::DecimalPattern;
use crate::message_model::PluralCategory;
use crate::message_problem::{MessageCode, MessageFormatError};
use crate::plural_operands::{operands_of_decimal, PluralOperands};
use crate::plural_rule::plural_rule_holds;

/// A number the core formats.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum NumberValue {
    Int(i64),
    Uint(u64),
    Double(f64),
}

/// A number after rounding: ASCII digits, the integer part without leading zeros.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RoundedDecimal {
    pub negative: bool,
    pub integer: String,
    pub fraction: String,
}

/// Why `value` is no number the core formats, worded about `subject`; `None` when it is one.
pub(crate) fn number_refusal(value: NumberValue, subject: &str) -> Option<String> {
    match value {
        NumberValue::Double(double) if !double.is_finite() => Some(format!("{subject} is not a finite number")),
        _ => None,
    }
}

/// The significant digits of `|value|` and where the decimal point sits among them.
fn significant_digits(value: NumberValue) -> (Vec<u8>, i64) {
    let (digits, point): (Vec<u8>, i64) = match value {
        NumberValue::Int(integer) => {
            let text = integer.unsigned_abs().to_string();
            let length = text.len() as i64;
            (text.into_bytes(), length)
        }
        NumberValue::Uint(integer) => {
            let text = integer.to_string();
            let length = text.len() as i64;
            (text.into_bytes(), length)
        }
        NumberValue::Double(double) => {
            let text = format!("{:e}", double.abs());
            let (mantissa, exponent) = text.split_once('e').expect("LowerExp writes an exponent");
            let (integer, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
            let exponent: i64 = exponent.parse().expect("LowerExp writes an integer exponent");
            (format!("{integer}{fraction}").into_bytes(), integer.len() as i64 + exponent)
        }
    };
    let leading = digits.iter().take_while(|digit| **digit == b'0').count();
    let mut significant = digits[leading..].to_vec();
    while significant.last() == Some(&b'0') {
        significant.pop();
    }
    (significant, point - leading as i64)
}

fn is_negative(value: NumberValue) -> bool {
    match value {
        NumberValue::Int(integer) => integer < 0,
        NumberValue::Uint(_) => false,
        NumberValue::Double(double) => double < 0.0,
    }
}

pub(crate) fn rounded_decimal(value: NumberValue, pattern: &DecimalPattern) -> RoundedDecimal {
    let (mut digits, mut point) = significant_digits(value);
    let keep = point + pattern.maximum_fraction_digits as i64;
    if keep < 0 {
        digits.clear();
    } else if (keep as usize) < digits.len() {
        let keep = keep as usize;
        let mut kept = digits[..keep].to_vec();
        let first = digits[keep];
        let rest_non_zero = digits[keep + 1..].iter().any(|digit| *digit != b'0');
        let last = if keep > 0 { kept[keep - 1] - b'0' } else { 0 };
        let up = first > b'5' || (first == b'5' && (rest_non_zero || last % 2 == 1));
        if up {
            let mut index = kept.len();
            loop {
                if index == 0 {
                    kept.insert(0, b'1');
                    point += 1;
                    break;
                }
                index -= 1;
                if kept[index] == b'9' {
                    kept[index] = b'0';
                } else {
                    kept[index] += 1;
                    break;
                }
            }
        }
        digits = kept;
    }
    let mut integer: Vec<u8> = if point > 0 {
        let point = point as usize;
        let mut whole = digits[..point.min(digits.len())].to_vec();
        whole.resize(point, b'0');
        whole
    } else {
        Vec::new()
    };
    let mut fraction: Vec<u8> = if point >= 0 {
        digits.get(point as usize..).map(<[u8]>::to_vec).unwrap_or_default()
    } else {
        let mut leading = vec![b'0'; point.unsigned_abs() as usize];
        leading.extend_from_slice(&digits);
        leading
    };
    while fraction.last() == Some(&b'0') {
        fraction.pop();
    }
    while fraction.len() < pattern.minimum_fraction_digits {
        fraction.push(b'0');
    }
    let leading = integer.iter().take_while(|digit| **digit == b'0').count();
    integer.drain(..leading);
    let zero = integer.is_empty() && fraction.iter().all(|digit| *digit == b'0');
    while integer.len() < pattern.minimum_integer_digits.max(1) {
        integer.insert(0, b'0');
    }
    RoundedDecimal {
        negative: !zero && is_negative(value),
        integer: String::from_utf8(integer).expect("ASCII digits"),
        fraction: String::from_utf8(fraction).expect("ASCII digits"),
    }
}

fn without_leading_zeros(digits: &str) -> String {
    let stripped = digits.trim_start_matches('0');
    if stripped.is_empty() {
        "0".to_string()
    } else {
        stripped.to_string()
    }
}

pub(crate) fn decimal_operands(decimal: &RoundedDecimal) -> PluralOperands {
    PluralOperands { integer: without_leading_zeros(&decimal.integer), fraction: decimal.fraction.clone(), exponent: 0 }
}

/// Whether the rounded decimal equals the canonical integer `exact` numerically.
pub(crate) fn decimal_equals(decimal: &RoundedDecimal, exact: &str) -> bool {
    if decimal.fraction.bytes().any(|digit| digit != b'0') {
        return false;
    }
    let integer = without_leading_zeros(&decimal.integer);
    match exact.strip_prefix('-') {
        Some(magnitude) => decimal.negative && integer == magnitude,
        None => !decimal.negative && integer == exact,
    }
}

pub(crate) fn localized_decimal(decimal: &RoundedDecimal, entry: &CldrNumberEntry) -> String {
    let local = |ascii: &str| ascii.bytes().map(|digit| entry.digits[usize::from(digit - b'0')]).collect::<String>();
    let primary = entry.pattern.primary_grouping;
    let secondary = entry.pattern.secondary_grouping;
    let mut integer = decimal.integer.as_str();
    let grouped = if primary > 0 && integer.len() >= primary + entry.minimum_grouping_digits {
        let mut groups = vec![&integer[integer.len() - primary..]];
        integer = &integer[..integer.len() - primary];
        while integer.len() > secondary {
            groups.insert(0, &integer[integer.len() - secondary..]);
            integer = &integer[..integer.len() - secondary];
        }
        if !integer.is_empty() {
            groups.insert(0, integer);
        }
        groups.iter().map(|group| local(group)).collect::<Vec<_>>().join(&entry.group)
    } else {
        local(integer)
    };
    let mut text = String::new();
    if decimal.negative {
        text.push_str(&entry.minus_sign);
    }
    text.push_str(&grouped);
    if !decimal.fraction.is_empty() {
        text.push_str(&entry.decimal);
        text.push_str(&local(&decimal.fraction));
    }
    text
}

pub(crate) fn category_of_operands(operands: &PluralOperands, lang: &str) -> PluralCategory {
    plural_rule_set_for(lang)
        .rules
        .iter()
        .find(|(_, rule)| plural_rule_holds(rule, operands))
        .map(|(category, _)| *category)
        .unwrap_or(PluralCategory::Other)
}

fn checked_number(value: NumberValue) -> Result<NumberValue, MessageFormatError> {
    match number_refusal(value, "the value") {
        Some(message) => Err(MessageFormatError { code: MessageCode::PlaceholderValueUnsupported, message }),
        None => Ok(value),
    }
}

pub fn format_number(value: NumberValue, lang: &str) -> Result<String, MessageFormatError> {
    let entry = number_entry_for(lang);
    Ok(localized_decimal(&rounded_decimal(checked_number(value)?, &entry.pattern), entry))
}

pub fn plural_category(value: NumberValue, lang: &str) -> Result<PluralCategory, MessageFormatError> {
    let decimal = rounded_decimal(checked_number(value)?, &number_entry_for(lang).pattern);
    Ok(category_of_operands(&decimal_operands(&decimal), lang))
}

/// The category of a decimal written as UTS #35 writes its samples (`1.0`, `1c6`);
/// `None` when the text is not one.
pub fn plural_category_of_decimal(text: &str, lang: &str) -> Option<PluralCategory> {
    Some(category_of_operands(&operands_of_decimal(text)?, lang))
}
