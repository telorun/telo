//! The URI resolver AJV reads every `$id` and `$ref` through: a twin of `fast-uri` 3.1.9,
//! the package ajv 8.20.0 pins as its `uriResolver` — `parse`, `serialize` and `resolve`
//! as AJV calls them (no options), with the scheme handlers (`http`, `https`, `ws`, `wss`,
//! `urn`, `urn:uuid`), the IPv4 / IPv6 host readings and the percent-encoding
//! normalizations those three apply.
//!
//! A JavaScript string is UTF-16; every rule here reads a character where `fast-uri`
//! reads a code unit, which answers alike for any text a Rust string can hold.

/// A port as `fast-uri` holds one: the number it reads, or the text when it is not one.
#[derive(Clone, Debug, PartialEq)]
pub enum Port {
    Number(u64),
    Text(String),
}

/// A parsed URI's components.
#[derive(Clone, Debug, Default)]
pub struct Components {
    pub scheme: Option<String>,
    pub userinfo: Option<String>,
    pub host: Option<String>,
    pub port: Option<Port>,
    pub path: Option<String>,
    pub query: Option<String>,
    pub fragment: Option<String>,
    pub nid: Option<String>,
    pub nss: Option<String>,
    pub uuid: Option<String>,
    pub resource_name: Option<String>,
    pub secure: Option<bool>,
    pub error: Option<String>,
}

struct Status {
    parsed: Components,
    malformed: bool,
}

const MALFORMED_SCHEME_ERROR: &str = "URI scheme is malformed.";
const MALFORMED_HOST_ERROR: &str = "URI host is malformed.";

#[derive(Clone, Copy, PartialEq)]
enum Scheme {
    Http,
    Https,
    Ws,
    Wss,
    Urn,
    UrnUuid,
}

impl Scheme {
    fn domain_host(self) -> bool {
        matches!(self, Scheme::Http | Scheme::Https | Scheme::Ws | Scheme::Wss)
    }
}

fn scheme_handler(scheme: Option<&str>) -> Option<Scheme> {
    let scheme = scheme?;
    let lower = scheme.to_lowercase();
    match lower.as_str() {
        "http" => Some(Scheme::Http),
        "https" => Some(Scheme::Https),
        "ws" => Some(Scheme::Ws),
        "wss" => Some(Scheme::Wss),
        "urn" => Some(Scheme::Urn),
        "urn:uuid" => Some(Scheme::UrnUuid),
        _ => None,
    }
}

fn is_valid_scheme(scheme: &str) -> bool {
    let mut chars = scheme.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
}

fn validate_scheme(scheme: &str) -> Result<String, String> {
    if is_valid_scheme(scheme) {
        Ok(scheme.to_string())
    } else {
        Err(MALFORMED_SCHEME_ERROR.to_string())
    }
}

fn is_hex_pair(chars: &[char]) -> bool {
    chars.len() == 2 && chars.iter().all(|c| c.is_ascii_hexdigit())
}

fn is_unreserved(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | '~')
}

fn is_path_character(c: char) -> bool {
    c.is_ascii_alphanumeric() || "-._~!$&'()*+,;=:@/".contains(c)
}

fn is_query_fragment_character(c: char) -> bool {
    c.is_ascii_alphanumeric() || "-._~!$&'()*+,;=:@/?".contains(c)
}

fn is_userinfo_character(c: char) -> bool {
    c.is_ascii_alphanumeric() || "-._~!$&'()*+,;=:".contains(c)
}

fn is_escape_safe(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '*' | '+' | '-' | '.' | '/' | '@' | '_')
}

fn byte_hex(byte: u8) -> String {
    format!("%{byte:02X}")
}

fn percent_encode_char(c: char) -> String {
    let mut buffer = [0u8; 4];
    c.encode_utf8(&mut buffer).bytes().map(byte_hex).collect()
}

fn is_ipv4(host: &str) -> bool {
    let parts: Vec<&str> = host.split('.').collect();
    parts.len() == 4
        && parts.iter().all(|part| {
            let digits = part.chars().all(|c| c.is_ascii_digit());
            digits
                && match part.len() {
                    1 => true,
                    2 => !part.starts_with('0'),
                    3 => !part.starts_with('0') && part.parse::<u32>().is_ok_and(|n| n <= 255),
                    _ => false,
                }
        })
}

fn is_uuid(text: &str) -> bool {
    let groups: Vec<&str> = text.split('-').collect();
    groups.len() == 5
        && groups.iter().zip([8, 4, 4, 4, 12]).all(|(g, n)| g.len() == n && g.chars().all(|c| c.is_ascii_hexdigit()))
}

fn is_hextet(part: &str) -> bool {
    (1..=4).contains(&part.len()) && part.chars().all(|c| c.is_ascii_hexdigit())
}

