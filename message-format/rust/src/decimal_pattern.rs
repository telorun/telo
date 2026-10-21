//! The subset of CLDR decimal patterns every locale's standard pattern falls within:
//! `#` and `0` integer digits with `,` grouping separators, then an optional `.` with
//! `0` and `#` fraction digits.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct DecimalPattern {
    pub minimum_integer_digits: usize,
    pub minimum_fraction_digits: usize,
    pub maximum_fraction_digits: usize,
    /// Digits in the group nearest the decimal separator; 0 when the pattern groups nothing.
    pub primary_grouping: usize,
    /// Digits in every further group.
    pub secondary_grouping: usize,
}

/// Whether `integer` is `(#+,)*#*0+`.
fn integer_in_subset(integer: &str) -> bool {
    let groups: Vec<&str> = integer.split(',').collect();
    let (last, leading) = groups.split_last().expect("split answers one group at least");
    let last_ok = {
        let zeros = last.trim_start_matches('#');
        !zeros.is_empty() && zeros.bytes().all(|b| b == b'0')
    };
    last_ok && leading.iter().all(|group| !group.is_empty() && group.bytes().all(|b| b == b'#'))
}

pub(crate) fn parse_decimal_pattern(pattern: &str) -> Option<DecimalPattern> {
    let (integer, fraction) = match pattern.split_once('.') {
        Some((integer, fraction)) => (integer, fraction),
        None => (pattern, ""),
    };
    let fraction_ok = {
        let hashes = fraction.trim_start_matches('0');
        hashes.bytes().all(|b| b == b'#')
    };
    if !integer_in_subset(integer) || !fraction_ok {
        return None;
    }
    let groups: Vec<&str> = integer.split(',').collect();
    let primary_grouping = if groups.len() > 1 { groups[groups.len() - 1].len() } else { 0 };
    Some(DecimalPattern {
        minimum_integer_digits: integer.bytes().filter(|b| *b == b'0').count(),
        minimum_fraction_digits: fraction.bytes().filter(|b| *b == b'0').count(),
        maximum_fraction_digits: fraction.len(),
        primary_grouping,
        secondary_grouping: if groups.len() > 2 { groups[groups.len() - 2].len() } else { primary_grouping },
    })
}
