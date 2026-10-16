//! Plain encodings — the one canonical JSON form of each non-live `instance`
//! value type, keyed by the symbolic `encoding` an entry declares.
//!
//! The Rust half of `sdk/nodejs/src/plain-encoding.ts`, and it must read and
//! write exactly what that file does: an entry names its encoding as a symbol,
//! and each runtime maps the symbol to its own codec. `decode` answers "is this
//! text in the encoding, and what does it say" rather than failing, so a reader
//! can leave text it cannot decode for the slot's assertion to report.

use crate::cel_value_identity::{Duration, Timestamp};

/// One plain encoding: its symbol, how the text is written, for a message pointing
/// an author at the form, and whether it builds a value from an object of members —
/// which an entry declaring `members` requires of its encoding.
#[derive(Debug, Clone, Copy)]
pub struct PlainEncoding {
    pub name: &'static str,
    pub form: &'static str,
    pub composes: bool,
}

/// Every plain encoding this runtime implements — the closed set an entry's
/// `encoding` may name, identical to the Node table.
pub const PLAIN_ENCODINGS: &[PlainEncoding] = &[
    PlainEncoding { name: "base64url", form: "base64url text without padding", composes: false },
    PlainEncoding { name: "rfc3339", form: "RFC 3339 text (2026-01-15T09:30:00Z)", composes: false },
    PlainEncoding {
        name: "cel-duration",
        form: "a CEL duration string within ±315576000000s (1h30m, 250ms, 5400s)",
        composes: false,
    },
    PlainEncoding {
        name: "url-text",
        form: "an absolute URL (postgres://user:password@db.internal:5432/orders), each component percent-encoded where RFC 3986 requires",
        composes: true,
    },
];

/// The members a host value written in `encoding` holds, or `None` when its payload is
/// not that encoding's value or the encoding builds no value from members.
pub fn host_members(
    encoding: &str,
    host: &telorun_cel_value::CelHostValue,
) -> Option<serde_json::Map<String, serde_json::Value>> {
    match encoding {
        "url-text" => host.payload().downcast_ref::<url_text::Url>().map(url_text::members),
        _ => None,
    }
}

/// `base64url` — bytes as base64url without padding.
pub mod base64url {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

    fn sextet(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a') as u32 + 26),
            b'0'..=b'9' => Some((c - b'0') as u32 + 52),
            b'-' => Some(62),
            b'_' => Some(63),
            _ => None,
        }
    }

    /// The bytes `text` encodes, or `None` when it is not base64url. As the
    /// forgiving decoder the Node half uses, bits left over past the last whole
    /// byte are discarded; a length of 1 mod 4 names no whole byte.
    pub fn decode(text: &str) -> Option<Vec<u8>> {
        let input = text.as_bytes();
        if input.len() % 4 == 1 {
            return None;
        }
        let mut out = Vec::with_capacity(input.len() * 3 / 4);
        let mut buffer: u32 = 0;
        let mut bits = 0;
        for &c in input {
            buffer = (buffer << 6) | sextet(c)?;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((buffer >> bits) as u8);
                buffer &= (1 << bits) - 1;
            }
        }
        Some(out)
    }

    /// The canonical text of `bytes`.
    pub fn encode(bytes: &[u8]) -> String {
        let mut out = String::with_capacity((bytes.len() * 4).div_ceil(3));
        for chunk in bytes.chunks(3) {
            let n = chunk.len();
            let word = (chunk[0] as u32) << 16
                | (*chunk.get(1).unwrap_or(&0) as u32) << 8
                | *chunk.get(2).unwrap_or(&0) as u32;
            for i in 0..=n {
                out.push(ALPHABET[((word >> (18 - 6 * i)) & 63) as usize] as char);
            }
        }
        out
    }
}

/// `rfc3339` — a timestamp as RFC 3339 text, written in UTC with its fraction
/// trimmed to the nanosecond it holds.
///
/// The STRICT form of the value domain's lenient reading: the shape is checked
/// here, and the calendar, the offset arithmetic and the range are
/// `parse_timestamp`'s.
pub mod rfc3339 {
    use telorun_cel_value::{format_timestamp, parse_timestamp};