fn is_ipv_future(input: &str) -> bool {
    let Some(rest) = input.strip_prefix(['v', 'V']) else { return false };
    let Some((hex, tail)) = rest.split_once('.') else { return false };
    !hex.is_empty()
        && hex.chars().all(|c| c.is_ascii_hexdigit())
        && !tail.is_empty()
        && tail.chars().all(|c| c.is_ascii_alphanumeric() || "-._~!$&'()*+,;=:".contains(c))
}

fn is_zone_identifier(zone: &[char]) -> bool {
    if zone.is_empty() {
        return false;
    }
    let mut i = 0;
    while i < zone.len() {
        let c = zone[i];
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | '~') {
            i += 1;
            continue;
        }
        if c == '%' && i + 2 < zone.len() && is_hex_pair(&zone[i + 1..i + 3]) {
            i += 3;
            continue;
        }
        return false;
    }
    true
}

fn compress_ipv6_zero_run(hextets: &[String]) -> String {
    let (mut best_start, mut best_length, mut run_start, mut run_length) = (-1i64, 0usize, -1i64, 0usize);
    for (i, hextet) in hextets.iter().enumerate() {
        if hextet == "0" {
            if run_start == -1 {
                run_start = i as i64;
            }
            run_length += 1;
            if run_length > best_length {
                best_length = run_length;
                best_start = run_start;
            }
        } else {
            run_start = -1;
            run_length = 0;
        }
    }
    if best_length < 2 {
        return hextets.join(":");
    }
    let start = best_start as usize;
    format!("{}::{}", hextets[..start].join(":"), hextets[start + best_length..].join(":"))
}

fn normalize_ipv6_address(input: &str) -> Option<String> {
    let compression = input.find("::");
    if let Some(at) = compression {
        if input[at + 1..].contains("::") {
            return None;
        }
    }
    let mut left: Vec<String> = match compression {
        None => input.split(':').map(str::to_string).collect(),
        Some(at) => input[..at].split(':').map(str::to_string).collect(),
    };
    let mut right: Vec<String> = match compression {
        None => Vec::new(),
        Some(at) => input[at + 2..].split(':').map(str::to_string).collect(),
    };
    if compression.is_some() {
        if left.len() == 1 && left[0].is_empty() {
            left.clear();
        }
        if right.len() == 1 && right[0].is_empty() {
            right.clear();
        }
    }
    let left_length = left.len();
    let right_empty = right.is_empty();
    let mut parts: Vec<String> = left.into_iter().chain(right).collect();
    let mut count = 0;
    let last = parts.len().wrapping_sub(1);
    for i in 0..parts.len() {
        let part = parts[i].clone();
        if part.is_empty() {
            return None;
        }
        if part.contains('.') {
            if i != last || (compression.is_some() && right_empty) || !is_ipv4(&part) {
                return None;
            }
            count += 2;
            continue;
        }
        if !is_hextet(&part) {
            return None;
        }
        parts[i] = format!("{:x}", u32::from_str_radix(&part, 16).ok()?);
        count += 1;
    }
    if compression.is_none() {
        if count != 8 {
            return None;
        }
        return Some(compress_ipv6_zero_run(&parts));
    }
    if count >= 8 {
        return None;
    }
    let mut expanded: Vec<String> = parts[..left_length].to_vec();
    for _ in count..8 {
        expanded.push("0".into());
    }
    expanded.extend(parts[left_length..].iter().cloned());
    Some(compress_ipv6_zero_run(&expanded))
}

struct Ipv6Reading {
    host: String,
    escaped: Option<String>,
    is_ipv6: bool,
    is_future: bool,
    error: bool,
}

fn normalize_ipv6(host: &str) -> Ipv6Reading {
    let bracketed = host.starts_with('[') && host.ends_with(']') && !host.is_empty();
    let has_bracket = host.starts_with('[') || host.ends_with(']');
    let plain = |error: bool| Ipv6Reading { host: host.to_string(), escaped: None, is_ipv6: false, is_future: false, error };
    if has_bracket && !bracketed {
        return plain(true);
    }
    let mut input: String = if bracketed {
        let chars: Vec<char> = host.chars().collect();
        chars[1..chars.len() - 1].iter().collect()
    } else {
        host.to_string()
    };
    if bracketed && is_ipv_future(&input) {
        let lower = input.to_lowercase();
        return Ipv6Reading { host: format!("[{lower}]"), escaped: Some(lower), is_ipv6: false, is_future: true, error: false };
    }
    if input.matches(':').count() < 2 {
        return plain(bracketed);
    }
    let mut zone = String::new();
    if let Some(at) = input.find('%') {
        let chars: Vec<char> = input[at..].chars().collect();
        let separator: String = chars.iter().take(3).collect();
        let skip = if separator.to_lowercase() == "%25" { 3 } else { 1 };
        let zone_chars: Vec<char> = chars[skip.min(chars.len())..].to_vec();
        if !is_zone_identifier(&zone_chars) {
            return plain(true);
        }
        zone = zone_chars.iter().collect();
        input.truncate(at);
    }
    match normalize_ipv6_address(&input) {
        None => plain(true),
        Some(address) => Ipv6Reading {
            host: if zone.is_empty() { address.clone() } else { format!("{address}%{zone}") },
            escaped: Some(if zone.is_empty() { address } else { format!("{address}%25{zone}") }),
            is_ipv6: true,
            is_future: false,
            error: false,
        },
    }
}

