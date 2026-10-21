//! The operands of a number as written (UTS #35 Part 3 §5.1), its digits kept as text
//! so an integer of any size is exact.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluralOperands {
    /// Integer digits with no leading zero (`"0"` for none).
    pub integer: String,
    /// Fraction digits as written, trailing zeros included.
    pub fraction: String,
    /// The `c` / `e` exponent of a compact number; 0 for every number the core formats.
    pub exponent: u64,
}

fn without_leading_zeros(digits: &str) -> String {
    let stripped = digits.trim_start_matches('0');
    if stripped.is_empty() {
        "0".to_string()
    } else {
        stripped.to_string()
    }
}

fn all_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

/// The operands of a decimal written as UTS #35 writes its samples: an optional `-`,
/// digits, an optional fraction and an optional `c` / `e` exponent (`1.2c3` is 1200
/// with `c` = 3). `None` when the text is not one.
pub fn operands_of_decimal(text: &str) -> Option<PluralOperands> {
    let unsigned = text.strip_prefix('-').unwrap_or(text);
    let (number, exponent) = match unsigned.find(['c', 'e']) {
        Some(cut) => {
            let exponent = &unsigned[cut + 1..];
            if !all_digits(exponent) {
                return None;
            }
            // Node reads the exponent as a safe integer.
            let value: u64 = exponent.parse().ok().filter(|value| *value <= (1u64 << 53) - 1)?;
            (&unsigned[..cut], value)
        }
        None => (unsigned, 0),
    };
    let (integer, fraction) = match number.split_once('.') {
        Some((integer, fraction)) => {
            if !all_digits(fraction) {
                return None;
            }
            (integer, fraction)
        }
        None => (number, ""),
    };
    if !all_digits(integer) {
        return None;
    }
    let digits = format!("{integer}{fraction}");
    let point = usize::try_from(exponent).ok()?.checked_add(integer.len())?;
    let (whole, rest) = if point >= digits.len() {
        (format!("{digits}{}", "0".repeat(point - digits.len())), String::new())
    } else {
        (digits[..point].to_string(), digits[point..].to_string())
    };
    Some(PluralOperands { integer: without_leading_zeros(&whole), fraction: rest, exponent })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OperandName {
    N,
    I,
    V,
    W,
    F,
    T,
    C,
    E,
}

/// An operand's value: integer digits, or `None` for an `n` with a non-zero fraction,
/// which equals no integer.
pub(crate) fn operand_digits(operands: &PluralOperands, name: OperandName) -> Option<String> {
    let trimmed = operands.fraction.trim_end_matches('0');
    match name {
        OperandName::N => trimmed.is_empty().then(|| operands.integer.clone()),
        OperandName::I => Some(operands.integer.clone()),
        OperandName::V => Some(operands.fraction.len().to_string()),
        OperandName::W => Some(trimmed.len().to_string()),
        OperandName::F => Some(without_leading_zeros(&operands.fraction)),
        OperandName::T => Some(without_leading_zeros(trimmed)),
        OperandName::C | OperandName::E => Some(operands.exponent.to_string()),
    }
}