    use super::Timestamp;

    fn two_digits(text: &[u8]) -> Option<u8> {
        match text {
            [tens @ b'0'..=b'9', units @ b'0'..=b'9'] => Some((tens - b'0') * 10 + (units - b'0')),
            _ => None,
        }
    }

    /// What this form refuses of text the lenient reading accepts: a space between
    /// the date and the time, a fraction past the nanosecond, and an offset beyond
    /// ±23:59. Everything else about the shape is the lenient reading's to refuse.
    fn is_strict(text: &str) -> bool {
        let text = text.as_bytes();
        if !matches!(text.get(10), Some(b'T' | b't')) {
            return false;
        }
        let Some(mut rest) = text.get(19..) else {
            return false;
        };
        if let Some(fraction) = rest.strip_prefix(b".") {
            let digits = fraction.iter().take_while(|c| c.is_ascii_digit()).count();
            if digits > 9 {
                return false;
            }
            rest = &fraction[digits..];
        }
        match rest {
            [b'+' | b'-', hours @ .., b':', minute_tens, minute_units] => {
                match (two_digits(hours), two_digits(&[*minute_tens, *minute_units])) {
                    (Some(hours), Some(minutes)) => hours <= 23 && minutes <= 59,
                    _ => false,
                }
            }
            _ => true,
        }
    }

    /// The timestamp `text` encodes, or `None`. Any offset is read; a fraction
    /// is read to the nanosecond, the precision a timestamp holds, and a tenth
    /// fractional digit names a precision no timestamp carries, so it is refused
    /// rather than rounded away.
    pub fn decode(text: &str) -> Option<Timestamp> {
        if !is_strict(text) {
            return None;
        }
        parse_timestamp(text).ok().map(Timestamp::from)
    }

    /// The canonical text: `YYYY-MM-DDTHH:MM:SSZ` in UTC, with the fraction
    /// absent when the instant is a whole second and otherwise one to nine
    /// digits with no trailing zero — the rule a duration's text follows.
    pub fn encode(timestamp: &Timestamp) -> String {
        format_timestamp((*timestamp).into())
    }
}

/// `cel-duration` — a duration as a CEL duration string; the canonical text is
/// seconds (`5400s`).
///
/// `decode` reads with a grammar of its own, which is not yet the value domain's
/// `duration_nanos_from_text`: moving to it changes what some text reads as, and
/// awaits the user's confirmation.
pub mod cel_duration {
    use telorun_cel_value::format_duration;

    use super::Duration;

    const NANOS_PER_SECOND: i128 = 1_000_000_000;

    /// protobuf Duration's range, in whole seconds either side of zero. CEL's own
    /// range is narrower and is applied where a duration enters the engine.
    pub const MAX_SECONDS: u64 = 315_576_000_000;

    fn unit_nanos(unit: &str) -> i128 {
        match unit {
            "h" => 3_600 * NANOS_PER_SECOND,
            "m" => 60 * NANOS_PER_SECOND,
            "s" => NANOS_PER_SECOND,
            "ms" => 1_000_000,
            "us" | "µs" => 1_000,
            _ => 1,
        }
    }