fn remove_dot_segments(path: &str) -> String {
    let mut input: String = path.to_string();
    let mut output: Vec<String> = Vec::new();
    loop {
        let len = input.chars().count();
        if len == 0 {
            break;
        }
        let at = |i: usize| input.chars().nth(i);
        if len == 1 {
            if input == "." {
                break;
            } else if input == "/" {
                output.push("/".into());
                break;
            } else {
                output.push(input.clone());
                break;
            }
        } else if len == 2 {
            if at(0) == Some('.') {
                if at(1) == Some('.') {
                    break;
                } else if at(1) == Some('/') {
                    input = input[2..].to_string();
                    continue;
                }
            } else if at(0) == Some('/') && (at(1) == Some('.') || at(1) == Some('/')) {
                output.push("/".into());
                break;
            }
        } else if len == 3 && input == "/.." {
            output.pop();
            output.push("/".into());
            break;
        }
        if at(0) == Some('.') {
            if at(1) == Some('.') {
                if at(2) == Some('/') {
                    input = input[3..].to_string();
                    continue;
                }
            } else if at(1) == Some('/') {
                input = input[2..].to_string();
                continue;
            }
        } else if at(0) == Some('/') && at(1) == Some('.') {
            if at(2) == Some('/') {
                input = input[2..].to_string();
                continue;
            } else if at(2) == Some('.') && at(3) == Some('/') {
                input = input[3..].to_string();
                output.pop();
                continue;
            }
        }
        let first = input.chars().next().map_or(0, char::len_utf8);
        match input[first..].find('/') {
            None => {
                output.push(input.clone());
                break;
            }
            Some(offset) => {
                let next = first + offset;
                output.push(input[..next].to_string());
                input = input[next..].to_string();
            }
        }
    }
    output.concat()
}

fn remove_dot_segments_relative(path: &str) -> String {
    if path.is_empty() || path.starts_with('/') {
        return remove_dot_segments(path);
    }
    let segments: Vec<&str> = path.split('/').collect();
    let last = segments.len() - 1;
    let mut output: Vec<String> = Vec::new();
    let mut trailing = false;
    for (i, segment) in segments.iter().enumerate() {
        if *segment == "." || *segment == ".." {
            if *segment == ".." {
                if !output.is_empty() && output.last().map(String::as_str) != Some("..") {
                    output.pop();
                } else {
                    output.push("..".into());
                }
            }
            trailing = i == last;
        } else {
            output.push(segment.to_string());
        }
    }
    if trailing && output.last().map(String::as_str) != Some("..") {
        output.push(String::new());
    }
    if output.is_empty() || output[0].is_empty() || output[0].contains(':') {
        output.insert(0, ".".into());
    }
    output.join("/")
}

fn reescape_host_delimiters(host: &str, is_ip: bool) -> String {
    host.chars()
        .map(|c| match c {
            '@' => "%40".to_string(),
            '/' => "%2F".to_string(),
            '?' => "%3F".to_string(),
            '#' => "%23".to_string(),
            ':' if !is_ip => "%3A".to_string(),
            other => other.to_string(),
        })
        .collect()
}

/// Walk `input`, normalizing each `%XX`, and hand every other character to `other`.
fn percent_walk(input: &str, mut escape: impl FnMut(char) -> Option<char>, mut other: impl FnMut(char, &mut String)) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '%' && i + 2 < chars.len() && is_hex_pair(&chars[i + 1..i + 3]) {
            let hex: String = chars[i + 1..i + 3].iter().collect::<String>().to_uppercase();
            let byte = u8::from_str_radix(&hex, 16).expect("two hex digits");
            match escape(byte as char) {
                Some(decoded) => out.push(decoded),
                None => {
                    out.push('%');
                    out.push_str(&hex);
                }
            }
            i += 3;
            continue;
        }
        other(c, &mut out);
        i += 1;
    }
    out
}

fn normalize_percent_encoding(input: &str, decode_unreserved: bool) -> String {
    if !input.contains('%') {
        return input.to_string();
    }
    percent_walk(input, |c| (decode_unreserved && is_unreserved(c)).then_some(c), |c, out| out.push(c))
}

fn encode_other(c: char, out: &mut String, allowed: impl Fn(char) -> bool, safe: bool) {
    if allowed(c) {
        out.push(c);
    } else if (c as u32) < 0x80 {
        if safe && is_escape_safe(c) {
            out.push(c);
        } else {
            out.push_str(&byte_hex(c as u8));
        }
    } else {
        out.push_str(&percent_encode_char(c));
    }
}

fn normalize_path_encoding(input: &str) -> String {
    percent_walk(input, |c| (c != '.' && is_unreserved(c)).then_some(c), |c, out| encode_other(c, out, is_path_character, true))
}

