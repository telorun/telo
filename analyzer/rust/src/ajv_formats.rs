//! JSON Schema's formats as `ajv-formats` 3.0.1 checks them (its `fullFormats`, the set
//! every Telo validator registers), and the `compare` functions its `formatMaximum` /
//! `formatMinimum` / `formatExclusiveMaximum` / `formatExclusiveMinimum` keywords read.
//!
//! A format `ajv-formats` writes as a JavaScript regular expression is matched here by
//! the RE2 engine `telorun-cel` holds, written so it accepts exactly the same strings:
//! a case-insensitive class spelled with both cases (a JavaScript `i` without `u` folds
//! no character outside ASCII onto an ASCII letter, where RE2's folding would fold `ſ`
//! and `K`), `\S` and `\s` spelled as ECMAScript's whitespace, and each lookahead read
//! as the condition it states. `date`, `time`, `date-time`, `byte` and the number
//! formats are its functions, read the same way. `regex` is not here: Telo replaces it
//! with the schema pattern seam (`schema_pattern`).

use std::sync::{Arc, OnceLock};

use telorun_cel::{re2_pattern, Re2Flags, Re2Program};
use telorun_cel_value::is_es_whitespace;

fn program(cell: &'static OnceLock<Arc<Re2Program>>, pattern: &str) -> &'static Re2Program {
    cell.get_or_init(|| re2_pattern(pattern, Re2Flags::NONE).expect("an ajv-formats pattern RE2 reads"))
}

macro_rules! pattern {
    ($name:ident, $source:expr) => {
        fn $name(text: &str) -> bool {
            static CELL: OnceLock<Arc<Re2Program>> = OnceLock::new();
            program(&CELL, $source).is_match(text)
        }
    };
}

/// ECMAScript's whitespace as an RE2 class body.
const ES_SPACE: &str = r"\t\n\x0B\f\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

const IPV6_LITERAL: &str = r"(?:(?:(?:(?:[0-9a-fA-F]{1,4}:){6}|::(?:[0-9a-fA-F]{1,4}:){5}|(?:[0-9a-fA-F]{1,4})?::(?:[0-9a-fA-F]{1,4}:){4}|(?:(?:[0-9a-fA-F]{1,4}:){0,1}[0-9a-fA-F]{1,4})?::(?:[0-9a-fA-F]{1,4}:){3}|(?:(?:[0-9a-fA-F]{1,4}:){0,2}[0-9a-fA-F]{1,4})?::(?:[0-9a-fA-F]{1,4}:){2}|(?:(?:[0-9a-fA-F]{1,4}:){0,3}[0-9a-fA-F]{1,4})?::[0-9a-fA-F]{1,4}:|(?:(?:[0-9a-fA-F]{1,4}:){0,4}[0-9a-fA-F]{1,4})?::)(?:[0-9a-fA-F]{1,4}:[0-9a-fA-F]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-fA-F]{1,4}:){0,5}[0-9a-fA-F]{1,4})?::[0-9a-fA-F]{1,4}|(?:(?:[0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4})?::)|[Vv][0-9a-fA-F]+\.[a-zA-Z0-9\-._~!$&'()*+,;=:]+)";

pattern!(uri_text, &format!(
    r"^(?:[a-zA-Z][a-zA-Z0-9+\-.]*:)(?:/?/(?:(?:[a-zA-Z0-9\-._~!$&'()*+,;=:]|%[0-9a-fA-F]{{2}})*@)?(?:\[{IPV6_LITERAL}\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){{3}}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-zA-Z0-9\-._~!$&'()*+,;=]|%[0-9a-fA-F]{{2}})*)(?::\d*)?(?:/(?:[a-zA-Z0-9\-._~!$&'()*+,;=:@]|%[0-9a-fA-F]{{2}})*)*|/(?:(?:[a-zA-Z0-9\-._~!$&'()*+,;=:@]|%[0-9a-fA-F]{{2}})+(?:/(?:[a-zA-Z0-9\-._~!$&'()*+,;=:@]|%[0-9a-fA-F]{{2}})*)*)?|(?:[a-zA-Z0-9\-._~!$&'()*+,;=:@]|%[0-9a-fA-F]{{2}})+(?:/(?:[a-zA-Z0-9\-._~!$&'()*+,;=:@]|%[0-9a-fA-F]{{2}})*)*)(?:\?(?:[a-zA-Z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-fA-F]{{2}})*)?(?:#(?:[a-zA-Z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-fA-F]{{2}})*)?$"
));

pattern!(uri_reference, &format!(
    r#"^(?:[a-zA-Z][a-zA-Z0-9+\-.]*:)?(?:/?/(?:(?:[a-zA-Z0-9\-._~!$&'()*+,;=:]|%[0-9a-fA-F]{{2}})*@)?(?:\[{IPV6_LITERAL}\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){{3}}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-zA-Z0-9\-._~!$&'"()*+,;=]|%[0-9a-fA-F]{{2}})*)(?::\d*)?(?:/(?:[a-zA-Z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-fA-F]{{2}})*)*|/(?:(?:[a-zA-Z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-fA-F]{{2}})+(?:/(?:[a-zA-Z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-fA-F]{{2}})*)*)?|(?:[a-zA-Z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-fA-F]{{2}})+(?:/(?:[a-zA-Z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-fA-F]{{2}})*)*)?(?:\?(?:[a-zA-Z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-fA-F]{{2}})*)?(?:#(?:[a-zA-Z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-fA-F]{{2}})*)?$"#
));

pattern!(uri_template, r#"^(?:(?:[^\x00-\x20"'<>%\\^`{|}]|%[0-9a-fA-F]{2})|\{[+#./;?&=,!@|]?(?:[a-zA-Z0-9_]|%[0-9a-fA-F]{2})+(?::[1-9][0-9]{0,3}|\*)?(?:,(?:[a-zA-Z0-9_]|%[0-9a-fA-F]{2})+(?::[1-9][0-9]{0,3}|\*)?)*\})*$"#);

pattern!(email, r"^[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$");

pattern!(hostname_body, r"^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[-0-9a-zA-Z]{0,61}[0-9a-zA-Z])?)*\.?$");

pattern!(ipv4, r"^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$");

pattern!(ipv6, r"^((([0-9a-fA-F]{1,4}:){7}([0-9a-fA-F]{1,4}|:))|(([0-9a-fA-F]{1,4}:){6}(:[0-9a-fA-F]{1,4}|((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-fA-F]{1,4}:){5}(((:[0-9a-fA-F]{1,4}){1,2})|:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-fA-F]{1,4}:){4}(((:[0-9a-fA-F]{1,4}){1,3})|((:[0-9a-fA-F]{1,4})?:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-fA-F]{1,4}:){3}(((:[0-9a-fA-F]{1,4}){1,4})|((:[0-9a-fA-F]{1,4}){0,2}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-fA-F]{1,4}:){2}(((:[0-9a-fA-F]{1,4}){1,5})|((:[0-9a-fA-F]{1,4}){0,3}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-fA-F]{1,4}:){1}(((:[0-9a-fA-F]{1,4}){1,6})|((:[0-9a-fA-F]{1,4}){0,4}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(:(((:[0-9a-fA-F]{1,4}){1,7})|((:[0-9a-fA-F]{1,4}){0,5}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:)))$");

pattern!(uuid, r"^(?:[uU][rR][nN]:[uU][uU][iI][dD]:)?[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$");

pattern!(json_pointer, r"^(?:/(?:[^~/]|~0|~1)*)*$");

pattern!(json_pointer_uri_fragment, r"^#(?:/(?:[a-zA-Z0-9_\-.!$&'()*+,;:=@]|%[0-9a-fA-F]{2}|~0|~1)*)*$");

pattern!(relative_json_pointer, r"^(?:0|[1-9][0-9]*)(?:#|(?:/(?:[^~/]|~0|~1)*)*)$");

// `duration`'s `T(?=\d)` with the parts after it reaching the end is a `T` part holding
// at least one of them; its `P(?!$)` is a `P` that is not the whole text.
pattern!(duration_body, r"^P(?:(?:\d+Y)?(?:\d+M)?(?:\d+D)?(?:T(?:\d+H(?:\d+M)?(?:\d+S)?|\d+M(?:\d+S)?|\d+S))?|(?:\d+W)?)$");

fn duration(text: &str) -> bool {
    text.len() > 1 && duration_body(text)
}

fn hostname(text: &str) -> bool {
    if !hostname_body(text) {
        return false;
    }
    // `(?=.{1,253}\.?$)`: the body admits ASCII alone, one unit a character.
    let length = text.len();
    (1..=253).contains(&length) || (length == 254 && text.ends_with('.'))
}

fn uri(text: &str) -> bool {
    (text.contains('/') || text.contains(':')) && uri_text(text)
}

fn url_prefix(text: &str) -> Option<usize> {
    static CELL: OnceLock<Arc<Re2Program>> = OnceLock::new();
    let program = program(&CELL, r"(?i)^(?:https?|ftp)://");
    let found = program.search(text, 0, 1).groups?;
    found.first().copied().flatten().map(|span| span.end)
}

fn url(text: &str) -> bool {
    static IP: OnceLock<Arc<Re2Program>> = OnceLock::new();
    static HOST: OnceLock<Arc<Re2Program>> = OnceLock::new();
    static PRIVATE_A: OnceLock<Arc<Re2Program>> = OnceLock::new();
    static PRIVATE_B: OnceLock<Arc<Re2Program>> = OnceLock::new();
    static PRIVATE_C: OnceLock<Arc<Re2Program>> = OnceLock::new();
    let Some(start) = url_prefix(text) else { return false };
    let tail = format!(r"(?::\d{{2,5}})?(?:/[^{ES_SPACE}]*)?$");
    let ip = program(&IP, &format!(r"(?i)^(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])(?:\.(?:1?\d{{1,2}}|2[0-4]\d|25[0-5])){{2}}(?:\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4])){tail}"));
    let host = program(&HOST, &format!(r"(?i)^(?:(?:[a-z0-9\x{{a1}}-\x{{ffff}}]+-)*[a-z0-9\x{{a1}}-\x{{ffff}}]+)(?:\.(?:[a-z0-9\x{{a1}}-\x{{ffff}}]+-)*[a-z0-9\x{{a1}}-\x{{ffff}}]+)*(?:\.(?:[a-z\x{{a1}}-\x{{ffff}}]{{2,}})){tail}"));
    let excluded = [
        program(&PRIVATE_A, r"^(?:10|127)(?:\.\d{1,3}){3}"),
        program(&PRIVATE_B, r"^(?:169\.254|192\.168)(?:\.\d{1,3}){2}"),
        program(&PRIVATE_C, r"^172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}"),
    ];
    // `(?:\S+(?::\S*)?@)?`: the host starts right after the scheme, or after any `@`
    // that closes a run of non-whitespace.
    let mut starts = vec![start];
    for (offset, c) in text[start..].char_indices() {
        if c == '@' && offset > 0 && !text[start..start + offset].chars().any(is_es_whitespace) {
            starts.push(start + offset + 1);
        }
    }
    starts.into_iter().any(|at| {
        let rest = &text[at..];
        (!excluded.iter().any(|guard| guard.is_match(rest)) && ip.is_match(rest)) || host.is_match(rest)
    })
}

fn two_digits(chars: &[char], at: usize) -> Option<u32> {
    let pair = chars.get(at..at + 2)?;
    pair.iter().all(char::is_ascii_digit).then(|| pair.iter().fold(0, |n, c| n * 10 + c.to_digit(10).unwrap()))
}

fn is_leap_year(year: u32) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

fn date(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() != 10 || chars[4] != '-' || chars[7] != '-' {
        return false;
    }
    let (Some(high), Some(low), Some(month), Some(day)) =
        (two_digits(&chars, 0), two_digits(&chars, 2), two_digits(&chars, 5), two_digits(&chars, 8))
    else {
        return false;
    };
    let year = high * 100 + low;
    const DAYS: [u32; 13] = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    (1..=12).contains(&month) && day >= 1 && day <= if month == 2 && is_leap_year(year) { 29 } else { DAYS[month as usize] }
}

/// `TIME`'s groups: hour, minute, the second's text, whether a zone was written, its
/// sign, hours and minutes.
struct TimeParts {
    hour: u32,
    minute: u32,
    second: String,
    zone: bool,
    sign: i64,
    zone_hour: u32,
    zone_minute: u32,
}

fn time_parts(text: &str) -> Option<TimeParts> {
    let chars: Vec<char> = text.chars().collect();
    let hour = two_digits(&chars, 0)?;
    (chars.get(2) == Some(&':')).then_some(())?;
    let minute = two_digits(&chars, 3)?;
    (chars.get(5) == Some(&':')).then_some(())?;
    two_digits(&chars, 6)?;
    let mut at = 8;
    if chars.get(at) == Some(&'.') && chars.get(at + 1).is_some_and(char::is_ascii_digit) {
        at += 1;
        while chars.get(at).is_some_and(char::is_ascii_digit) {
            at += 1;
        }
    }
    let second: String = chars[6..at].iter().collect();
    let rest = &chars[at..];
    let mut parts = TimeParts { hour, minute, second, zone: false, sign: 1, zone_hour: 0, zone_minute: 0 };
    match rest {
        [] => {}
        ['z' | 'Z'] => parts.zone = true,
        [sign @ ('+' | '-'), tail @ ..] => {
            parts.zone = true;
            parts.sign = if *sign == '-' { -1 } else { 1 };
            parts.zone_hour = two_digits(tail, 0)?;
            match &tail[2..] {
                [] => {}
                [_, _] => parts.zone_minute = two_digits(tail, 2)?,
                [':', _, _] => parts.zone_minute = two_digits(tail, 3)?,
                _ => return None,
            }
        }
        _ => return None,
    }
    Some(parts)
}

fn time_with(text: &str, strict_zone: bool) -> bool {
    let Some(parts) = time_parts(text) else { return false };
    let second: f64 = parts.second.parse().unwrap_or(f64::NAN);
    if parts.zone_hour > 23 || parts.zone_minute > 59 || (strict_zone && !parts.zone) {
        return false;
    }
    if parts.hour <= 23 && parts.minute <= 59 && second < 60.0 {
        return true;
    }
    let utc_minute = parts.minute as i64 - parts.zone_minute as i64 * parts.sign;
    let utc_hour = parts.hour as i64 - parts.zone_hour as i64 * parts.sign - if utc_minute < 0 { 1 } else { 0 };
    (utc_hour == 23 || utc_hour == -1) && (utc_minute == 59 || utc_minute == -1) && second < 61.0
}

fn date_time_parts(text: &str) -> Vec<&str> {
    text.split(|c: char| c == 't' || c == 'T' || is_es_whitespace(c)).collect()
}

fn date_time_with(text: &str, strict_zone: bool) -> bool {
    let parts = date_time_parts(text);
    parts.len() == 2 && date(parts[0]) && time_with(parts[1], strict_zone)
}

fn byte(text: &str) -> bool {
    // The `m` flag: some line, between line terminators, is whole base64.
    text.split(['\n', '\r', '\u{2028}', '\u{2029}']).any(|line| {
        let chars: Vec<char> = line.chars().collect();
        let padding = chars.iter().rev().take_while(|c| **c == '=').count();
        let body = &chars[..chars.len() - padding];
        body.iter().all(|c| c.is_ascii_alphanumeric() || *c == '+' || *c == '/')
            && match padding {
                0 => body.len() % 4 == 0,
                1 => body.len() % 4 == 3,
                2 => body.len() % 4 == 2,
                _ => false,
            }
    })
}

/// A format `ajv-formats` defines.
#[derive(Clone, Copy)]
pub enum AjvFormat {
    /// Accepts every value (`password`, `binary`).
    Any,
    Text(fn(&str) -> bool),
    Number(fn(f64) -> bool),
}

/// `fullFormats`, by name.
pub fn ajv_format(name: &str) -> Option<AjvFormat> {
    Some(match name {
        "date" => AjvFormat::Text(date),
        "time" => AjvFormat::Text(|t| time_with(t, true)),
        "date-time" => AjvFormat::Text(|t| date_time_with(t, true)),
        "iso-time" => AjvFormat::Text(|t| time_with(t, false)),
        "iso-date-time" => AjvFormat::Text(|t| date_time_with(t, false)),
        "duration" => AjvFormat::Text(duration),
        "uri" => AjvFormat::Text(uri),
        "uri-reference" => AjvFormat::Text(uri_reference),
        "uri-template" => AjvFormat::Text(uri_template),
        "url" => AjvFormat::Text(url),
        "email" => AjvFormat::Text(email),
        "hostname" => AjvFormat::Text(hostname),
        "ipv4" => AjvFormat::Text(ipv4),
        "ipv6" => AjvFormat::Text(ipv6),
        "uuid" => AjvFormat::Text(uuid),
        "json-pointer" => AjvFormat::Text(json_pointer),
        "json-pointer-uri-fragment" => AjvFormat::Text(json_pointer_uri_fragment),
        "relative-json-pointer" => AjvFormat::Text(relative_json_pointer),
        "byte" => AjvFormat::Text(byte),
        "int32" => AjvFormat::Number(|v| v.is_finite() && v.trunc() == v && (-2_147_483_648.0..=2_147_483_647.0).contains(&v)),
        "int64" => AjvFormat::Number(|v| v.is_finite() && v.trunc() == v),
        "float" | "double" => AjvFormat::Number(|_| true),
        "password" | "binary" => AjvFormat::Any,
        _ => return None,
    })
}

/// Every name `fullFormats` defines, in its order.
pub const AJV_FORMAT_NAMES: [&str; 26] = [
    "date", "time", "date-time", "iso-time", "iso-date-time", "duration", "uri", "uri-reference", "uri-template",
    "url", "email", "hostname", "ipv4", "ipv6", "regex", "uuid", "json-pointer", "json-pointer-uri-fragment",
    "relative-json-pointer", "byte", "int32", "int64", "float", "double", "password", "binary",
];

/// An instant as `new Date(text).valueOf()` reads the ECMAScript date-time string format,
/// in milliseconds; `None` where it is NaN. A form with no offset is read as UTC.
fn date_value(text: &str) -> Option<f64> {
    let chars: Vec<char> = text.chars().collect();
    let digits = |from: usize, count: usize| -> Option<i64> {
        let part = chars.get(from..from + count)?;
        part.iter().all(char::is_ascii_digit).then(|| part.iter().fold(0i64, |n, c| n * 10 + c.to_digit(10).unwrap() as i64))
    };
    let (year, mut at) = match chars.first() {
        Some('+' | '-') => {
            let value = digits(1, 6)?;
            if chars[0] == '-' && value == 0 {
                return None;
            }
            (if chars[0] == '-' { -value } else { value }, 7)
        }
        _ => (digits(0, 4)?, 4),
    };
    let (mut month, mut day) = (1, 1);
    if chars.get(at) == Some(&'-') {
        month = digits(at + 1, 2)?;
        at += 3;
        if chars.get(at) == Some(&'-') {
            day = digits(at + 1, 2)?;
            at += 3;
        }
    }
    let (mut hour, mut minute, mut second, mut millis) = (0, 0, 0, 0.0);
    let mut offset_minutes = 0i64;
    if chars.get(at) == Some(&'T') {
        hour = digits(at + 1, 2)?;
        (chars.get(at + 3) == Some(&':')).then_some(())?;
        minute = digits(at + 4, 2)?;
        at += 6;
        if chars.get(at) == Some(&':') {
            second = digits(at + 1, 2)?;
            at += 3;
            if chars.get(at) == Some(&'.') {
                let count = chars[at + 1..].iter().take_while(|c| c.is_ascii_digit()).count();
                (count > 0).then_some(())?;
                let fraction: String = chars[at + 1..at + 1 + count].iter().collect();
                millis = format!("0.{fraction}").parse::<f64>().ok()? * 1000.0;
                millis = millis.trunc();
                at += 1 + count;
            }
        }
        match chars.get(at) {
            Some('Z') => at += 1,
            Some(sign @ ('+' | '-')) => {
                let hours = digits(at + 1, 2)?;
                (chars.get(at + 3) == Some(&':')).then_some(())?;
                let minutes = digits(at + 4, 2)?;
                (hours <= 23 && minutes <= 59).then_some(())?;
                offset_minutes = (hours * 60 + minutes) * if *sign == '-' { -1 } else { 1 };
                at += 6;
            }
            _ => {}
        }
    }
    (at == chars.len()).then_some(())?;
    let valid = (1..=12).contains(&month)
        && day >= 1
        && day <= days_in_month(year, month)
        && (hour <= 23 || (hour == 24 && minute == 0 && second == 0 && millis == 0.0))
        && minute <= 59
        && second <= 59;
    valid.then_some(())?;
    let days = days_from_civil(year, month, day);
    let value = ((days * 24 + hour) * 60 + minute - offset_minutes) as f64 * 60_000.0 + second as f64 * 1000.0 + millis;
    (value.abs() <= 8.64e15).then_some(value)
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn order(a: &str, b: &str) -> i32 {
    match a.cmp(b) {
        std::cmp::Ordering::Less => -1,
        std::cmp::Ordering::Equal => 0,
        std::cmp::Ordering::Greater => 1,
    }
}

fn compare_instants(a: Option<f64>, b: Option<f64>) -> Option<f64> {
    let (a, b) = (a?, b?);
    (a != 0.0 && b != 0.0).then_some(a - b)
}

/// The `compare` of the format `name`, for `formatMaximum` and its siblings: the sign of
/// the comparison of two values, `None` where the format answers `undefined`, and the
/// outer `None` where the format defines no `compare`.
pub fn ajv_format_compare(name: &str) -> Option<fn(&str, &str) -> Option<f64>> {
    fn date_order(a: &str, b: &str) -> Option<f64> {
        (!a.is_empty() && !b.is_empty()).then(|| order(a, b) as f64)
    }
    fn time_order(a: &str, b: &str) -> Option<f64> {
        if a.is_empty() || b.is_empty() {
            return None;
        }
        compare_instants(date_value(&format!("2020-01-01T{a}")), date_value(&format!("2020-01-01T{b}")))
    }
    fn date_time_order(a: &str, b: &str) -> Option<f64> {
        if a.is_empty() || b.is_empty() {
            return None;
        }
        compare_instants(date_value(a), date_value(b))
    }
    fn iso_time_order(a: &str, b: &str) -> Option<f64> {
        if a.is_empty() || b.is_empty() {
            return None;
        }
        let (x, y) = (time_parts(a)?, time_parts(b)?);
        let key = |p: &TimeParts| format!("{:02}{:02}{}", p.hour, p.minute, p.second);
        Some(order(&key(&x), &key(&y)) as f64)
    }
    fn iso_date_time_order(a: &str, b: &str) -> Option<f64> {
        if a.is_empty() || b.is_empty() {
            return None;
        }
        let (x, y) = (date_time_parts(a), date_time_parts(b));
        let result = date_order(x.first().copied().unwrap_or(""), y.first().copied().unwrap_or(""))?;
        if result != 0.0 {
            return Some(result);
        }
        time_order(x.get(1).copied().unwrap_or(""), y.get(1).copied().unwrap_or(""))
    }
    Some(match name {
        "date" => date_order,
        "time" => time_order,
        "date-time" => date_time_order,
        "iso-time" => iso_time_order,
        "iso-date-time" => iso_date_time_order,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(name: &str, value: &str) -> bool {
        match ajv_format(name) {
            Some(AjvFormat::Text(check)) => check(value),
            _ => panic!("{name} is a text format"),
        }
    }

    #[test]
    fn reads_the_formats_as_ajv_formats_does() {
        assert!(text("byte", "aGk="));
        assert!(text("byte", ""));
        assert!(!text("byte", "a"));
        assert!(text("byte", "a\n"));
        assert!(text("url", "https://example.com"));
        assert!(!text("url", "http://10.1.1.1"));
        assert!(text("url", "http://user@10.1.1.1.example.com"));
        assert!(!text("duration", "P"));
        assert!(!text("duration", "PT"));
        assert!(text("duration", "P1DT2H"));
        assert!(text("time", "23:59:60Z"));
        assert!(!text("time", "10:20:30"));
        assert!(text("iso-time", "10:20:30"));
        assert!(text("hostname", "example.com"));
        assert!(!text("hostname", "-bad.com"));
        assert!(!text("uuid", "123e4567"));
        assert!(text("uuid", "URN:UUID:123e4567-e89b-12d3-a456-426614174000"));
    }
}