    /// The first unit `rest` starts with, in the order CEL's reader tries them.
    fn unit_at(rest: &str) -> Option<&'static str> {
        ["ns", "us", "µs", "ms", "s", "m", "h"].into_iter().find(|unit| rest.starts_with(unit))
    }

    /// The duration `text` encodes, or `None`: an optional sign, then one or more decimal numbers, each
    /// with an optional fraction and a unit (`ns`, `us`, `µs`, `ms`, `s`, `m`,
    /// `h`). A fraction is read to 13 digits. A duration outside
    /// ±[`MAX_SECONDS`] is not one.
    pub fn decode(text: &str) -> Option<Duration> {
        if text.is_empty() {
            return None;
        }
        let negative = text.starts_with('-');
        let mut rest = text.strip_prefix(['-', '+']).unwrap_or(text);
        let mut total: i128 = 0;
        loop {
            let integer_end = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
            let integer = &rest[..integer_end];
            let mut after = &rest[integer_end..];
            let mut fraction = "";
            if let Some(stripped) = after.strip_prefix('.') {
                let end = stripped.find(|c: char| !c.is_ascii_digit()).unwrap_or(stripped.len());
                fraction = &stripped[..end];
                after = &stripped[end..];
            }
            let unit = unit_at(after)?;
            let nanos = unit_nanos(unit);
            let whole = if integer.is_empty() { 0 } else { integer.parse::<i128>().ok()? };
            let mut part = whole.checked_mul(nanos)?;
            if !fraction.is_empty() {
                let digits: String = fraction.chars().take(13).collect();
                let padded = format!("{digits:0<13}").parse::<i128>().ok()?;
                part = part.checked_add(padded.checked_mul(nanos)? / 10_000_000_000_000)?;
            }
            total = total.checked_add(part)?;
            rest = &after[unit.len()..];
            if rest.is_empty() {
                break;
            }
        }
        Duration::from_total_nanos(if negative { -total } else { total })
            .filter(|duration| duration.seconds().unsigned_abs() <= MAX_SECONDS)
    }

    /// The canonical text: seconds with a trimmed fraction, as the protobuf JSON
    /// form writes a duration.
    pub fn encode(duration: &Duration) -> String {
        format_duration((*duration).into())
    }
}

/// `url-text` — the plain encoding of `Telo.Url`, and how a URL is built from its
/// members. The Rust half of `sdk/nodejs/src/url-text.ts`: both read, write and build
/// every row of `sdk/value-types/encodings/url-text.json` alike, refusals word for word.
pub mod url_text {
    use serde_json::{Map, Value};

