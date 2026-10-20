//! Text: how a value is written as a string, and how text becomes bytes —
//! `value-text.ts`.
//!
//! Declared here and not in the Node file, which calls its host for both:
//! - `es_number` — ECMAScript's `Number::toString`, the digits `double_text` writes.
//! - `json_quote` — a string as `JSON.stringify` quotes one, which every refusal that
//!   names text quotes it with.
//! - `is_es_whitespace` and `es_trim` — the characters ECMAScript's `\s` and
//!   `String.prototype.trim` take as whitespace, one set for both.
//! - `compare_code_units` — the order ECMAScript sorts and compares strings in.
//! - `es_string_to_number` — ECMAScript's `StringToNumber`, what `Number(text)` answers.
//!
//! ECMAScript's casing, which Node also takes from its host, reads the engine's Unicode
//! data and lives in the engine crate's `value_text.rs`.

use std::cmp::Ordering;

use crate::cel_value::{cel_error, CelError, CelEvaluationCode};

/// The UTF-8 bytes of text.
pub fn text_to_bytes(text: &str) -> Vec<u8> {
    text.as_bytes().to_vec()
}

/// The text bytes hold. Bytes that are not UTF-8 are a conversion error rather than
/// text with a replacement character in it. One leading byte order mark is not part of
/// the text, as the decoder every engine answers with reads it.
pub fn bytes_to_text(bytes: &[u8]) -> Result<String, CelError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| cel_error(CelEvaluationCode::InvalidConversion, "the bytes are not UTF-8 text", None))?;
    Ok(text.strip_prefix('\u{feff}').unwrap_or(text).to_string())
}

/// A double as text: the shortest digits that read back as the same double, with the
/// non-finite doubles and the negative zero named as cel-spec writes them.
pub fn double_text(value: f64) -> String {
    if value.is_nan() {
        "NaN".into()
    } else if value == f64::INFINITY {
        "+Inf".into()
    } else if value == f64::NEG_INFINITY {
        "-Inf".into()
    } else if value == 0.0 && value.is_sign_negative() {
        "-0".into()
    } else {
        es_number(value)
    }
}

/// A double as ECMAScript's `Number::toString` writes it: the shortest digits that
/// read back as it, as a plain decimal from 1e-6 up to 1e21 and in exponent notation
/// outside. Either zero is `0`.
pub fn es_number(value: f64) -> String {
    if value.is_nan() {
        return "NaN".into();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if value == 0.0 {
        return "0".into();
    }
    let sign = if value < 0.0 { "-" } else { "" };
    let (digits, exponent) = shortest_digits(value.abs());
    let k = digits.len() as i32;
    let n = exponent + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let e_sign = if e < 0 { "-" } else { "+" };
        if k == 1 {
            format!("{digits}e{e_sign}{}", e.abs())
        } else {
            format!("{}.{}e{e_sign}{}", &digits[..1], &digits[1..], e.abs())
        }
    };
    format!("{sign}{body}")
}

/// The significant digits and decimal exponent `Number::toString` chooses for a finite
/// positive double: the fewest digits that read back as it, and — where two candidates
/// of that length read back and lie equally close to it — the one ending in an even
/// digit. `{:e}` finds the fewest digits but settles that tie upward, so a tie is
/// detected on the exact expansion and settled here.
fn shortest_digits(magnitude: f64) -> (String, i32) {
    let split = |text: &str| -> (Vec<u8>, i32) {
        let (mantissa, exponent) = text.split_once('e').expect("scientific notation has an exponent");
        (mantissa.bytes().filter(|b| *b != b'.').collect(), exponent.parse().expect("exponent is an integer"))
    };
    let (shortest, exponent) = split(&format!("{magnitude:e}"));
    let as_string = |digits: &[u8]| String::from_utf8(digits.to_vec()).expect("decimal digits are ASCII");
    // 767 significant digits hold the exact value of any double.
    let (exact, exact_exponent) = split(&format!("{magnitude:.766e}"));
    let k = shortest.len();
    let tie =
        exact_exponent == exponent && exact.len() > k && exact[k] == b'5' && exact[k + 1..].iter().all(|d| *d == b'0');
    if !tie || shortest[k - 1] % 2 == 0 {
        return (as_string(&shortest), exponent);
    }
    // The other candidate of the same length, on the far side of the value.
    let truncated = &exact[..k];
    let other = if shortest.as_slice() == truncated {
        let mut up = truncated.to_vec();
        let mut at = k;
        loop {
            if at == 0 {
                // A carry past the first digit leaves no candidate of this length.
                return (as_string(&shortest), exponent);
            }
            at -= 1;
            if up[at] == b'9' {
                up[at] = b'0';
            } else {
                up[at] += 1;
                break;
            }
        }
        up
    } else {
        truncated.to_vec()
    };
    let text = format!("{}e{}", as_string(&other), exponent - (k as i32 - 1));
    if text.parse::<f64>() == Ok(magnitude) {
        (as_string(&other), exponent)
    } else {
        (as_string(&shortest), exponent)
    }
}