fn normalize_query_fragment_encoding(input: &str) -> String {
    percent_walk(input, |c| is_unreserved(c).then_some(c), |c, out| encode_other(c, out, is_query_fragment_character, true))
}

fn encode_component(input: &str, allowed: fn(char) -> bool) -> String {
    percent_walk(input, |_| None, |c, out| encode_other(c, out, allowed, false))
}

fn serialize_path_encoding(input: &str, path_no_scheme: bool) -> String {
    let mut first_segment = path_no_scheme && !input.starts_with('/');
    percent_walk(input, |_| None, |c, out| {
        if c == '/' {
            first_segment = false;
        }
        if is_path_character(c) && (c != ':' || !first_segment) {
            out.push(c);
        } else if (c as u32) < 0x80 {
            out.push_str(&byte_hex(c as u8));
        } else {
            out.push_str(&percent_encode_char(c));
        }
    })
}

fn port_text(port: &Port) -> String {
    match port {
        Port::Number(n) => n.to_string(),
        Port::Text(t) => t.clone(),
    }
}

fn recompose_authority(component: &Components) -> Result<Option<String>, String> {
    let mut tokens = String::new();
    let mut any = false;
    if let Some(userinfo) = &component.userinfo {
        tokens.push_str(&encode_component(userinfo, is_userinfo_character));
        tokens.push('@');
        any = true;
    }
    if let Some(host) = &component.host {
        let mut host = host.clone();
        if !is_ipv4(&host) {
            let mut reading = normalize_ipv6(&host);
            if !reading.is_ipv6 && !reading.is_future {
                host = normalize_percent_encoding(&host, true);
                reading = normalize_ipv6(&host);
            }
            host = if reading.is_ipv6 || reading.is_future {
                format!("[{}]", reading.escaped.unwrap_or_default())
            } else {
                reescape_host_delimiters(&host, false)
            };
        }
        tokens.push_str(&host);
        any = true;
    }
    if let Some(port) = &component.port {
        let text = port_text(port);
        if !text.chars().all(|c| c.is_ascii_digit()) {
            return Err("URI port is malformed.".into());
        }
        tokens.push(':');
        tokens.push_str(&text);
        any = true;
    }
    Ok(any.then_some(tokens))
}

fn has_malformed_percent_encoding(component: Option<&str>) -> bool {
    let Some(text) = component else { return false };
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '%' {
            if i + 2 >= chars.len() || !is_hex_pair(&chars[i + 1..i + 3]) {
                return true;
            }
            i += 3;
            continue;
        }
        i += 1;
    }
    false
}

fn is_ip_literal(host: &str) -> bool {
    host.starts_with('[') && host.ends_with(']')
}

fn forbidden_domain_host(host: &str) -> bool {
    host.chars().any(|c| (c as u32) <= 0x20 || "\"#/:<>?@[\\]^`{|}\u{7f}".contains(c))
}

fn non_simple_domain(host: &str) -> bool {
    host.chars().any(|c| !(c.is_ascii_lowercase() || "!\"$&'()*+,-.;=_`{}~".contains(c)))
}

fn has_forbidden_domain_host(parsed: &Components, handler: Option<Scheme>, is_ip: bool) -> bool {
    parsed.host.as_deref().is_some_and(|host| {
        !host.is_empty() && !is_ip && !is_ip_literal(host) && handler.is_some_and(Scheme::domain_host) && forbidden_domain_host(host)
    })
}

fn canonicalize_host(parsed: &mut Components, handler: Option<Scheme>, is_ip: bool) -> bool {
    if has_forbidden_domain_host(parsed, handler, is_ip) {
        parsed.error.get_or_insert_with(|| MALFORMED_HOST_ERROR.into());
        return true;
    }
    let Some(host) = parsed.host.clone() else { return false };
    if !host.is_empty() && !is_ip_literal(&host) && handler.is_some_and(Scheme::domain_host) && !is_ip && non_simple_domain(&host) {
        match url::Url::parse(&format!("http://{host}")) {
            Err(_) => {
                parsed.error.get_or_insert_with(|| "Host's domain name can not be converted to ASCII: TypeError: Invalid URL".into());
                return true;
            }
            Ok(url) => {
                let host_only = url.username().is_empty()
                    && url.password().is_none()
                    && url.port().is_none()
                    && url.path() == "/"
                    && url.query().is_none()
                    && url.fragment().is_none()
                    && url.host_str().is_some_and(|h| !h.is_empty());
                if !host_only {
                    parsed.error.get_or_insert_with(|| MALFORMED_HOST_ERROR.into());
                    return true;
                }
                parsed.host = url.host_str().map(str::to_string);
            }
        }
    }
    false
}

/// `URI_PARSE`'s captures, read as its greedy, ordered alternatives read them.
struct Captures {
    scheme: Option<String>,
    authority: bool,
    userinfo: Option<String>,
    host: Option<String>,
    port: Option<String>,
    path: String,
    query: Option<String>,
    fragment: Option<String>,
}

