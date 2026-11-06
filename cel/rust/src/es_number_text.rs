//! No Node twin: the number methods of Node's host, V8 — `Number.prototype.toFixed`,
//! `toExponential` and `toPrecision`, `toString(2 | 8 | 16)` of an integer, `Math.round`,
//! and the digits `toString` and `toLocaleString("en")` write for a whole number — which
//! `catalog-runtime.ts` and d3-format 3.1.2 call. Recorded against V8 13.6.233.10-node.28
//! (Node v24.11.1, ICU 77.1).
//!
//! **ECMA-262 decides every rounding, never std.** A method asks for the integer `n` nearest
//! the exact value and, where two lie equally near, the larger — ties away from zero on the
//! magnitude, where std's formatting settles a tie to the even digit. So std only generates
//! digits: one digit more than asked for is written, and a last digit other than 5 decides
//! the rounding alone. A 5 is a candidate tie, settled on the exact decimal expansion, which
//! is computed only then and is at most a double's 1,074 fractional or 767 significant
//! digits long. The shortest digits — `toExponential()` with no argument, and the digits of
//! `Number::toString` — are std's shortest, a candidate tie between two of that length
//! settled on the exact expansion to the even one, as V8 settles it.
//!
//! An argument outside the range a method accepts (a `RangeError` on V8) is a caller's
//! defect and panics.

use std::io::Write;

/// The most digits `toFixed` and `toExponential` take, and the most `toPrecision` takes.
pub(crate) const MAX_FRACTION_DIGITS: usize = 100;

/// The largest whole number below which every integer is a double.
const EXACT_INTEGERS: f64 = 9_007_199_254_740_992.0;

#[cfg(test)]
thread_local! {
    /// How many exact expansions this thread has computed.
    pub(crate) static EXACT_EXPANSIONS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// Significant digit `at` (from 0, at least 1) of a finite positive double's exact
/// expansion.
fn exact_significant_digit(magnitude: f64, at: usize) -> u8 {
    #[cfg(test)]
    EXACT_EXPANSIONS.with(|count| count.set(count.get() + 1));
    // `d.ddd…e…`: the point follows the first digit.
    format!("{magnitude:.766e}").as_bytes()[at + 1]
}

/// The sign `toFixed`, `toExponential` and `toPrecision` write: a minus for a value below
/// zero, which the negative zero is not.
fn sign_and_magnitude(value: f64) -> (&'static str, f64) {
    if value < 0.0 {
        ("-", -value)
    } else {
        ("", value.abs())
    }
}

/// Adds one to a run of decimal digits, skipping a point; true when the carry left the
/// first digit, the run then reading `1` and zeros, one zero short of the sum.
fn increment(digits: &mut [u8]) -> bool {
    for digit in digits.iter_mut().rev() {
        match *digit {
            b'.' => {}
            b'9' => *digit = b'0',
            _ => {
                *digit += 1;
                return false;
            }
        }
    }
    if let Some(first) = digits.first_mut() {
        *first = b'1';
    }
    true
}

/// std's scientific text written into `out` (`1.2345e-7`), turned into its digits alone;
/// answers the exponent.
fn scientific_into(out: &mut Vec<u8>, text: std::fmt::Arguments<'_>) -> i32 {
    let from = out.len();
    out.write_fmt(text).expect("a vector takes every write");
    let e = from + out[from..].iter().position(|byte| *byte == b'e').expect("scientific notation has an exponent");
    let exponent = std::str::from_utf8(&out[e + 1..]).expect("ASCII").parse().expect("the exponent is an integer");
    out.truncate(e);
    if out.len() > from + 1 {
        out.remove(from + 1);
    }
    exponent
}

/// A finite positive double as `m × 2^e`, `m` below 2^53.
fn binary_parts(magnitude: f64) -> (u64, i32) {
    let raw = magnitude.to_bits();
    let biased = (raw >> 52) as i32;
    let fraction = raw & ((1 << 52) - 1);
    if biased == 0 {
        (fraction, -1074)
    } else {
        (fraction | 1 << 52, biased - 1075)
    }
}

/// The integer nearest `magnitude × 10^scale`, a tie to the larger — ECMA-262's `n` —
/// computed exactly in 128 bits, or nothing where they cannot hold it.
fn scaled_rounded(magnitude: f64, scale: i32) -> Option<u128> {
    let (mantissa, exponent) = binary_parts(magnitude);
    if mantissa == 0 {
        return Some(0);
    }
    let mut numerator = u128::from(mantissa);
    let mut denominator: u128 = 1;
    let power = 10u128.checked_pow(scale.unsigned_abs())?;
    if scale >= 0 {
        numerator = numerator.checked_mul(power)?;
    } else {
        denominator = power;
    }
    let binary = 1u128.checked_shl(exponent.unsigned_abs()).filter(|_| exponent.unsigned_abs() < 127)?;
    if exponent >= 0 {
        numerator = numerator.checked_mul(binary)?;
    } else {
        denominator = denominator.checked_mul(binary)?;
    }
    let (quotient, remainder) = (numerator / denominator, numerator % denominator);
    Some(quotient + u128::from(remainder >= denominator - remainder))
}

/// `count` significant digits and the exponent of the first, computed exactly in 128 bits:
/// the exponent is estimated, then moved until `n` has `count` digits, and a power of ten
/// rounded up to from below is tried one exponent lower, where it may still have them.
fn significant_exact(magnitude: f64, count: usize) -> Option<(u128, i32)> {
    let low = 10u128.checked_pow(count as u32 - 1)?;
    let high = low.checked_mul(10)?;
    let mut exponent = magnitude.log10().floor() as i32;
    let mut n = scaled_rounded(magnitude, count as i32 - 1 - exponent)?;
    loop {
        if n >= high {
            exponent += 1;
        } else if n < low {
            exponent -= 1;
        } else {
            break;
        }
        n = scaled_rounded(magnitude, count as i32 - 1 - exponent)?;
    }
    if n == low {
        let below = scaled_rounded(magnitude, count as i32 - exponent)?;
        if below < high {
            return Some((below, exponent - 1));
        }
    }
    Some((n, exponent))
}

/// `count` significant digits of a finite positive double written onto `out`, rounded as
/// ECMA-262's `toExponential` and `toPrecision` round — to the nearest, a tie to the larger;
/// answers the exponent of the first.
fn significant_digits_into(out: &mut Vec<u8>, magnitude: f64, count: usize) -> i32 {
    if let Some((n, exponent)) = significant_exact(magnitude, count) {
        write!(out, "{n}").expect("a vector takes every write");
        return exponent;
    }
    let from = out.len();
    let mut exponent = scientific_into(out, format_args!("{magnitude:.count$e}"));
    let last = out.pop().expect("one digit more than asked for");
    let up = match last {
        b'5' => exact_significant_digit(magnitude, count) >= b'5',
        last => last > b'5',
    };
    if up && increment(&mut out[from..]) {
        exponent += 1;
    }
    exponent
}

/// The shortest digits that read back as a finite positive double, written onto `out`, and
/// the exponent of the first — where two candidates of that length read back and lie
/// equally near, the one ending in an even digit.
fn shortest_digits_into(out: &mut Vec<u8>, magnitude: f64) -> i32 {
    let from = out.len();
    let exponent = scientific_into(out, format_args!("{magnitude:e}"));
    let k = out.len() - from;
    if out[out.len() - 1] % 2 == 0 {
        return exponent;
    }
    // A tie needs the exact value to be the midpoint after `k` digits.
    let mut probe = Vec::with_capacity(k + 8);
    let probe_exponent = scientific_into(&mut probe, format_args!("{magnitude:.k$e}"));
    if probe_exponent != exponent || probe[k] != b'5' {
        return exponent;
    }
    #[cfg(test)]
    EXACT_EXPANSIONS.with(|count| count.set(count.get() + 1));
    let exact = format!("{magnitude:.766e}").replace('.', "");
    let exact = exact.as_bytes();
    if exact[k] != b'5' || exact[k + 1..].iter().take_while(|byte| **byte != b'e').any(|byte| *byte != b'0') {
        return exponent;
    }
    // The candidate on the value's other side, of the same length and even.
    let shortest = &mut out[from..];
    let mut other = exact[..k].to_vec();
    if other == shortest {
        if increment(&mut other) {
            return exponent;
        }
    }
    let text = format!(
        "{}e{}",
        std::str::from_utf8(&other).expect("ASCII"),
        exponent - (k as i32 - 1)
    );
    if text.parse::<f64>() == Ok(magnitude) {
        shortest.copy_from_slice(&other);
    }
    exponent
}

fn into_text(bytes: Vec<u8>) -> String {
    String::from_utf8(bytes).expect("number text is ASCII")
}

fn push_exponent(out: &mut Vec<u8>, exponent: i32) {
    write!(out, "e{}{}", if exponent < 0 { '-' } else { '+' }, exponent.unsigned_abs()).expect("a vector takes every write");
}

/// `Number.prototype.toFixed(digits)`: the value with `digits` places after the point,
/// rounded to the nearest, a tie to the larger magnitude; `Number::toString` at or above
/// 10^21 and for a value that is not finite. Panics past 100 digits.
pub(crate) fn to_fixed(value: f64, digits: usize) -> String {
    assert!(digits <= MAX_FRACTION_DIGITS, "toFixed takes 0 to 100 digits, and was asked for {digits}");
    let (sign, magnitude) = sign_and_magnitude(value);
    if !value.is_finite() || magnitude >= 1e21 {
        // `Number::toString` of a value this large is its exponent form.
        return to_exponential(value, None);
    }
    let mut out = Vec::with_capacity(digits + 26);
    out.extend_from_slice(sign.as_bytes());
    let from = out.len();
    if let Some(n) = scaled_rounded(magnitude, digits as i32) {
        write!(out, "{n}").expect("a vector takes every write");
        let length = out.len() - from;
        if digits > 0 {
            if length <= digits {
                out.splice(from..from, std::iter::repeat(b'0').take(digits + 1 - length));
            }
            out.insert(out.len() - digits, b'.');
        }
        return into_text(out);
    }
    write!(out, "{magnitude:.width$}", width = digits + 1).expect("a vector takes every write");
    let last = out.pop().expect("one place more than asked for");
    let up = match last {
        b'5' => {
            #[cfg(test)]
            EXACT_EXPANSIONS.with(|count| count.set(count.get() + 1));
            let exact = format!("{magnitude:.1074}");
            exact.as_bytes()[out.len() - from] >= b'5'
        }
        last => last > b'5',
    };
    if up && increment(&mut out[from..]) {
        // `9.9` carried to `1.0`: the sum is one integer digit longer.
        out.insert(from + 1, b'0');
    }
    if digits == 0 {
        out.pop();
    }
    into_text(out)
}

/// `Number.prototype.toExponential(digits)`: one digit, a point and `digits` more, then the
/// exponent (`1.25e+3`); with no `digits`, as many as the value's shortest text needs.
/// Panics past 100 digits.
pub(crate) fn to_exponential(value: f64, digits: Option<usize>) -> String {
    if !value.is_finite() {
        return non_finite_text(value).into();
    }
    if let Some(digits) = digits {
        assert!(digits <= MAX_FRACTION_DIGITS, "toExponential takes 0 to 100 digits, and was asked for {digits}");
    }
    let (sign, magnitude) = sign_and_magnitude(value);
    let mut out = Vec::with_capacity(digits.unwrap_or(17) + 8);
    out.extend_from_slice(sign.as_bytes());
    let from = out.len();
    let exponent = match (magnitude == 0.0, digits) {
        (true, digits) => {
            out.resize(from + digits.unwrap_or(0) + 1, b'0');
            0
        }
        (false, Some(digits)) => significant_digits_into(&mut out, magnitude, digits + 1),
        (false, None) => shortest_digits_into(&mut out, magnitude),
    };
    if out.len() > from + 1 {
        out.insert(from + 1, b'.');
    }
    push_exponent(&mut out, exponent);
    into_text(out)
}

/// `Number.prototype.toPrecision(precision)`: `precision` significant digits, as a plain
/// decimal, or in exponent notation where the exponent is below -6 or not below the
/// precision. Panics outside 1 to 100.
pub(crate) fn to_precision(value: f64, precision: usize) -> String {
    if !value.is_finite() {
        return non_finite_text(value).into();
    }
    assert!(
        (1..=MAX_FRACTION_DIGITS).contains(&precision),
        "toPrecision takes 1 to 100 digits, and was asked for {precision}"
    );
    let (sign, magnitude) = sign_and_magnitude(value);
    let mut out = Vec::with_capacity(precision + 10);
    out.extend_from_slice(sign.as_bytes());
    let from = out.len();
    let exponent = if magnitude == 0.0 {
        out.resize(from + precision, b'0');
        0
    } else {
        significant_digits_into(&mut out, magnitude, precision)
    };
    let p = precision as i32;
    if magnitude != 0.0 && (exponent < -6 || exponent >= p) {
        if precision > 1 {
            out.insert(from + 1, b'.');
        }
        push_exponent(&mut out, exponent);
    } else if exponent >= 0 && exponent < p - 1 {
        out.insert(from + exponent as usize + 1, b'.');
    } else if exponent < 0 {
        let zeros = (-(exponent + 1)) as usize;
        out.splice(from..from, std::iter::once(b'0').chain(std::iter::once(b'.')).chain(std::iter::repeat(b'0').take(zeros)));
    }
    into_text(out)
}

fn non_finite_text(value: f64) -> &'static str {
    if value.is_nan() {
        "NaN"
    } else if value > 0.0 {
        "Infinity"
    } else {
        "-Infinity"
    }
}