    /// The members a URL holds, unescaped. The query is ordered by key, compared as
    /// UTF-16 code units, which is the order its text writes it in.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct Url {
        pub scheme: String,
        pub host: Option<String>,
        pub port: Option<u16>,
        pub user: Option<String>,
        pub password: Option<String>,
        pub path: Option<String>,
        pub query: Option<Vec<(String, String)>>,
    }

    /// The member names, in the order a refusal lists them.
    pub const MEMBER_NAMES: [&str; 7] = ["scheme", "host", "port", "user", "password", "path", "query"];

    const SUB_DELIMS: &[u8] = b"!$&'()*+,;=";

    fn is_unreserved(c: u8) -> bool {
        c.is_ascii_alphanumeric() || matches!(c, b'-' | b'.' | b'_' | b'~')
    }
    fn user_or_host_char(c: u8) -> bool {
        is_unreserved(c) || SUB_DELIMS.contains(&c)
    }
    fn password_char(c: u8) -> bool {
        user_or_host_char(c) || c == b':'
    }
    fn path_char(c: u8) -> bool {
        user_or_host_char(c) || matches!(c, b':' | b'@' | b'/')
    }
    fn query_char(c: u8) -> bool {
        (is_unreserved(c) || SUB_DELIMS.contains(&c) || matches!(c, b':' | b'@' | b'/' | b'?')) && c != b'&'
    }

    fn is_scheme(text: &str) -> bool {
        let mut bytes = text.bytes();
        matches!(bytes.next(), Some(c) if c.is_ascii_alphabetic())
            && bytes.all(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'.' | b'-'))
    }

    fn is_ipv4(text: &str) -> bool {
        let octets: Vec<&str> = text.split('.').collect();
        octets.len() == 4
            && octets.iter().all(|octet| {
                !octet.is_empty()
                    && octet.len() <= 3
                    && octet.bytes().all(|c| c.is_ascii_digit())
                    && (octet.len() == 1 || !octet.starts_with('0'))
                    && octet.parse::<u16>().is_ok_and(|n| n <= 255)
            })
    }

    /// An IPv6 address in RFC 4291 text form, no zone.
    fn is_ipv6(text: &str) -> bool {
        let halves: Vec<&str> = text.split("::").collect();
        if halves.len() > 2 {
            return false;
        }
        let groups: Vec<&str> =
            halves.iter().flat_map(|half| if half.is_empty() { vec![] } else { half.split(':').collect() }).collect();
        let mut count = 0;
        for (index, group) in groups.iter().enumerate() {
            if index == groups.len() - 1 && group.contains('.') {
                if !is_ipv4(group) {
                    return false;
                }
                count += 2;
                continue;
            }
            if group.is_empty() || group.len() > 4 || !group.bytes().all(|c| c.is_ascii_hexdigit()) {
                return false;
            }
            count += 1;
        }
        if halves.len() == 2 { count <= 7 } else { count == 8 }
    }

    /// The text a component's written form holds, or `None` for a character the
    /// component does not admit raw, a malformed escape, or bytes that are not UTF-8.
    fn unescape(written: &str, admits: fn(u8) -> bool) -> Option<String> {
        let input = written.as_bytes();
        let mut bytes = Vec::with_capacity(input.len());
        let mut at = 0;
        while at < input.len() {
            let c = input[at];
            if c == b'%' {
                let hex = input.get(at + 1..at + 3)?;
                if !hex.iter().all(u8::is_ascii_hexdigit) {
                    return None;
                }
                bytes.push(u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?);
                at += 3;
                continue;
            }
            if !admits(c) {
                return None;
            }
            bytes.push(c);
            at += 1;
        }
        String::from_utf8(bytes).ok()
    }

    /// A component's canonical written form: every byte that is not unreserved, escaped.
    fn escape(text: &str, keep_slash: bool) -> String {
        let mut out = String::with_capacity(text.len());
        for &c in text.as_bytes() {
            if is_unreserved(c) || (keep_slash && c == b'/') {
                out.push(c as char);
            } else {
                out.push_str(&format!("%{c:02X}"));
            }
        }
        out
    }

    fn compare_code_units(a: &str, b: &str) -> std::cmp::Ordering {
        a.encode_utf16().cmp(b.encode_utf16())
    }

    fn path_refusal(path: &str, authority: bool) -> Option<&'static str> {
        if authority && !path.is_empty() && !path.starts_with('/') {
            return Some("its path must begin with '/' when it has a host");
        }
        if !authority && path.starts_with("//") {
            return Some("its path may not begin with '//' when it has no host");
        }
        None
    }

    const PORT_REFUSAL: &str = "its port is not a number from 1 to 65535";

    fn port_of(digits: &str) -> Result<u16, String> {
        if digits.is_empty() || !digits.bytes().all(|c| c.is_ascii_digit()) {
            return Err(PORT_REFUSAL.into());
        }
        let trimmed = digits.trim_start_matches('0');
        match trimmed.parse::<u32>() {
            Ok(port) if (1..=65535).contains(&port) && trimmed.len() <= 5 => Ok(port as u16),
            _ => Err(PORT_REFUSAL.into()),
        }
    }

    /// The URL `text` writes, or why it writes none.
    pub fn read(text: &str) -> Result<Url, String> {
        if text.contains('#') {
            return Err("it holds a fragment ('#'), which a Telo.Url does not carry".into());
        }
        let Some(colon) = text.find(':').filter(|&colon| is_scheme(&text[..colon])) else {
            return Err("it does not begin with a scheme ('postgres:', 'https:')".into());
        };
        let mut url = Url {
            scheme: text[..colon].to_ascii_lowercase(),
            host: None,
            port: None,
            user: None,
            password: None,
            path: None,
            query: None,
        };
        let mut rest = &text[colon + 1..];
        if let Some(mark) = rest.find('?') {
            url.query = Some(read_query(&rest[mark + 1..])?);
            rest = &rest[..mark];
        }
        let mut path = rest;
        if let Some(after) = rest.strip_prefix("//") {
            let (authority, remainder) = match after.find('/') {
                Some(end) => (&after[..end], &after[end..]),
                None => (after, ""),
            };
            path = remainder;
            read_authority(authority, &mut url)?;
        }
        let unescaped = unescape(path, path_char)
            .ok_or("its path holds a character that must be percent-encoded, or a malformed escape")?;
        if let Some(refusal) = path_refusal(&unescaped, url.host.is_some()) {
            return Err(refusal.into());
        }
        url.path = Some(unescaped).filter(|path| !path.is_empty());
        if url.query.as_ref().is_some_and(Vec::is_empty) {
            url.query = None;
        }
        Ok(url)
    }

    fn read_authority(authority: &str, url: &mut Url) -> Result<(), String> {
        let mut host_port = authority;
        if let Some(at) = authority.rfind('@') {
            let userinfo = &authority[..at];
            host_port = &authority[at + 1..];
            let (user, password) = match userinfo.find(':') {
                Some(split) => (unescape(&userinfo[..split], user_or_host_char), Some(unescape(&userinfo[split + 1..], password_char))),
                None => (unescape(userinfo, user_or_host_char), None),
            };
            let (Some(user), Some(password)) = (user, password.map_or(Some(None), |p| p.map(Some))) else {
                return Err("its user information holds a character that must be percent-encoded ('@', '/', '?' …), or a malformed escape".into());
            };
            url.user = Some(user);
            url.password = password;
        }
        let mut port = "";
        let host = if let Some(bracketed) = host_port.strip_prefix('[') {
            let Some(close) = bracketed.find(']') else {
                return Err("its host opens '[' and never closes it".into());
            };
            let host = &bracketed[..close];
            if !is_ipv6(host) {
                return Err("its bracketed host is not an IPv6 address".into());
            }
            let after = &bracketed[close + 1..];
            if !after.is_empty() {
                let Some(digits) = after.strip_prefix(':') else {
                    return Err("its host is followed by something other than a port".into());
                };
                port = digits;
            }
            host.to_string()
        } else {
            let written = match host_port.rfind(':') {
                Some(split) => {
                    port = &host_port[split + 1..];
                    &host_port[..split]
                }
                None => host_port,
            };
            let unescaped = unescape(written, user_or_host_char)
                .ok_or("its host holds a character that must be percent-encoded, or a malformed escape")?;
            if unescaped.contains(':') {
                return Err("its host holds ':' outside brackets, which only an IPv6 address may".into());
            }
            unescaped
        };
        url.host = Some(host);
        if !port.is_empty() {
            url.port = Some(port_of(port)?);
        }
        Ok(())
    }

    fn read_query(written: &str) -> Result<Vec<(String, String)>, String> {
        let mut query: Vec<(String, String)> = Vec::new();
        for pair in written.split('&').filter(|pair| !pair.is_empty()) {
            let (key, value) = match pair.find('=') {
                Some(split) => (unescape(&pair[..split], query_char), unescape(&pair[split + 1..], query_char)),
                None => (unescape(pair, query_char), Some(String::new())),
            };
            let (Some(key), Some(value)) = (key, value) else {
                return Err("its query holds a character that must be percent-encoded, or a malformed escape".into());
            };
            if key.is_empty() {
                return Err("its query holds an entry with no key".into());
            }
            if query.iter().any(|(held, _)| *held == key) {
                return Err("its query repeats a key".into());
            }
            query.push((key, value));
        }
        query.sort_by(|a, b| compare_code_units(&a.0, &b.0));
        Ok(query)
    }

    /// The canonical text of a URL.
    pub fn write(url: &Url) -> String {
        let mut text = format!("{}:", url.scheme);
        if let Some(host) = &url.host {
            text.push_str("//");
            if let Some(user) = &url.user {
                text.push_str(&escape(user, false));
                if let Some(password) = &url.password {
                    text.push(':');
                    text.push_str(&escape(password, false));
                }
                text.push('@');
            }
            if host.contains(':') {
                text.push_str(&format!("[{host}]"));
            } else {
                text.push_str(&escape(host, false));
            }
            if let Some(port) = url.port {
                text.push_str(&format!(":{port}"));
            }
        }
        if let Some(path) = &url.path {
            text.push_str(&escape(path, true));
        }
        if let Some(query) = url.query.as_ref().filter(|query| !query.is_empty()) {
            let mut pairs = query.clone();
            pairs.sort_by(|a, b| compare_code_units(&a.0, &b.0));
            let written: Vec<String> =
                pairs.iter().map(|(key, value)| format!("{}={}", escape(key, false), escape(value, false))).collect();
            text.push('?');
            text.push_str(&written.join("&"));
        }
        text
    }

    /// The members a URL holds, by name — the object form its text is written from.
    pub fn members(url: &Url) -> Map<String, Value> {
        let mut out = Map::new();
        out.insert("scheme".into(), url.scheme.clone().into());
        if let Some(host) = &url.host {
            out.insert("host".into(), host.clone().into());
        }
        if let Some(port) = url.port {
            out.insert("port".into(), port.into());
        }
        if let Some(user) = &url.user {
            out.insert("user".into(), user.clone().into());
        }
        if let Some(password) = &url.password {
            out.insert("password".into(), password.clone().into());
        }
        if let Some(path) = &url.path {
            out.insert("path".into(), path.clone().into());
        }
        if let Some(query) = &url.query {
            out.insert(
                "query".into(),
                Value::Object(query.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect()),
            );
        }
        out
    }

    /// Why one member's value cannot stand in a URL, or `None` when it can.
    fn member_refusal(name: &str, value: &Value) -> Option<String> {
        match name {
            "port" => {
                let port = match value {
                    Value::Number(number) => number
                        .as_i64()
                        .or_else(|| number.as_f64().filter(|f| f.fract() == 0.0 && f.abs() < 1e6).map(|f| f as i64)),
                    _ => None,
                };
                (!port.is_some_and(|port| (1..=65535).contains(&port)))
                    .then(|| "its 'port' member is not an integer from 1 to 65535".to_string())
            }
            "query" => {
                let Value::Object(entries) = value else {
                    return Some("its 'query' member is not a map of strings to strings".into());
                };
                for (key, held) in entries {
                    if key.is_empty() {
                        return Some("its 'query' member holds an entry with no key".into());
                    }
                    if !held.is_string() {
                        return Some("its 'query' member is not a map of strings to strings".into());
                    }
                }
                None
            }
            _ => {
                let Value::String(text) = value else {
                    return Some(format!("its '{name}' member is not text"));
                };
                if name == "scheme" && !is_scheme(text) {
                    return Some("its 'scheme' member is not a scheme (a letter, then letters, digits, '+', '-' or '.')".into());
                }
                if name == "host" && text.contains(':') && !is_ipv6(text) {
                    return Some("its 'host' member holds ':' and is not an IPv6 address (written without brackets)".into());
                }
                None
            }
        }
    }

    /// The URL an object of members builds, or why it builds none — the Node codec's
    /// `composeUrl`, refusal for refusal.
    pub fn compose(members: &Map<String, Value>) -> Result<Url, String> {
        for name in members.keys() {
            if !MEMBER_NAMES.contains(&name.as_str()) {
                return Err(format!("'{name}' is not one of its members ({})", MEMBER_NAMES.join(", ")));
            }
        }
        for name in MEMBER_NAMES {
            if let Some(refusal) = members.get(name).and_then(|value| member_refusal(name, value)) {
                return Err(refusal);
            }
        }
        let text = |name: &str| members.get(name).and_then(Value::as_str).map(str::to_string);
        let Some(scheme) = text("scheme") else {
            return Err("it has no 'scheme' member".into());
        };
        let host = text("host");
        for name in ["user", "password", "port"] {
            if members.contains_key(name) && host.is_none() {
                return Err(format!("its '{name}' member needs a 'host' (write host: \"\" for an empty one)"));
            }
        }
        if members.contains_key("password") && !members.contains_key("user") {
            return Err("its 'password' member needs a 'user' (write user: \"\" for an empty one)".into());
        }
        let path = text("path").unwrap_or_default();
        if let Some(refusal) = path_refusal(&path, host.is_some()) {
            return Err(refusal.into());
        }
        let query = members.get("query").and_then(Value::as_object).map(|entries| {
            let mut pairs: Vec<(String, String)> =
                entries.iter().map(|(key, value)| (key.clone(), value.as_str().unwrap_or_default().to_string())).collect();
            pairs.sort_by(|a, b| compare_code_units(&a.0, &b.0));
            pairs
        });
        Ok(Url {
            scheme: scheme.to_ascii_lowercase(),
            host,
            port: members.get("port").and_then(|value| match value {
                Value::Number(number) => number.as_i64().or_else(|| number.as_f64().map(|f| f as i64)),
                _ => None,
            }).map(|port| port as u16),
            user: text("user"),
            password: text("password"),
            path: Some(path).filter(|path| !path.is_empty()),
            query: query.filter(|query| !query.is_empty()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_timestamp_with_an_offset_is_the_same_instant_as_its_utc_text() {
        let east = rfc3339::decode("2026-01-15T09:30:00+02:00").unwrap();
        let utc = rfc3339::decode("2026-01-15T07:30:00Z").unwrap();
        let later = rfc3339::decode("2026-01-15T07:30:00.001Z").unwrap();
        assert_eq!(east, utc);
        assert!(east < later);
        assert_eq!(rfc3339::encode(&east), "2026-01-15T07:30:00Z");
    }

    #[test]
    fn reads_a_fraction_to_the_nanosecond_and_refuses_a_tenth_digit() {
        let read = |text: &str| rfc3339::decode(text).map(|t| rfc3339::encode(&t));
        assert_eq!(read("2026-01-15T07:30:00.000000001Z").as_deref(), Some("2026-01-15T07:30:00.000000001Z"));
        assert_eq!(read("2026-01-15T07:30:00.5Z").as_deref(), Some("2026-01-15T07:30:00.5Z"));
        assert_eq!(read("2026-01-15T07:30:00.000Z").as_deref(), Some("2026-01-15T07:30:00Z"));
        assert_eq!(read("2026-01-15T07:30:00.0000000001Z"), None);
        assert_eq!(read("2026-01-15T07:30:00.Z"), None);
        assert_eq!(read("9999-12-31T23:59:59.999999999Z").as_deref(), Some("9999-12-31T23:59:59.999999999Z"));
        assert_eq!(read("0001-01-01T00:00:00Z").as_deref(), Some("0001-01-01T00:00:00Z"));
        assert_eq!(read("0000-12-31T23:59:59Z"), None);
    }

    /// The "plain encodings" cases of `sdk/nodejs/tests/value-type.test.ts`, each answer
    /// the Node SDK's, executed. Every case of that file is here: none is among the
    /// duration texts the two grammars still read differently.
    #[test]
    fn answers_the_node_sdks_plain_encoding_cases() {
        assert_eq!(base64url::encode(&[251, 255, 0]), "-_8A");
        assert_eq!(base64url::decode("-_8A"), Some(vec![251, 255, 0]));
        assert_eq!(base64url::decode("-_8A="), None);

        let instant = |text: &str| rfc3339::decode(text).map(|t| (t.seconds(), t.subsec_nanos(), rfc3339::encode(&t)));
        assert_eq!(instant("2026-01-15T09:30:00.25+02:00"), Some((1768462200, 250000000, "2026-01-15T07:30:00.25Z".into())));
        assert_eq!(instant("2026-01-15T07:30:00.000Z"), Some((1768462200, 0, "2026-01-15T07:30:00Z".into())));
        assert_eq!(instant("2026-01-15T07:30:00.000000001Z"), Some((1768462200, 1, "2026-01-15T07:30:00.000000001Z".into())));
        assert_eq!(rfc3339::encode(&Timestamp::new(1768462200, 1).unwrap()), "2026-01-15T07:30:00.000000001Z");
        // A year below 100 is that year.
        assert_eq!(instant("0050-01-01T00:00:00Z"), Some((-60589296000, 0, "0050-01-01T00:00:00Z".into())));
        for refused in [
            "2026-02-30T00:00:00Z",
            "2026-01-15T09:30:00+24:00",
            "2026-01-15 09:30",
            "2026-01-15T07:30:00.0000000001Z",
            "10000-01-01T00:00:00Z",
        ] {
            assert_eq!(rfc3339::decode(refused), None, "{refused}");
        }

        let span = |text: &str| cel_duration::decode(text).map(|d| cel_duration::encode(&d));
        assert_eq!(span("1h30m").as_deref(), Some("5400s"));
        assert_eq!(cel_duration::encode(&Duration::from_total_nanos(-1_500_000_000).unwrap()), "-1.5s");
        assert_eq!(span("90 minutes"), None);
        // The range is protobuf's, wider than CEL's own: both bounds are pinned.
        assert_eq!(span("-315576000000.999999999s").as_deref(), Some("-315576000000.999999999s"));
        assert_eq!(span("20000000000s").as_deref(), Some("20000000000s"));
        assert_eq!(span("315576000001s"), None);
        assert_eq!(span(&format!("1{}h", "0".repeat(40))), None);
    }

    /// The shared vectors of `sdk/value-types/encodings/url-text.json`, which the Node
    /// SDK runs too: every text read to its members or refused with its reason, every
    /// object of members built or refused, and every value written canonically.
    #[test]
    fn answers_the_shared_url_text_vectors() {
        use serde_json::Value;
        let vectors: Value =
            serde_json::from_str(include_str!("../../../value-types/encodings/url-text.json")).unwrap();
        let members_of = |url: &url_text::Url| -> Value { Value::Object(url_text::members(url)) };
        for row in vectors["decode"].as_array().unwrap() {
            let text = row["text"].as_str().unwrap();
            match (url_text::read(text), row.get("refusal")) {
                (Err(refusal), Some(expected)) => assert_eq!(refusal, expected.as_str().unwrap(), "{text}"),
                (Ok(url), None) => {
                    assert_eq!(members_of(&url), row["members"], "{text}");
                    let canonical = url_text::write(&url);
                    assert_eq!(canonical, row["canonical"].as_str().unwrap(), "{text}");
                    assert_eq!(url_text::read(&canonical), Ok(url), "{text}");
                }
                (answer, _) => panic!("{text}: answered {answer:?} where the vector records {row}"),
            }
        }
        for row in vectors["compose"].as_array().unwrap() {
            let members = row["members"].as_object().unwrap();
            match (url_text::compose(members), row.get("refusal")) {
                (Err(refusal), Some(expected)) => assert_eq!(refusal, expected.as_str().unwrap(), "{row}"),
                (Ok(url), None) => assert_eq!(url_text::write(&url), row["canonical"].as_str().unwrap(), "{row}"),
                (answer, _) => panic!("answered {answer:?} where the vector records {row}"),
            }
        }
    }

    #[test]
    fn reads_every_duration_string_cel_reads() {
        let read = |text: &str| cel_duration::decode(text).map(|d| cel_duration::encode(&d));
        assert_eq!(read("1h30m").as_deref(), Some("5400s"));
        assert_eq!(read("-1.5h").as_deref(), Some("-5400s"));
        assert_eq!(read("250ms").as_deref(), Some("0.25s"));
        assert_eq!(read("1µs").as_deref(), Some("0.000001s"));
        assert_eq!(read("s").as_deref(), Some("0s"));
        assert_eq!(read("1.5.5s"), None);
        assert_eq!(read("5"), None);
        assert_eq!(read("-315576000000.999999999s").as_deref(), Some("-315576000000.999999999s"));
        assert_eq!(read("315576000001s"), None);
        assert_eq!(read(&format!("1{}h", "0".repeat(40))), None);
        assert_eq!(read(""), None);
    }
}