fn match_uri(uri: &str) -> Captures {
    let chars: Vec<char> = uri.chars().collect();
    let mut at = 0;
    let mut scheme = None;
    let end = chars.iter().position(|c| "#/:?".contains(*c)).unwrap_or(chars.len());
    if end > 0 && chars.get(end) == Some(&':') {
        scheme = Some(chars[..end].iter().collect());
        at = end + 1;
    }
    let (mut authority, mut userinfo, mut host, mut port) = (false, None, None, None);
    if chars.get(at) == Some(&'/') && chars.get(at + 1) == Some(&'/') {
        authority = true;
        at += 2;
        let stop = chars[at..].iter().position(|c| "#/?@".contains(*c)).map_or(chars.len(), |p| at + p);
        if chars.get(stop) == Some(&'@') {
            userinfo = Some(chars[at..stop].iter().collect());
            at = stop + 1;
        }
        let mut bracket = None;
        if chars.get(at) == Some(&'[') {
            let close = chars[at + 1..].iter().position(|c| "#/?]".contains(*c)).map(|p| at + 1 + p);
            if let Some(close) = close {
                if chars[close] == ']' && close > at + 1 {
                    bracket = Some(close + 1);
                }
            }
        }
        let host_end = bracket.unwrap_or_else(|| chars[at..].iter().position(|c| "#/:?".contains(*c)).map_or(chars.len(), |p| at + p));
        host = Some(chars[at..host_end].iter().collect());
        at = host_end;
        if chars.get(at) == Some(&':') {
            let digits = chars[at + 1..].iter().take_while(|c| c.is_ascii_digit()).count();
            port = Some(chars[at + 1..at + 1 + digits].iter().collect());
            at += 1 + digits;
        }
    }
    let path_end = chars[at..].iter().position(|c| *c == '#' || *c == '?').map_or(chars.len(), |p| at + p);
    let path: String = chars[at..path_end].iter().collect();
    at = path_end;
    let mut query = None;
    if chars.get(at) == Some(&'?') {
        let end = chars[at + 1..].iter().position(|c| *c == '#').map_or(chars.len(), |p| at + 1 + p);
        query = Some(chars[at + 1..end].iter().collect());
        at = end;
    }
    let mut fragment = None;
    if chars.get(at) == Some(&'#') {
        let end = chars[at + 1..].iter().position(|c| *c == '\u{2028}' || *c == '\u{2029}').map_or(chars.len(), |p| at + 1 + p);
        fragment = Some(chars[at + 1..end].iter().collect());
    }
    Captures { scheme, authority, userinfo, host, port, path, query, fragment }
}

fn authority_checks(uri: &str, parsed: &mut Components) -> bool {
    let mut malformed = false;
    let chars: Vec<char> = uri.chars().collect();
    let scheme_end = {
        let end = chars.iter().position(|c| "#/:?".contains(*c)).unwrap_or(chars.len());
        if end > 0 && chars.get(end) == Some(&':') { end + 1 } else { 0 }
    };
    if chars.get(scheme_end) == Some(&'/') && chars.get(scheme_end + 1) == Some(&'/') {
        let start = scheme_end + 2;
        let stop = chars[start..].iter().position(|c| "/?#".contains(*c)).map_or(chars.len(), |p| start + p);
        if chars[start..stop].contains(&'\\') {
            parsed.error = Some("URI authority must not contain a literal backslash.".into());
            malformed = true;
        }
    }
    let region: String = chars[scheme_end..].iter().take_while(|c| "/\\\t\n\r".contains(**c)).collect();
    let normalized: String = region.chars().filter(|c| !"\t\n\r".contains(*c)).collect();
    if normalized.chars().count() >= 2 {
        if !normalized.starts_with("//") {
            parsed.error.get_or_insert_with(|| "URI authority must not contain a literal backslash.".into());
            malformed = true;
        } else if region.len() != normalized.len() {
            parsed.error.get_or_insert_with(|| "URI authority introducer must not contain whitespace.".into());
            malformed = true;
        }
    }
    malformed
}