/// `Math.round`: the integer nearest the value, a tie toward +∞, the negative zero kept for
/// a value from -0.5 to the negative zero — V8's ceiling-and-compare.
pub(crate) fn math_round(value: f64) -> f64 {
    let ceiling = value.ceil();
    if ceiling - 0.5 > value {
        ceiling - 1.0
    } else {
        ceiling
    }
}

/// `toString(radix)` of an integer-valued double in radix 2, 8 or 16: every digit exact,
/// lowercase, a minus before a negative value; `Number::toString` for a value that is not
/// finite. Panics on another radix or a value with a fraction.
pub(crate) fn radix_integer_text(value: f64, radix: u32) -> String {
    let bits_per_digit: u32 = match radix {
        2 => 1,
        8 => 3,
        16 => 4,
        other => panic!("radix text is written in radix 2, 8 or 16, and was asked for {other}"),
    };
    if !value.is_finite() {
        return non_finite_text(value).into();
    }
    assert!(value.fract() == 0.0, "radix text is written for an integer, and {value} is not one");
    let sign = if value < 0.0 { "-" } else { "" };
    let magnitude = value.abs();
    if magnitude < 18_446_744_073_709_551_616.0 {
        let whole = magnitude as u64;
        return match radix {
            2 => format!("{sign}{whole:b}"),
            8 => format!("{sign}{whole:o}"),
            _ => format!("{sign}{whole:x}"),
        };
    }
    // At or above 2^64 the value is its 53-bit mantissa followed by zero bits.
    let raw = magnitude.to_bits();
    let mantissa = (raw & ((1 << 52) - 1)) | (1 << 52);
    let shift = ((raw >> 52) as u32) - 1075;
    let width = 53 + shift;
    let digits = width.div_ceil(bits_per_digit);
    let bit = |at: u32| -> u32 {
        // Bit `at` counted from the least significant.
        if at < shift || at >= width {
            0
        } else {
            (mantissa >> (at - shift) & 1) as u32
        }
    };
    let mut out = String::with_capacity(sign.len() + digits as usize);
    out.push_str(sign);
    for digit in (0..digits).rev() {
        let value = (0..bits_per_digit).rev().fold(0, |held, b| held << 1 | bit(digit * bits_per_digit + b));
        out.push(char::from_digit(value, radix).expect("a digit of its radix"));
    }
    out
}