/// A string as `JSON.stringify` quotes one.
pub fn json_quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Whether ECMAScript reads a character as whitespace — its `WhiteSpace` and
/// `LineTerminator` sets together, which is what `\s` matches and what `trim` removes.
/// Unlike `char::is_whitespace` it holds U+FEFF and not U+0085.
pub fn is_es_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n'
            | '\u{0b}'
            | '\u{0c}'
            | '\r'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// Text with ECMAScript's whitespace removed from both ends, as `trim` removes it.
pub fn es_trim(text: &str) -> &str {
    text.trim_matches(is_es_whitespace)
}

/// The order of two strings by their UTF-16 code units — what ECMAScript's `<` and its
/// default `sort` answer. It differs from the order of their bytes where a character
/// outside the basic plane meets one from U+E000 to U+FFFF.
pub fn compare_code_units(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

/// Text read as ECMAScript's `Number(text)` reads it: surrounding whitespace ignored, an
/// empty text `0`; a decimal with an optional sign, point and exponent, or `Infinity`;
/// an unsigned `0b`, `0o` or `0x` integer, rounded to the nearest double; anything else
/// NaN. No numeric separator is read.
pub fn es_string_to_number(text: &str) -> f64 {
    let text = es_trim(text);
    if text.is_empty() {
        return 0.0;
    }
    let bytes = text.as_bytes();
    if bytes.len() > 2 && bytes[0] == b'0' {
        let radix_bits = match bytes[1] {
            b'b' | b'B' => Some(1),
            b'o' | b'O' => Some(3),
            b'x' | b'X' => Some(4),
            _ => None,
        };
        if let Some(bits) = radix_bits {
            return radix_integer(&bytes[2..], bits);
        }
    }
    let (negative, unsigned) = match bytes[0] {
        b'+' => (false, &text[1..]),
        b'-' => (true, &text[1..]),
        _ => (false, text),
    };
    if unsigned == "Infinity" {
        return if negative { f64::NEG_INFINITY } else { f64::INFINITY };
    }
    if !is_unsigned_decimal(unsigned.as_bytes()) {
        return f64::NAN;
    }
    let magnitude: f64 = unsigned.parse().expect("a decimal literal the grammar accepts reads as a double");
    if negative {
        -magnitude
    } else {
        magnitude
    }
}

/// `DecimalDigits . DecimalDigits? ExponentPart?`, `. DecimalDigits ExponentPart?` or
/// `DecimalDigits ExponentPart?`.
fn is_unsigned_decimal(bytes: &[u8]) -> bool {
    let digits = |from: usize| bytes[from..].iter().take_while(|b| b.is_ascii_digit()).count();
    let whole = digits(0);
    let mut at = whole;
    let mut fraction = 0;
    if bytes.get(at) == Some(&b'.') {
        fraction = digits(at + 1);
        at += 1 + fraction;
    }
    if whole == 0 && fraction == 0 {
        return false;
    }
    if matches!(bytes.get(at), Some(b'e' | b'E')) {
        at += 1;
        if matches!(bytes.get(at), Some(b'+' | b'-')) {
            at += 1;
        }
        let exponent = digits(at);
        if exponent == 0 {
            return false;
        }
        at += exponent;
    }
    at == bytes.len()
}

/// An unsigned integer of `bits` bits per digit, rounded to the nearest double, a tie
/// to the even one; NaN where a character is not a digit of the radix or there is none.
fn radix_integer(digits: &[u8], bits: u32) -> f64 {
    let mut value_bits: Vec<bool> = Vec::with_capacity(digits.len() * bits as usize);
    for byte in digits {
        let digit = match (*byte as char).to_digit(1 << bits) {
            Some(digit) => digit,
            None => return f64::NAN,
        };
        for shift in (0..bits).rev() {
            value_bits.push(digit >> shift & 1 == 1);
        }
    }
    let Some(leading) = value_bits.iter().position(|bit| *bit) else { return 0.0 };
    let significant = &value_bits[leading..];
    let width = significant.len();
    if width <= 53 {
        return significant.iter().fold(0u64, |held, bit| held << 1 | *bit as u64) as f64;
    }
    let mut mantissa = significant[..53].iter().fold(0u64, |held, bit| held << 1 | *bit as u64);
    let half = significant[53];
    let beyond = significant[54..].iter().any(|bit| *bit);
    if half && (beyond || mantissa & 1 == 1) {
        mantissa += 1;
    }
    let exponent = (width - 53) as i32;
    if exponent > 1023 {
        return f64::INFINITY;
    }
    mantissa as f64 * 2f64.powi(exponent)
}