fn parse_with_status(uri: &str, scheme_null: bool) -> Status {
    let mut parsed = Components { host: Some(String::new()), path: Some(String::new()), ..Default::default() };
    let mut malformed = authority_checks(uri, &mut parsed);
    let captures = match_uri(uri);
    parsed.scheme = captures.scheme.clone();
    parsed.userinfo = captures.userinfo.clone();
    parsed.host = captures.host.clone();
    parsed.port = captures.port.as_ref().map(|digits| match digits.parse::<u64>() {
        Ok(n) if !digits.is_empty() => Port::Number(n),
        _ => Port::Text(digits.clone()),
    });
    parsed.path = Some(captures.path.clone());
    parsed.query = captures.query.clone();
    parsed.fragment = captures.fragment.clone();
    if let Some(scheme) = &parsed.scheme {
        if is_valid_scheme(scheme) {
            parsed.scheme = Some(scheme.to_lowercase());
        } else {
            parsed.error.get_or_insert_with(|| MALFORMED_SCHEME_ERROR.into());
            malformed = true;
        }
    }
    let host_capture = captures.host.as_deref();
    let percent = has_malformed_percent_encoding(captures.userinfo.as_deref())
        || host_capture.is_some_and(|h| !is_ip_literal(h) && has_malformed_percent_encoding(Some(h)))
        || has_malformed_percent_encoding(Some(&captures.path))
        || has_malformed_percent_encoding(captures.query.as_deref())
        || has_malformed_percent_encoding(captures.fragment.as_deref());
    if percent {
        parsed.error.get_or_insert_with(|| "URI contains malformed percent-encoding.".into());
        malformed = true;
    }
    let path_bad = captures.authority && !captures.path.is_empty() && !captures.path.starts_with('/');
    let port_bad = matches!(parsed.port, Some(Port::Number(n)) if n > 65535);
    if path_bad || port_bad {
        parsed.error.get_or_insert_with(|| {
            if path_bad { "URI path must start with \"/\" when authority is present." } else { "URI port is malformed." }.into()
        });
        malformed = true;
    }
    let mut is_ip = false;
    let mut malformed_literal = false;
    if let Some(host) = parsed.host.clone().filter(|h| !h.is_empty()) {
        if is_ipv4(&host) {
            is_ip = true;
        } else {
            let bracketed = is_ip_literal(&host);
            let has_bracket = host.contains('[') || host.contains(']');
            let reading = normalize_ipv6(&host);
            is_ip = reading.is_ipv6 || reading.is_future;
            malformed_literal = has_bracket && (!bracketed || reading.error);
            parsed.host = Some(if is_ip { reading.host } else { reading.host.to_lowercase() });
            if malformed_literal {
                parsed.error.get_or_insert_with(|| MALFORMED_HOST_ERROR.into());
                malformed = true;
            }
        }
    }
    let handler = if scheme_null { None } else { scheme_handler(parsed.scheme.as_deref()) };
    if !malformed_literal && canonicalize_host(&mut parsed, handler, is_ip) {
        malformed = true;
    }
    if uri.contains('%') && !malformed_literal {
        if let Some(host) = parsed.host.clone() {
            let mut host = if is_ip { host } else { normalize_percent_encoding(&host, true) };
            if !is_ip {
                host = normalize_percent_encoding(&host.to_lowercase(), false);
            }
            parsed.host = Some(if is_ip || !scheme_null { reescape_host_delimiters(&host, is_ip) } else { host });
        }
    }
    let skip_normalize = matches!(handler, Some(Scheme::Urn | Scheme::UrnUuid));
    if !skip_normalize {
        if let Some(path) = parsed.path.as_ref().filter(|p| !p.is_empty()) {
            parsed.path = Some(normalize_path_encoding(path));
        }
        if let Some(query) = parsed.query.as_ref().filter(|q| !q.is_empty()) {
            parsed.query = Some(normalize_query_fragment_encoding(query));
        }
        if let Some(fragment) = parsed.fragment.as_ref().filter(|f| !f.is_empty()) {
            parsed.fragment = Some(normalize_query_fragment_encoding(fragment));
        }
    }
    match handler {
        Some(Scheme::Http | Scheme::Https) => {
            if parsed.host.as_deref().is_none_or(str::is_empty) {
                parsed.error.get_or_insert_with(|| "HTTP URIs must have a host.".into());
            }
        }
        Some(Scheme::Ws | Scheme::Wss) => {
            parsed.secure = Some(ws_is_secure(&parsed));
            let path = parsed.path.clone().filter(|p| !p.is_empty()).unwrap_or_else(|| "/".into());
            let query = parsed.query.clone().filter(|q| !q.is_empty());
            parsed.resource_name = Some(match query {
                Some(q) => format!("{path}?{q}"),
                None => path,
            });
            parsed.path = None;
            parsed.query = None;
        }
        Some(Scheme::Urn | Scheme::UrnUuid) => {
            urn_parse(&mut parsed);
            if parsed.nid.is_none() {
                malformed = true;
            }
        }
        None => {}
    }
    Status { parsed, malformed }
}

fn ws_is_secure(component: &Components) -> bool {
    match component.secure {
        Some(secure) => secure,
        None => component.scheme.as_deref().is_some_and(|s| s.eq_ignore_ascii_case("wss")),
    }
}

/// A character `[\d\-a-z]` / `\w` admits under the `iu` flags: ASCII, plus the two
/// characters whose case folding reaches an ASCII letter.
fn folds_to_ascii_word(c: char) -> bool {
    c == '\u{17f}' || c == '\u{212a}'
}

fn urn_nid(nid: &str) -> bool {
    let mut chars = nid.chars();
    let lead = |c: char| c.is_ascii_alphanumeric() || folds_to_ascii_word(c);
    nid.chars().count() <= 32 && chars.next().is_some_and(lead) && chars.all(|c| lead(c) || c == '-')
}