/// The decimal digits of a whole number at or above zero, as `Number::toString` writes one
/// below 10^21 and `toLocaleString("en")` writes one at or above it, its group separators
/// removed: every digit below 2^53, the shortest digits that read back as it followed by
/// zeros above; `∞` for an infinite value, as `toLocaleString` writes it. Recorded on V8 over
/// 1,670 values at or above 10^21, each answering so.
pub(crate) fn whole_number_digits(magnitude: f64) -> String {
    debug_assert!(magnitude >= 0.0 && magnitude.fract() == 0.0 || magnitude.is_infinite(), "a whole number");
    if magnitude.is_infinite() {
        return "∞".into();
    }
    if magnitude < EXACT_INTEGERS {
        return (magnitude as u64).to_string();
    }
    let mut out = Vec::with_capacity(24);
    let exponent = shortest_digits_into(&mut out, magnitude);
    out.resize(exponent as usize + 1, b'0');
    into_text(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fnv(text: &str) -> u64 {
        text.bytes().fold(0xcbf2_9ce4_8422_2325, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x100_0000_01b3))
    }

    fn bits_text(value: f64) -> String {
        format!("{:#018x}", value.to_bits())
    }

    /// Every answer the digest table covers, in its order.
    fn answers(value: f64) -> Vec<String> {
        let mut out: Vec<String> = (0..=100).map(|digits| to_fixed(value, digits)).collect();
        out.extend((0..=100).map(|digits| to_exponential(value, Some(digits))));
        out.push(to_exponential(value, None));
        out.extend((1..=100).map(|precision| to_precision(value, precision)));
        let rounded = math_round(value);
        out.push(bits_text(rounded));
        if rounded.is_finite() {
            out.extend([2, 8, 16].map(|radix| radix_integer_text(rounded, radix)));
        } else {
            out.extend([2, 8, 16].map(|_| non_finite_text(rounded).to_owned()));
        }
        if rounded.abs() >= 1e21 {
            out.push(whole_number_digits(rounded.abs()));
        }
        out
    }

    #[test]
    fn every_method_answers_as_v8_over_the_grid() {
        let mut wrong = Vec::new();
        for &(bits, digest) in NUMBER_DIGESTS {
            let value = f64::from_bits(bits);
            let written = answers(value);
            if fnv(&written.join("\n")) != digest {
                wrong.push(format!("{value:e} ({bits:#018x}): {written:?}"));
            }
        }
        assert!(wrong.is_empty(), "{} of {} values answer otherwise:\n{}", wrong.len(), NUMBER_DIGESTS.len(), wrong.join("\n"));
    }

    #[test]
    fn each_recorded_row_answers_as_v8() {
        for &(method, bits, argument, expected) in NUMBER_ROWS {
            let value = f64::from_bits(bits);
            let digits = usize::try_from(argument).ok();
            let answer = match method {
                "toFixed" => to_fixed(value, digits.expect("places")),
                "toExponential" => to_exponential(value, digits),
                "toPrecision" => to_precision(value, digits.expect("a precision")),
                "Math.round" => bits_text(math_round(value)),
                "toString" => radix_integer_text(value, argument as u32),
                "whole" => whole_number_digits(value),
                other => panic!("no method {other}"),
            };
            assert_eq!(answer, expected, "{method}({value:e}, {argument})");
        }
    }

    fn expansions_during(run: impl FnOnce()) -> u64 {
        let before = EXACT_EXPANSIONS.with(|count| count.get());
        run();
        EXACT_EXPANSIONS.with(|count| count.get()) - before
    }

    #[test]
    fn the_exact_expansion_is_computed_only_for_a_candidate_tie() {
        // Within 128 bits every rounding is decided exactly, and no expansion is made.
        assert_eq!(expansions_during(|| assert_eq!(to_fixed(2.5, 0), "3")), 0);
        assert_eq!(expansions_during(|| assert_eq!(to_precision(0.125, 2), "0.13")), 0);
        // Past 128 bits: a digit after the precision other than 5 decides alone.
        assert_eq!(expansions_during(|| assert_eq!(to_fixed(1e-30, 40), "0.0000000000000000000000000000010000000000")), 0);
        assert_eq!(expansions_during(|| assert_eq!(to_exponential(1e-300, Some(3)), "1.000e-300")), 0);
        // A 5 there is a candidate, settled on one expansion: here a tie, taken upward.
        let tie = 3.0 * 2f64.powi(-60);
        assert_eq!(expansions_during(|| assert_eq!(to_fixed(tie, 59), "0.00000000000000000260208521396521064161788672208786010742188")), 1);
        assert_eq!(expansions_during(|| assert_eq!(to_fixed(tie, 58), "0.0000000000000000026020852139652106416178867220878601074219")), 0);
        let tie = 2f64.powi(-100);
        assert_eq!(
            expansions_during(|| assert_eq!(
                to_exponential(tie, Some(68)),
                "7.88860905221011805411728565282786229673206435109023004770278930664063e-31"
            )),
            1
        );
        // The shortest digits: an odd last digit with no 5 after it needs none; two shortest
        // candidates equally near are settled on one, to the even digit.
        assert_eq!(expansions_during(|| assert_eq!(to_exponential(0.1, None), "1e-1")), 0);
        assert_eq!(expansions_during(|| assert_eq!(to_exponential(1.0 / 3.0, None), "3.333333333333333e-1")), 0);
        let between = f64::from_bits(0x4310000000000001);
        assert_eq!(expansions_during(|| assert_eq!(to_exponential(between, None), "1.1258999068426242e+15")), 1);
        // Where std's choice of the two is already the even one, nothing is expanded.
        let between = f64::from_bits(0x4310000000000003);
        assert_eq!(expansions_during(|| assert_eq!(to_exponential(between, None), "1.1258999068426248e+15")), 0);
    }

    #[test]
    fn an_argument_outside_a_methods_range_panics() {
        assert!(std::panic::catch_unwind(|| to_fixed(1.0, 101)).is_err());
        assert!(std::panic::catch_unwind(|| to_exponential(1.0, Some(101))).is_err());
        assert!(std::panic::catch_unwind(|| to_precision(1.0, 0)).is_err());
        assert!(std::panic::catch_unwind(|| radix_integer_text(1.5, 2)).is_err());
        assert!(std::panic::catch_unwind(|| radix_integer_text(1.0, 10)).is_err());
        // A value that is not finite answers before the range is judged, as V8's does.
        assert_eq!(to_exponential(f64::INFINITY, Some(101)), "Infinity");
        assert_eq!(to_precision(f64::NAN, 0), "NaN");
    }
    // Recorded by executing Number.prototype.toFixed, toExponential, toPrecision, toString(2|8|16) and Math.round under Node v24.21.0 (V8 13.6.233.17-node.53, ICU 78.3, tz 2026c),
    // against @telorun/cel 0.129.0 at 2ee5ef49.
    /// `(value's bits, digest)`: FNV-1a 64 over the UTF-8 of every answer joined by line feeds —
    /// `toFixed(0..=100)`, `toExponential(0..=100)`, `toExponential()`, `toPrecision(1..=100)`,
    /// `Math.round`'s bits as 0x-prefixed hex, `toString(2 | 8 | 16)` of that, and the separator-free
    /// `toLocaleString("en")` of its magnitude where it reaches 10^21. 392 values.
    const NUMBER_DIGESTS: &[(u64, u64)] = &[
        (0x3fe0000000000000, 0x3d27b59ceeb624a8), (0xbfe0000000000000, 0xb45bb020a20358e5), (0x3ff8000000000000, 0x463412527af58a26),
        (0xbff8000000000000, 0x92daf17a6db0c294), (0x40c81cc000000000, 0xdb0124934163a016), (0x4023000000000000, 0xcecf1ff812ec5a7e),
        (0x3fa999999999999a, 0xa720a4ab3e0b5136), (0xbfa999999999999a, 0xd5ffa3afaa81acb1), (0x3ff0cccccccccccd, 0x1184325c7f6b365d),
        (0xbff0cccccccccccd, 0xa86f313a1b3cadcc), (0x40c81c8666666666, 0x15ac76169e53275f), (0x3fdccccccccccccd, 0x6cabc599c63773bd),
        (0x4023e66666666666, 0xb07115f82d56a640), (0x3f747ae147ae147b, 0xdefec1406e22d720), (0xbf747ae147ae147b, 0x5e5631c0f118d0fd),
        (0x3ff0147ae147ae14, 0x4f7f2818aac399a4), (0xbff0147ae147ae14, 0x298cf984baa9ad57), (0x40c81c80a3d70a3d, 0xa4ed012f5cd44d89),
        (0x3fdc7ae147ae147b, 0xc33953abb24261bb), (0x4023fd70a3d70a3d, 0xfb6d1f27aa0a1d4c), (0x3f40624dd2f1a9fc, 0xb3945d95af400ba7),
        (0xbf40624dd2f1a9fc, 0x9fed3e4c191c7d1c), (0x3ff0020c49ba5e35, 0x7da6efff7cd8fda0), (0xbff0020c49ba5e35, 0xd6425872d65dc943),
        (0x40c81c8010624dd3, 0x5075f971829c1bd4), (0x3fdc72b020c49ba6, 0x3f2406bfcde4702b), (0x4023ffbe76c8b439, 0xa427f1fb7ddd6ab4),
        (0x3f0a36e2eb1c432d, 0x86cc143723602556), (0xbf0a36e2eb1c432d, 0xe46375dea4e71f79), (0x3ff000346dc5d639, 0x8f9a3b461b93cacc),
        (0xbff000346dc5d639, 0x88763bff5e94125b), (0x40c81c8001a36e2f, 0xe28521639fbf732e), (0x3fdc71de69ad42c4, 0xfd3460fc638bf8d3),
        (0x4023fff972474539, 0x245def640db35cf2), (0x3ed4f8b588e368f1, 0x3a6e6e0cafc6d4e0), (0xbed4f8b588e368f1, 0x9b92408f84cacd93),
        (0x3ff000053e2d6239, 0x1f4148d17af852aa), (0xbff000053e2d6239, 0x94b4951de42aa22d), (0x40c81c800029f16b, 0xfd2dd6700f238ca9),
        (0x3fdc71c970f7b9e0, 0xfd148dc16a048f2b), (0x4023ffff583a53b9, 0x719bd37f0adfd0d1), (0x3ea0c6f7a0b5ed8d, 0x63ba93262d4f526a),
        (0xbea0c6f7a0b5ed8d, 0xe9943cd2ac2b9443), (0x3ff000008637bd06, 0x8be4b19c4e035b90), (0xbff000008637bd06, 0xf1f3175385e15347),
        (0x40c81c80000431be, 0xef6f9eadb5c7ab74), (0x3fdc71c75818c5ca, 0xe9f22fd212d67d8d), (0x4023ffffef39085f, 0xe15018f4ebd507fe),
        (0x3e6ad7f29abcaf48, 0xb2c4de75dbe361a2), (0xbe6ad7f29abcaf48, 0xa8557e60a9afb2dd), (0x3ff000000d6bf94d, 0x07d0fa700765fcb0),
        (0xbff000000d6bf94d, 0xdf8381a55be32b75), (0x40c81c8000006b60, 0xc7777e3e40fec389), (0x3fdc71c72268e094, 0x31e03e64f7444879),
        (0x4023fffffe5280d6, 0x9ed3f0ca32bc3729), (0x3e35798ee2308c3a, 0xd4c3fef3e3af7d3d), (0xbe35798ee2308c3a, 0x0fb105c9b10e56c4),
        (0x3ff00000015798ee, 0xd826f4c03402f82d), (0xbff00000015798ee, 0xc21adecf67ffcdaa), (0x40c81c8000000abd, 0xac87ab44ada872e7),
        (0x3fdc71c71d0a7cdc, 0xef6850a20ab9700e), (0x4023ffffffd50ce2, 0x7eb2e27c31618b3b), (0x3e012e0be826d695, 0x1170fa4b943652e2),
        (0xbe012e0be826d695, 0x73cf1e00d1066269), (0x3ff0000000225c18, 0x5d8c0e726dfca0a5), (0xbff0000000225c18, 0xa947e0292ddb6a06),
        (0x40c81c8000000113, 0xf822eb44a8c18752), (0x3fdc71c71c810c7c, 0x877b7a07eeec43c9), (0x4023fffffffbb47d, 0xae7e20ebe0b56cf3),
        (0x3dcb7cdfd9d7bdbb, 0x6a8d5f8008a1ccb7), (0xbdcb7cdfd9d7bdbb, 0xd0de2726df192a38), (0x3ff0000000036f9c, 0xb9d08a233bcd322f),
        (0xbff0000000036f9c, 0x7fe4afd717b6cd4a), (0x40c81c800000001b, 0x52f65057e14c6556), (0x3fdc71c71c734e0c, 0x6703dcbdf4421109),
        (0x4023ffffffff920d, 0x1856544200ec8c18), (0x3d95fd7fe1796495, 0x4de2fa45003583f0), (0xbd95fd7fe1796495, 0x73796ecef0d70a37),
        (0x3ff00000000057f6, 0x7ebfb6a5541ce049), (0xbff00000000057f6, 0x7b854b2ef7180c2a), (0x40c81c8000000003, 0x12895848f8becad2),
        (0x3fdc71c71c71ee34, 0x90be6ee988079e88), (0x4023fffffffff501, 0x540ea19d90726f93), (0x3d619799812dea11, 0x8e840811961753c5),
        (0xbd619799812dea11, 0xf132e9bb1817738e), (0x3ff00000000008cc, 0x5f8444c90ae91bc1), (0xbff00000000008cc, 0x5143d84af3d61fb2),
        (0x40c81c8000000000, 0xd8524a4e07100223), (0x3fdc71c71c71cb05, 0x01ae0217378c7a89), (0x4023fffffffffee7, 0xaa6fb29c1448b2cf),
        (0x3d2c25c268497682, 0xc96443e314c59499), (0xbd2c25c268497682, 0x61555f185da6e74e), (0x3ff00000000000e1, 0xdc38b9102bc2c794),
        (0xbff00000000000e1, 0xaa08d11c56ed093b), (0x3fdc71c71c71c781, 0x48205beffcffef68), (0x4023ffffffffffe4, 0xa40623b87148ade4),
        (0x3cf6849b86a12b9b, 0x6565427f7b58be36), (0xbcf6849b86a12b9b, 0x0492b78c98b658bd), (0x3ff0000000000017, 0x66995b6076199be8),
        (0xbff0000000000017, 0xb9462fbbe7b66523), (0x3fdc71c71c71c726, 0xb49b6b564658eccd), (0x4023fffffffffffd, 0x334959e4a22532d8),
        (0x3cc203af9ee75616, 0xe8b108c75424ad6e), (0xbcc203af9ee75616, 0xd192c94039492b37), (0x3ff0000000000002, 0x79d9cf2286b95bcd),
        (0xbff0000000000002, 0xea3eaf4350f34ac8), (0x3fdc71c71c71c71d, 0xb58e4dc25f3fb7fe), (0x4024000000000000, 0xdc87075416859e3b),
        (0x3c8cd2b297d889bc, 0xf6358241df499662), (0xbc8cd2b297d889bc, 0x515dce1f1424e847), (0x3ff0000000000000, 0xa81113473753c292),
        (0xbff0000000000000, 0xa3485dd9bb02d82f), (0x3c570ef54646d497, 0x49f12010ea6dfae5), (0xbc570ef54646d497, 0x7a131226b4b9d030),
        (0x3fdc71c71c71c71c, 0x8d0fe5f54e6a0aa8), (0x3c22725dd1d243ac, 0x1fce377792e5110c), (0xbc22725dd1d243ac, 0xc7571ee38ccee979),
        (0x3bed83c94fb6d2ac, 0x37ab7addc5fe2cf0), (0xbbed83c94fb6d2ac, 0x2c017f39d50bd4bf), (0x3bb79ca10c924223, 0x66d33df9ec6cb836),
        (0xbbb79ca10c924223, 0x2dba9486bb27dc11), (0x3b82e3b40a0e9b4f, 0x86b97da4092d8414), (0xbb82e3b40a0e9b4f, 0xe5144bdec021948d),
        (0x3b4e392010175ee6, 0xe0fc7c137dfc6ca7), (0xbb4e392010175ee6, 0x5672046c6885dfca), (0x400c000000000000, 0x70079dcd72769559),
        (0x404ec00000000000, 0x9dc4028a5817d064), (0x3fd0000000000000, 0xbedf77b90460085f), (0xbfd0000000000000, 0x89ebb66c746ef086),
        (0x3fe8000000000000, 0x3e0b93e6fee9a90e), (0xbfe8000000000000, 0xcc2f1742b25b0c7f), (0x3ffc000000000000, 0xfee22a73606bc466),
        (0xbffc000000000000, 0x64463fdbe53ff673), (0x403ec00000000000, 0x554e09e8b23e1b77), (0xc03ec00000000000, 0x7e1df750aa4bc6d8),
        (0x3fc0000000000000, 0x3d5d2d835ae2af2e), (0x3fd8000000000000, 0x6079b8f9bca09d70), (0x3fec000000000000, 0x47d90ba178b58857),
        (0x402ec00000000000, 0xaf312b9150d5b8a2), (0x3fb0000000000000, 0xaf5e4a6aa53f32aa), (0xbfb0000000000000, 0xe8f648b8308040c3),
        (0x3fc8000000000000, 0xce132e38b4e4c2d3), (0xbfc8000000000000, 0x9cc7f5abd41c28cc), (0x3fdc000000000000, 0x88bcdd2e68d141ad),
        (0xbfdc000000000000, 0xae033a4717f23a02), (0x401ec00000000000, 0x322eb2efdcc8d167), (0xc01ec00000000000, 0x93358f73899d60ce),
        (0x3fa0000000000000, 0x159759831fb3201f), (0x3fb8000000000000, 0xd2584e448794cd58), (0x3fcc000000000000, 0x87cd6c6fe7511f94),
        (0x400ec00000000000, 0xd4a4a6ec64ffd842), (0x3f70000000000000, 0x442ee6980475b252), (0xbf70000000000000, 0x6379c793d5e031c3),
        (0x3f88000000000000, 0xd87a8157a102ac14), (0xbf88000000000000, 0x6ecfa80b8a3deef7), (0x3f9c000000000000, 0x59a7322d85c7a5f5),
        (0xbf9c000000000000, 0xd1497ddb14edc4d8), (0x3fdec00000000000, 0xd9161bcfe12f822b), (0xbfdec00000000000, 0x4297d2349786e4b8),
        (0x3f50000000000000, 0xc6d76f67004405f9), (0xbf50000000000000, 0xe6c137279491f848), (0x3f68000000000000, 0xdc4e6cb13dffd7dd),
        (0xbf68000000000000, 0x9050aa8fb04ceeee), (0x3f7c000000000000, 0xc0ac2874b3df27e0), (0xbf7c000000000000, 0x3a7d45c3a603a9fb),
        (0x3fbec00000000000, 0x821d420a00dce12e), (0xbfbec00000000000, 0xccfb2a86ac57c67f), (0x3ef0000000000000, 0x65fe090a42a6c7cc),
        (0xbef0000000000000, 0x2d219c934692bb7f), (0x3f08000000000000, 0x113e66303b7cfe5f), (0xbf08000000000000, 0x4959cc83e99f8bba),
        (0x3f1c000000000000, 0x9beec78c58d1f972), (0xbf1c000000000000, 0x4c0b1b39976bc985), (0x3f5ec00000000000, 0xdc9f34a37ecba262),
        (0xbf5ec00000000000, 0xb0ed09694ed3f435), (0x3eb0000000000000, 0xb7955af7eb4aa25a), (0xbeb0000000000000, 0x858de710e2b386ef),
        (0x3ec8000000000000, 0x36aeed4e6999e915), (0xbec8000000000000, 0x9a49a229738e1e18), (0x3edc000000000000, 0x00c99fc955bd85a4),
        (0xbedc000000000000, 0xd0a05914f82bb5b7), (0x3f1ec00000000000, 0x88a58f8f6c6ee3ef), (0xbf1ec00000000000, 0xf39ad0884367bcae),
        (0x3e70000000000000, 0xbaab2939ac4753d1), (0xbe70000000000000, 0x0914ee535ac13684), (0x3e88000000000000, 0xdc33b75aded2392c),
        (0xbe88000000000000, 0x0d0a11e1471213bb), (0x3e9c000000000000, 0xb3d5e7b18b4023f4), (0xbe9c000000000000, 0x0a627758a91206e5),
        (0x3edec00000000000, 0x9f934c0d1d805f1b), (0xbedec00000000000, 0x71be90153d3f5896), (0x3e10000000000000, 0x1d771af851a514c9),
        (0xbe10000000000000, 0xec1da2fd67ce4ed0), (0x3e28000000000000, 0x81b537eebe21fc44), (0xbe28000000000000, 0xe3ccd5ee3278de6f),
        (0x3e3c000000000000, 0x4a44fdfd4b159670), (0xbe3c000000000000, 0x5818d83e9d56e637), (0x3e7ec00000000000, 0x4b10fdf4a1ece199),
        (0xbe7ec00000000000, 0x25422b13f03e79f6), (0x3d70000000000000, 0x47a1ed36141fa834), (0xbd70000000000000, 0xca419dee8d9b7e87),
        (0x3d88000000000000, 0x297dee62976c2107), (0xbd88000000000000, 0x33d4fdba826d575e), (0x3d9c000000000000, 0x3af10c95895e5eca),
        (0xbd9c000000000000, 0x9337b216f5c1296d), (0x3ddec00000000000, 0x4b78d51ccb1c6598), (0xbddec00000000000, 0x0f6db3956e884c45),
        (0x3cd0000000000000, 0x5d2748d9190d21db), (0xbcd0000000000000, 0x75acb8ec0083d4fc), (0x3ce8000000000000, 0x436472a9d886b62b),
        (0xbce8000000000000, 0x09ebdc7240b882b6), (0x3cfc000000000000, 0x89f3d8513add704f), (0xbcfc000000000000, 0x5f2349317b4bb14a),
        (0x3d3ec00000000000, 0xdab70a4692809c37), (0xbd3ec00000000000, 0x98d567ca34f15a10), (0x3ca0000000000000, 0xf17e98195e7fc78e),
        (0x3cb8000000000000, 0xaa5d1cf683d6be91), (0x3ccc000000000000, 0x9110ee061f08f4b6), (0x3d0ec00000000000, 0x40c42d6325327735),
        (0x3c30000000000000, 0xeaca691617d04bb2), (0xbc30000000000000, 0x7ff61142b3b20a0b), (0x3c48000000000000, 0x90d890fc00fd8472),
        (0xbc48000000000000, 0x83951287bf803347), (0x3c5c000000000000, 0x6e650501c5de21e6), (0xbc5c000000000000, 0xa8cdd511a0429a9f),
        (0x3c9ec00000000000, 0xf83c5eeea9c1d451), (0xbc9ec00000000000, 0xe9990462df2c555a), (0x39b4484bfeebc2a0, 0xff4fdea270bc8c23),
        (0x39b4484bfeebc2a1, 0xd146deb8df0df4ea), (0x39b4484bfeebc29f, 0xcef6778fe4be2b16), (0x39c95a5efea6b348, 0x9fbd71f33734cd40),
        (0x3a53ce9a36f23c10, 0x8917ac71e0dec3ee), (0x3a53ce9a36f23c11, 0xbdaf58cb8118f397), (0x3a53ce9a36f23c0f, 0xc7567d68e9363aa0),
        (0x3a68c240c4aecb14, 0x9fd62ea38507037c), (0x3af357c299a88ea7, 0xbd5d5eadb6861bcd), (0x3af357c299a88ea8, 0xb21e1333920733ae),
        (0x3af357c299a88ea6, 0xf50e4b8d77ca607b), (0x3b082db34012b251, 0x78cf7ae9ceb8b325), (0x3b92e3b40a0e9b4f, 0xbf08526aa6ff0ada),
        (0x3b92e3b40a0e9b50, 0xcfc1f4bf7e69a46e), (0x3b92e3b40a0e9b4e, 0xb5d8f295c6108cc5), (0x3ba79ca10c924223, 0xa2bc54c725ab39ba),
        (0x3c32725dd1d243ac, 0xd7ffaacb96ab16ae), (0x3c32725dd1d243ad, 0xccde401f3f640764), (0x3c32725dd1d243ab, 0x5c6f371f5e40b454),
        (0x3c470ef54646d497, 0x3adf157600371aa4), (0x3cd203af9ee75616, 0xd60a14a37ae7b188), (0x3cd203af9ee75617, 0xc41c18b676d4e2f4),
        (0x3cd203af9ee75615, 0x52ed84d0cca46ca8), (0x3ce6849b86a12b9c, 0x74526f3389620357), (0x3d719799812dea11, 0xf9e7531cf99afada),
        (0x3d719799812dea12, 0x5b9fba6bc2733dd4), (0x3d719799812dea10, 0x5f79414eacc29059), (0x3d85fd7fe1796495, 0x61e9890d142697ec),
        (0x3e112e0be826d695, 0x1e32514c96ea5234), (0x3e112e0be826d696, 0xadc3f3e18475b1f3), (0x3e112e0be826d694, 0xafb4aa983530a571),
        (0x3e25798ee2308c3a, 0xcc80a5ecb2a01047), (0x3eb0c6f7a0b5ed8d, 0x57ad8c2fedf5a39e), (0x3eb0c6f7a0b5ed8e, 0x0a657e0d04faa718),
        (0x3eb0c6f7a0b5ed8c, 0x197f4236173d6b1a), (0x3ec4f8b588e368f0, 0xd0d0ee3e6ec1cd41), (0x3f50624dd2f1a9fc, 0x6804e2fa3cba84f4),
        (0x3f50624dd2f1a9fd, 0x914314e5130b8b77), (0x3f50624dd2f1a9fb, 0xc1efc40303aa45a2), (0x3f647ae147ae147b, 0x6aba6b40f29d36c8),
        (0x3ff0000000000001, 0x367b2bac1ebab5a8), (0x3fefffffffffffff, 0x5c2e8c480dede31f), (0x4004000000000000, 0x128a768625a1056c),
        (0x408f400000000000, 0x1f44c7f814d8235a), (0x408f400000000001, 0x64ddcb109ad8cb30), (0x408f3fffffffffff, 0xe9a882b1f80a4974),
        (0x40a3880000000000, 0x2e6442e79478bbf9), (0x412e848000000000, 0x84a31e690bd6f9f2), (0x412e848000000001, 0x6ac8f02ff1ef8945),
        (0x412e847fffffffff, 0x498b989f8aa398ab), (0x414312d000000000, 0x3e087a7e11fcb12f), (0x41cdcd6500000000, 0x146cfbe06efab353),
        (0x41cdcd6500000001, 0xc1866ef7b60a91a3), (0x41cdcd64ffffffff, 0x2895749e4bb6f722), (0x41e2a05f20000000, 0xbbb846903f696146),
        (0x426d1a94a2000000, 0x70a98eb06a0994f4), (0x426d1a94a2000001, 0xb77d2f3aa0d4740d), (0x426d1a94a1ffffff, 0x5b669f9e60efd43f),
        (0x4282309ce5400000, 0x5dbe02c5557e3194), (0x430c6bf526340000, 0x2776827a92101567), (0x430c6bf526340001, 0x3dd1a6c373af7727),
        (0x430c6bf52633ffff, 0x52bbc9f6e2b4bf00), (0x4321c37937e08000, 0x3b8ddc284c541322), (0x43abc16d674ec800, 0x720f574d3fb8ba26),
        (0x43abc16d674ec801, 0x769e6b15ddba44ed), (0x43abc16d674ec7ff, 0xc095a607d4150a5d), (0x43c158e460913d00, 0x23b20d9b6c94cfc1),
        (0x444b1ae4d6e2ef50, 0x1bd5c40ba00a7f26), (0x444b1ae4d6e2ef51, 0x2997fdd6affd712b), (0x444b1ae4d6e2ef4f, 0x64c2a89fd56022bf),
        (0x4460f0cf064dd592, 0x46d3a08052398b7a), (0x44ea784379d99db4, 0x3db4b3a0163f3f74), (0x44ea784379d99db5, 0x8c95452cb4a2b028),
        (0x44ea784379d99db3, 0x0ef51113959959f9), (0x45008b2a2c280290, 0x63d145f15e941542), (0x4589d971e4fe8402, 0x8d0647adba078030),
        (0x4589d971e4fe8403, 0x66b8526ac77289ae), (0x4589d971e4fe8401, 0xd2fd3d2158547bfc), (0x45a027e72f1f1281, 0x51588a40e570ccca),
        (0x46293e5939a08cea, 0x153c10fba703d898), (0x46293e5939a08ceb, 0x80f0c16d0734566e), (0x46293e5939a08ce9, 0x091181b021169c66),
        (0x463f8def8808b024, 0x7162689cd1abfd44), (0x0000000000000001, 0xfe33c5a37db46db1), (0x8000000000000001, 0x3c14f69f0c658cbc),
        (0x0000000000000002, 0x5472606397100809), (0x8000000000000002, 0x16953f6d6dfa9a2e), (0x000fffffffffffff, 0xc1f1af7102251099),
        (0x800fffffffffffff, 0xeb556ca700106984), (0x0010000000000000, 0xda6029a7650a66e5), (0x8010000000000000, 0x3b35e4c4b3fcbfae),
        (0x000012688b70e62b, 0xfe438a956549482e), (0x800012688b70e62b, 0x88b6c5e2e1160f2f), (0xc44b1ae4d6e2ef50, 0x7d042f5b6e77da47),
        (0xc44b1ae4d6e2ef4f, 0xf41c88e67f21d0a0), (0xc44b1ae4d6e2ef51, 0x61097a6d3eabab48), (0x4415af1d78b58c40, 0x113f23b448091639),
        (0xc415af1d78b58c40, 0x85c8d07b31b9ea38), (0x7fefffffffffffff, 0x883b54326c054ac3), (0xffefffffffffffff, 0x7992000312798320),
        (0x4340000000000000, 0xdf875463ba24f71c), (0xc340000000000000, 0x4ec4df8ac8d5b74f), (0x4340000000000001, 0xbdbe5cec739c9b5a),
        (0xc340000000000001, 0x6846265bca065abb), (0x433fffffffffffff, 0x64c9eac25e4164fd), (0xc33fffffffffffff, 0xa757d6298a487c9e),
        (0x4330000000000000, 0x5590ad4059b76c42), (0xc330000000000000, 0xfa2c7086efb824e9), (0x432fffffffffffff, 0x7a9665cd9a8bed0e),
        (0xc32fffffffffffff, 0x5a17a10278c162e7), (0x43f0000000000000, 0x1819cca8acf82046), (0xc3f0000000000000, 0x2ea4116764daa107),
        (0x4450000000000004, 0x7c7ba1d4ff6d6a4f), (0xc450000000000004, 0x95f749e48801406a), (0x7e37e43c8800759c, 0x18cb9162cd5c8f8e),
        (0xfe37e43c8800759c, 0xae55fe02f78eee35), (0x3fb999999999999a, 0x8029d119a0a58a2d), (0xbfb999999999999a, 0x0b26ecede6020744),
        (0x3fd3333333333333, 0x73db5b653b9f83b6), (0xbfd3333333333333, 0xdde4f830e24ac53b), (0x3ff0b851eb851eb8, 0x0fa38a5a09c7b065),
        (0xbff0b851eb851eb8, 0xd32ae71655d80d92), (0x3ff4147ae147ae14, 0x5afb279aa331ca4e), (0xbff4147ae147ae14, 0xd9cb08be6b75412f),
        (0x4020b0a3d70a3d71, 0x88f4c829ce8edda9), (0xc020b0a3d70a3d71, 0x5d1308f2a32cbfe2), (0x3ff7333333333333, 0xb85d674756982979),
        (0xbff7333333333333, 0x0e912df4c6b86ee6), (0x4005666666666666, 0x2a13d330935cb9ab), (0xc005666666666666, 0xc80881ae5e35763e),
        (0x40247851eb851eb8, 0xd0cbb38e7093f43c), (0xc0247851eb851eb8, 0xcc97ab628ab39f65), (0x405edd2f1a9fbe77, 0x7cf38c2feced0d8e),
        (0xc05edd2f1a9fbe77, 0x50e4b04606b72af5), (0x3e7ad7f29abcaf48, 0xc45899ff8ac8b4f8), (0xbe7ad7f29abcaf48, 0x4763793b62e904ab),
        (0x3ff4000000000000, 0x3050604fd0f95ccc), (0xbff4000000000000, 0xa9c63079b0b76fb5), (0x3ff599999999999a, 0x9d597f7a7671bcc2),
        (0xbff599999999999a, 0xc47881bc8fb91115), (0xbfc0000000000000, 0x26785e4154b89f59), (0xbfd8000000000000, 0x49b9299c17afd161),
        (0x4058ffae147ae148, 0xc3874c57ecf1f33e), (0xc058ffae147ae148, 0x2059dae0402ee3cd), (0xc023fd70a3d70a3d, 0xf4959ea16a145f25),
        (0x3fdfffffffffffff, 0x08e7493829456f91), (0xbfdfffffffffffff, 0xf70967e05d0e14f8), (0x3fd5555555555555, 0x250ddbde266bb0f5),
        (0xbfd5555555555555, 0xd9e76f2ba19bceba), (0x400921fb54442d18, 0xce3e32f095cb7db0), (0xc00921fb54442d18, 0xc52d7669a3ec5575),
        (0xb9b4484bfeebc29f, 0xabc329980d0c1a57), (0x39e95a5efea6b347, 0x05271c230d31ced0), (0xb9e95a5efea6b347, 0xabe2c1bc4f116005),
        (0x4310000000000001, 0xd6e607d4f9b3afbb), (0xc310000000000001, 0x19ef4ac52653a8a0), (0x4310000000000003, 0xa131c3f2d3410968),
        (0xc310000000000003, 0x5a6037fc7127b8cf), (0x4320000000000001, 0x12b89d041328b4de), (0xc320000000000001, 0xc0b0d5979a0809f4),
        (0x0000000000000000, 0x69c136a3df59e331), (0x8000000000000000, 0xf225aa3f132591e9), (0x7ff8000000000000, 0x2eccc5c093ef59e0),
        (0x7ff0000000000000, 0x34e2b847f10065b2), (0xfff0000000000000, 0x07b3ecaa3022e9db),
    ];
    /// `(method, value's bits, argument — -1 for none, the radix for `toString` —, answer)`;
    /// `Math.round` answers its bits, and `whole` is `toString()` below 10^21 and the
    /// separator-free `toLocaleString("en")` at or above it.
    const NUMBER_ROWS: &[(&str, u64, i64, &str)] = &[
        ("toFixed", 0x3fe0000000000000, 0, "1"),
        ("toFixed", 0x3ff8000000000000, 0, "2"),
        ("toFixed", 0x4004000000000000, 0, "3"),
        ("toFixed", 0xc004000000000000, 0, "-3"),
        ("toFixed", 0x3fc0000000000000, 2, "0.13"),
        ("toFixed", 0x3fd8000000000000, 2, "0.38"),
        ("toFixed", 0xbfc0000000000000, 2, "-0.13"),
        ("toFixed", 0x3ff0147ae147ae14, 2, "1.00"),
        ("toFixed", 0x3ff0b851eb851eb8, 2, "1.04"),
        ("toFixed", 0x4020b0a3d70a3d71, 2, "8.35"),
        ("toFixed", 0x4005666666666666, 2, "2.67"),
        ("toFixed", 0x3fa999999999999a, 1, "0.1"),
        ("toFixed", 0x3f747ae147ae147b, 2, "0.01"),
        ("toFixed", 0x40c81cc000000000, 0, "12346"),
        ("toFixed", 0x4023fd70a3d70a3d, 2, "9.99"),
        ("toFixed", 0x4058ffae147ae148, 2, "100.00"),
        ("toFixed", 0x8000000000000000, 2, "0.00"),
        ("toFixed", 0xbf1a36e2eb1c432d, 2, "-0.00"),
        ("toFixed", 0xbfe0000000000000, 0, "-1"),
        ("toFixed", 0x3fdfffffffffffff, 0, "0"),
        ("toFixed", 0x0000000000000001, 100, "0.0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"),
        ("toFixed", 0x3e7ad7f29abcaf48, 10, "0.0000001000"),
        ("toFixed", 0x4415af1d78b58c40, 2, "100000000000000000000.00"),
        ("toFixed", 0x444b1ae4d6e2ef4f, 2, "999999999999999868928.00"),
        ("toFixed", 0x444b1ae4d6e2ef50, 2, "1e+21"),
        ("toFixed", 0xc44b1ae4d6e2ef50, 0, "-1e+21"),
        ("toFixed", 0x7fefffffffffffff, 0, "1.7976931348623157e+308"),
        ("toFixed", 0x405edd2f1a9fbe77, 100, "123.4560000000000030695446184836328029632568359375000000000000000000000000000000000000000000000000000000"),
        ("toFixed", 0x7ff8000000000000, 2, "NaN"),
        ("toFixed", 0x7ff0000000000000, 2, "Infinity"),
        ("toFixed", 0xfff0000000000000, 5, "-Infinity"),
        ("toFixed", 0x432fffffffffffff, 0, "4503599627370496"),
        ("toFixed", 0x4330000000000000, 0, "4503599627370496"),
        ("toFixed", 0x3fb999999999999a, 20, "0.10000000000000000555"),
        ("toFixed", 0x3fb999999999999a, 30, "0.100000000000000005551115123126"),
        ("toFixed", 0x3ff7333333333333, 1, "1.4"),
        ("toExponential", 0x3ff4000000000000, 1, "1.3e+0"),
        ("toExponential", 0x3ff599999999999a, 1, "1.4e+0"),
        ("toExponential", 0x3fc0000000000000, 1, "1.3e-1"),
        ("toExponential", 0xbfc0000000000000, 1, "-1.3e-1"),
        ("toExponential", 0x4023fd70a3d70a3d, 2, "9.99e+0"),
        ("toExponential", 0x4023000000000000, 0, "1e+1"),
        ("toExponential", 0x0000000000000000, 3, "0.000e+0"),
        ("toExponential", 0x8000000000000000, 0, "0e+0"),
        ("toExponential", 0x0000000000000001, 2, "4.94e-324"),
        ("toExponential", 0x0000000000000001, 100, "4.9406564584124654417656879286822137236505980261432476442558568250067550727020875186529983636163599238e-324"),
        ("toExponential", 0x7fefffffffffffff, 20, "1.79769313486231570815e+308"),
        ("toExponential", 0x444b1ae4d6e2ef50, 0, "1e+21"),
        ("toExponential", 0x40fe240000000000, 2, "1.23e+5"),
        ("toExponential", 0x3e7ad7f29abcaf48, 0, "1e-7"),
        ("toExponential", 0x39b4484bfeebc29f, 15, "9.999999999999999e-31"),
        ("toExponential", 0x39e95a5efea6b347, 15, "9.999999999999999e-30"),
        ("toExponential", 0x3efa36e2eb1c432d, 0, "3e-5"),
        ("toExponential", 0x7ff8000000000000, 1, "NaN"),
        ("toExponential", 0xfff0000000000000, 1, "-Infinity"),
        ("toExponential", 0x0000000000000000, -1, "0e+0"),
        ("toExponential", 0x8000000000000000, -1, "0e+0"),
        ("toExponential", 0x3ff0000000000000, -1, "1e+0"),
        ("toExponential", 0x3fb999999999999a, -1, "1e-1"),
        ("toExponential", 0x3fd5555555555555, -1, "3.333333333333333e-1"),
        ("toExponential", 0x0000000000000001, -1, "5e-324"),
        ("toExponential", 0x7fefffffffffffff, -1, "1.7976931348623157e+308"),
        ("toExponential", 0x444b1ae4d6e2ef50, -1, "1e+21"),
        ("toExponential", 0x3c36b082c2148b8e, -1, "1.23e-18"),
        ("toExponential", 0x4340000000000000, -1, "9.007199254740992e+15"),
        ("toExponential", 0x4340000000000000, -1, "9.007199254740992e+15"),
        ("toExponential", 0x3eb0c6f7a0b5ed8d, -1, "1e-6"),
        ("toExponential", 0x3e7ad7f29abcaf48, -1, "1e-7"),
        ("toExponential", 0x4310000000000001, -1, "1.1258999068426242e+15"),
        ("toExponential", 0x4310000000000003, -1, "1.1258999068426248e+15"),
        ("toExponential", 0x4320000000000001, -1, "2.2517998136852485e+15"),
        ("toPrecision", 0x3fc0000000000000, 2, "0.13"),
        ("toPrecision", 0x3fd8000000000000, 2, "0.38"),
        ("toPrecision", 0x3ff4000000000000, 2, "1.3"),
        ("toPrecision", 0x4004000000000000, 1, "3"),
        ("toPrecision", 0x4023000000000000, 1, "1e+1"),
        ("toPrecision", 0x4058e00000000000, 2, "1.0e+2"),
        ("toPrecision", 0x0000000000000000, 1, "0"),
        ("toPrecision", 0x0000000000000000, 5, "0.0000"),
        ("toPrecision", 0x8000000000000000, 3, "0.00"),
        ("toPrecision", 0x444b1ae4d6e2ef50, 21, "1.00000000000000000000e+21"),
        ("toPrecision", 0x444b1ae4d6e2ef50, 22, "1000000000000000000000"),
        ("toPrecision", 0x40fe240000000000, 3, "1.23e+5"),
        ("toPrecision", 0x40fe240000000000, 6, "123456"),
        ("toPrecision", 0x3eb0c6f7a0b5ed8d, 2, "0.0000010"),
        ("toPrecision", 0x3e7ad7f29abcaf48, 2, "1.0e-7"),
        ("toPrecision", 0x3eb4a2cf4d5aa6c0, 3, "0.00000123"),
        ("toPrecision", 0x0000000000000001, 100, "4.940656458412465441765687928682213723650598026143247644255856825006755072702087518652998363616359924e-324"),
        ("toPrecision", 0x7fefffffffffffff, 100, "1.797693134862315708145274237317043567980705675258449965989174768031572607800285387605895586327668782e+308"),
        ("toPrecision", 0x39e95a5efea6b347, 16, "9.999999999999999e-30"),
        ("toPrecision", 0x39b4484bfeebc29f, 16, "9.999999999999999e-31"),
        ("toPrecision", 0x40c81cc000000000, 5, "12346"),
        ("toPrecision", 0xc0c81cc000000000, 5, "-12346"),
        ("toPrecision", 0x7ff8000000000000, 3, "NaN"),
        ("toPrecision", 0x7ff0000000000000, 3, "Infinity"),
        ("Math.round", 0x0000000000000000, -1, "0x0000000000000000"),
        ("Math.round", 0x8000000000000000, -1, "0x8000000000000000"),
        ("Math.round", 0x3fd999999999999a, -1, "0x0000000000000000"),
        ("Math.round", 0xbfd999999999999a, -1, "0x8000000000000000"),
        ("Math.round", 0x3fe0000000000000, -1, "0x3ff0000000000000"),
        ("Math.round", 0xbfe0000000000000, -1, "0x8000000000000000"),
        ("Math.round", 0x3fdfffffffffffff, -1, "0x0000000000000000"),
        ("Math.round", 0xbfdfffffffffffff, -1, "0x8000000000000000"),
        ("Math.round", 0x3ff8000000000000, -1, "0x4000000000000000"),
        ("Math.round", 0x4004000000000000, -1, "0x4008000000000000"),
        ("Math.round", 0xbff8000000000000, -1, "0xbff0000000000000"),
        ("Math.round", 0xc004000000000000, -1, "0xc000000000000000"),
        ("Math.round", 0x432fffffffffffff, -1, "0x4330000000000000"),
        ("Math.round", 0xc32fffffffffffff, -1, "0xc32ffffffffffffe"),
        ("Math.round", 0x4330000000000001, -1, "0x4330000000000001"),
        ("Math.round", 0x7e37e43c8800759c, -1, "0x7e37e43c8800759c"),
        ("Math.round", 0x81a56e1fc2f8f359, -1, "0x8000000000000000"),
        ("Math.round", 0x7ff8000000000000, -1, "0x7ff8000000000000"),
        ("Math.round", 0x7ff0000000000000, -1, "0x7ff0000000000000"),
        ("Math.round", 0xfff0000000000000, -1, "0xfff0000000000000"),
        ("toString", 0x0000000000000000, 2, "0"),
        ("toString", 0x8000000000000000, 16, "0"),
        ("toString", 0x406fe00000000000, 16, "ff"),
        ("toString", 0xc06fe00000000000, 2, "-11111111"),
        ("toString", 0x406fe00000000000, 8, "377"),
        ("toString", 0x4340000000000000, 2, "100000000000000000000000000000000000000000000000000000"),
        ("toString", 0x43f0000000000000, 16, "10000000000000000"),
        ("toString", 0x4450000000000004, 16, "400000000000100000"),
        ("toString", 0x4450000000000004, 8, "200000000000000004000000"),
        ("toString", 0x4450000000000004, 2, "10000000000000000000000000000000000000000000000000100000000000000000000"),
        ("toString", 0x7fefffffffffffff, 16, "fffffffffffff800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"),
        ("toString", 0xffefffffffffffff, 8, "-177777777777777777400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"),
        ("toString", 0x444b1ae4d6e2ef50, 16, "3635c9adc5dea00000"),
        ("toString", 0x7ff0000000000000, 2, "Infinity"),
        ("toString", 0xfff0000000000000, 16, "-Infinity"),
        ("toString", 0x7ff8000000000000, 8, "NaN"),
        ("whole", 0x0000000000000000, -1, "0"),
        ("whole", 0x401c000000000000, -1, "7"),
        ("whole", 0x433fffffffffffff, -1, "9007199254740991"),
        ("whole", 0x4340000000000000, -1, "9007199254740992"),
        ("whole", 0x4340000000000001, -1, "9007199254740994"),
        ("whole", 0x4415af1d78b58c40, -1, "100000000000000000000"),
        ("whole", 0x4450000000000000, -1, "1180591620717411300000"),
        ("whole", 0x444b1ae4d6e2ef50, -1, "1000000000000000000000"),
        ("whole", 0x4454542ba12a337c, -1, "1500000000000000000000"),
        ("whole", 0x44ef400000000000, -1, "1180591620717411300000000"),
        ("whole", 0x45246c993044fd55, -1, "12345678901234568000000000"),
        ("whole", 0x7e37e43c8800759c, -1, "1000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"),
        ("whole", 0x7fefffffffffffff, -1, "179769313486231570000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"),
        ("whole", 0x7ff0000000000000, -1, "\u{221e}"),
    ];
}