fn urn_nss(nss: &str) -> bool {
    let chars: Vec<char> = nss.chars().collect();
    if chars.is_empty() {
        return false;
    }
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_ascii_alphanumeric() || folds_to_ascii_word(c) || "_!$'()*+,-./:;=@".contains(c) {
            i += 1;
        } else if c == '%' && i + 3 <= chars.len() && is_hex_pair(&chars[i + 1..i + 3]) {
            i += 3;
        } else {
            return false;
        }
    }
    true
}

fn urn_parse(component: &mut Components) {
    let Some(path) = component.path.clone().filter(|p| !p.is_empty()) else {
        component.error = Some("URN can not be parsed".into());
        return;
    };
    let reading = path.split_once(':').filter(|(nid, nss)| urn_nid(nid) && urn_nss(nss));
    match reading {
        Some((nid, nss)) => {
            let nid = nid.to_lowercase();
            component.nid = Some(nid.clone());
            component.nss = Some(nss.to_string());
            component.path = None;
            let scheme = component.scheme.clone().unwrap_or_else(|| "urn".into());
            if scheme_handler(Some(&format!("{scheme}:{nid}"))) == Some(Scheme::UrnUuid) {
                component.uuid = component.nss.take();
                if !component.uuid.as_deref().is_some_and(is_uuid) {
                    component.error.get_or_insert_with(|| "UUID is not valid.".into());
                }
            }
        }
        None => {
            component.error.get_or_insert_with(|| "URN can not be parsed.".into());
        }
    }
}

/// `parse(uri)`.
pub fn parse(uri: &str) -> Components {
    parse_with_status(uri, false).parsed
}

struct SerializeOptions {
    scheme_null: bool,
    skip_escape: bool,
}

fn serialize_with(component: &Components, options: SerializeOptions) -> Result<String, String> {
    let mut component = component.clone();
    component.error = None;
    let mut skip_escape = options.skip_escape;
    if let Some(scheme) = &component.scheme {
        component.scheme = Some(validate_scheme(scheme)?);
    }
    let handler = if options.scheme_null { None } else { scheme_handler(component.scheme.as_deref()) };
    match handler {
        Some(Scheme::Http | Scheme::Https) => {
            let secure = component.scheme.as_deref().is_some_and(|s| s.eq_ignore_ascii_case("https"));
            if component.port == Some(Port::Number(if secure { 443 } else { 80 })) || component.port == Some(Port::Text(String::new())) {
                component.port = None;
            }
            if component.path.as_deref().is_none_or(str::is_empty) {
                component.path = Some("/".into());
            }
        }
        Some(Scheme::Ws | Scheme::Wss) => {
            let secure = ws_is_secure(&component);
            if component.port == Some(Port::Number(if secure { 443 } else { 80 })) || component.port == Some(Port::Text(String::new())) {
                component.port = None;
            }
            if let Some(secure) = component.secure.take() {
                component.scheme = Some(if secure { "wss" } else { "ws" }.into());
            }
            if let Some(resource) = component.resource_name.take().filter(|r| !r.is_empty()) {
                let (path, query) = match resource.split_once('?') {
                    Some((p, q)) => (p.to_string(), Some(q.to_string())),
                    None => (resource.clone(), None),
                };
                component.path = (!path.is_empty() && path != "/").then_some(path);
                component.query = query;
            }
            component.fragment = None;
        }
        Some(Scheme::Urn | Scheme::UrnUuid) => {
            let Some(nid) = component.nid.clone() else {
                return Err("URN without nid cannot be serialized".into());
            };
            let nid = nid.to_lowercase();
            let scheme = component.scheme.clone().unwrap_or_else(|| "urn".into());
            if scheme_handler(Some(&format!("{scheme}:{nid}"))) == Some(Scheme::UrnUuid) {
                component.nss = Some(component.uuid.clone().unwrap_or_default().to_lowercase());
            }
            component.path = Some(format!("{nid}:{}", component.nss.clone().unwrap_or_else(|| "undefined".into())));
            skip_escape = true;
        }
        None => {}
    }
    let has_authority = component.userinfo.is_some() || component.host.is_some() || component.port.is_some();
    let schemeless = component.scheme.is_none() && !has_authority;
    let path_no_scheme = !skip_escape && schemeless;
    if let Some(path) = &component.path {
        component.path = Some(if !skip_escape { serialize_path_encoding(path, path_no_scheme) } else { normalize_percent_encoding(path, false) });
    }
    let mut out = String::new();
    if let Some(scheme) = &component.scheme {
        out.push_str(&validate_scheme(scheme)?);
        out.push(':');
    }
    let authority = recompose_authority(&component)?;
    if let Some(authority) = &authority {
        out.push_str("//");
        out.push_str(authority);
        if component.path.as_deref().is_some_and(|p| !p.is_empty() && !p.starts_with('/')) {
            out.push('/');
        }
    }
    if let Some(path) = &component.path {
        let mut s = if schemeless && !path.starts_with('/') { remove_dot_segments_relative(path) } else { remove_dot_segments(path) };
        if schemeless {
            s = serialize_path_encoding(&s, true);
        }
        if authority.is_none() && s.starts_with("//") {
            s = format!("/%2F{}", &s[2..]);
        }
        out.push_str(&s);
    }
    if let Some(query) = &component.query {
        out.push('?');
        out.push_str(&encode_component(query, is_query_fragment_character));
    }
    if let Some(fragment) = &component.fragment {
        out.push('#');
        out.push_str(&encode_component(fragment, is_query_fragment_character));
    }
    Ok(out)
}

/// `serialize(components)`.
pub fn serialize(component: &Components) -> Result<String, String> {
    serialize_with(component, SerializeOptions { scheme_null: false, skip_escape: false })
}

fn resolve_component(base: &Components, relative: &Components) -> Components {
    let mut target = Components::default();
    if relative.scheme.is_some() {
        target.scheme = relative.scheme.clone();
        target.userinfo = relative.userinfo.clone();
        target.host = relative.host.clone();
        target.port = relative.port.clone();
        target.path = Some(remove_dot_segments(relative.path.as_deref().unwrap_or("")));
        target.query = relative.query.clone();
    } else {
        if relative.userinfo.is_some() || relative.host.is_some() || relative.port.is_some() {
            target.userinfo = relative.userinfo.clone();
            target.host = relative.host.clone();
            target.port = relative.port.clone();
            target.path = Some(remove_dot_segments(relative.path.as_deref().unwrap_or("")));
            target.query = relative.query.clone();
        } else {
            match relative.path.as_deref().filter(|p| !p.is_empty()) {
                None => {
                    target.path = base.path.clone();
                    target.query = if relative.query.is_some() { relative.query.clone() } else { base.query.clone() };
                }
                Some(path) => {
                    if path.starts_with('/') {
                        target.path = Some(remove_dot_segments(path));
                    } else {
                        let base_authority = base.userinfo.is_some() || base.host.is_some() || base.port.is_some();
                        let base_path = base.path.as_deref().unwrap_or("");
                        let merged = if base_authority && base_path.is_empty() {
                            format!("/{path}")
                        } else if base_path.is_empty() {
                            path.to_string()
                        } else {
                            format!("{}{path}", &base_path[..base_path.rfind('/').map_or(0, |i| i + 1)])
                        };
                        target.path = Some(if base.scheme.is_none() && !base_authority && !merged.starts_with('/') {
                            remove_dot_segments_relative(&merged)
                        } else {
                            remove_dot_segments(&merged)
                        });
                    }
                    target.query = relative.query.clone();
                }
            }
            target.userinfo = base.userinfo.clone();
            target.host = base.host.clone();
            target.port = base.port.clone();
        }
        target.scheme = base.scheme.clone();
    }
    target.fragment = relative.fragment.clone();
    target
}

/// `resolve(base, relative)`, or the message it throws.
pub fn resolve(base: &str, relative: &str) -> Result<String, String> {
    let base = parse_with_status(base, true);
    let relative = parse_with_status(relative, true);
    if base.malformed || relative.malformed {
        return Err(base.parsed.error.clone().or_else(|| relative.parsed.error.clone()).unwrap_or_else(|| "URI is malformed.".into()));
    }
    let mut resolved = resolve_component(&base.parsed, &relative.parsed);
    let handler = scheme_handler(resolved.scheme.as_deref());
    let host = resolved.host.clone();
    let is_ip = host.as_deref().is_some_and(|h| !h.is_empty() && (is_ipv4(h) || normalize_ipv6(h).is_ipv6));
    if has_forbidden_domain_host(&resolved, handler, is_ip) {
        return Err(MALFORMED_HOST_ERROR.into());
    }
    canonicalize_host(&mut resolved, handler, is_ip);
    let encoded_ascii_host = host.as_deref().is_some_and(|h| h.contains('%') && h.is_ascii());
    if let Some(error) = &resolved.error {
        if !encoded_ascii_host {
            return Err(error.clone());
        }
    }
    serialize_with(&resolved, SerializeOptions { scheme_null: true, skip_escape: true })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_as_fast_uri_does() {
        assert_eq!(resolve("http://example.com/b/c.json", "d.json").unwrap(), "http://example.com/b/d.json");
        assert_eq!(resolve("", "#/definitions/a").unwrap(), "#/definitions/a");
        assert_eq!(resolve("http://example.com/ref/absref.json", "/absref/foobar.json").unwrap(), "http://example.com/absref/foobar.json");
        assert_eq!(resolve("urn:uuid:deadbeef-1234-ffff-ffff-4321feebdaed", "#/definitions/bar").unwrap(), "urn:uuid:deadbeef-1234-ffff-ffff-4321feebdaed#/definitions/bar");
        assert_eq!(serialize(&parse("http://example.com")).unwrap(), "http://example.com/");
        assert_eq!(serialize(&parse("telo:Acme/Port")).unwrap(), "telo:Acme/Port");
    }
}
