//! The two origins a window loads and the decision "does this URL stay in the window".
//!
//! The helper decides alone, from `origin` and `hostOrigin` of `Helper.Init`: the
//! application's origin and the host's own pages. Scheme, host and port must all
//! match one of them. The reading follows the WHATWG URL parser where it matters
//! for a decision (ASCII tab / newline removal, `\` ending the authority, default
//! ports, case-insensitive scheme and host) and is **conservative everywhere else**:
//! a URL it cannot read as `scheme://authority…` is external, as is any authority
//! with userinfo, a trailing-dot host or a port it cannot read. Wrongly keeping a
//! URL out of the window costs a browser tab; wrongly keeping one in costs the
//! admission boundary.
//!
//! No Node twin: this crate has none (see `lib.rs`).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Scheme {
    Http,
    Https,
}

impl Scheme {
    fn name(self) -> &'static str {
        match self {
            Scheme::Http => "http",
            Scheme::Https => "https",
        }
    }

    fn default_port(self) -> u16 {
        match self {
            Scheme::Http => 80,
            Scheme::Https => 443,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Origin {
    scheme: Scheme,
    host: String,
    port: u16,
}

/// Where a URL a webview wants to load goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Destination {
    /// `about:blank`, the initial document of a window.
    Blank,
    /// The application's origin.
    App,
    /// The host's own pages: admission, the startup window, the sign-in form.
    Host,
    /// Anywhere else; it never loads in the window.
    External,
}

/// The application's origin and the host's, which a window both loads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Origins {
    pub app: Origin,
    pub host: Origin,
}

impl Origins {
    /// Two distinct origins; the same one twice could not tell the host's pages from the app's.
    pub fn new(app: Origin, host: Origin) -> Result<Origins, String> {
        if app == host {
            return Err(format!("the host origin {} is the application's origin", host.text()));
        }
        Ok(Origins { app, host })
    }

    pub fn classify(&self, url: &str) -> Destination {
        let cleaned = clean(url);
        if cleaned.eq_ignore_ascii_case("about:blank") {
            return Destination::Blank;
        }
        match origin_of(&cleaned) {
            Some(candidate) if candidate == self.app => Destination::App,
            Some(candidate) if candidate == self.host => Destination::Host,
            _ => Destination::External,
        }
    }
}

impl Origin {
    /// Reads an origin as the host writes it: `http://127.0.0.1:53817`, with no
    /// userinfo, path, query or fragment.
    pub fn parse(text: &str) -> Result<Origin, String> {
        let (origin, rest) = read_origin(text).ok_or_else(|| format!("'{text}' is not an http or https origin"))?;
        if !(rest.is_empty()) {
            return Err(format!("'{text}' is not an origin: it carries '{rest}' after the authority"));
        }
        Ok(origin)
    }

    /// `scheme://host:port`, the port always written.
    pub fn text(&self) -> String {
        format!("{}://{}:{}", self.scheme.name(), self.host, self.port)
    }
}

/// The URL with what the URL parser drops before reading it removed: leading and
/// trailing C0 controls and spaces, and every ASCII tab and newline.
fn clean(url: &str) -> String {
    let trimmed = url.trim_matches(|c: char| c <= ' ');
    trimmed.chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect()
}

fn origin_of(url: &str) -> Option<Origin> {
    let colon = url.find(':')?;
    let scheme = &url[..colon];
    if scheme.eq_ignore_ascii_case("blob") {
        // `blob:<origin>/<uuid>` belongs to the origin that created it; one level only.
        let inner = &url[colon + 1..];
        let inner_colon = inner.find(':')?;
        if inner[..inner_colon].eq_ignore_ascii_case("blob") {
            return None;
        }
        return origin_of(inner);
    }
    read_origin(url).map(|(origin, _)| origin)
}

/// The origin a `scheme://authority` prefix names, and what follows the authority.
fn read_origin(url: &str) -> Option<(Origin, &str)> {
    let colon = url.find(':')?;
    let scheme = match &url[..colon] {
        s if s.eq_ignore_ascii_case("http") => Scheme::Http,
        s if s.eq_ignore_ascii_case("https") => Scheme::Https,
        _ => return None,
    };
    let after = url[colon + 1..].strip_prefix("//")?;
    let end = after.find(['/', '\\', '?', '#']).unwrap_or(after.len());
    let (authority, rest) = after.split_at(end);
    if authority.contains('@') {
        return None;
    }
    let (host, port_text) = split_host_port(authority)?;
    if host.is_empty() || !host.is_ascii() || host.contains(['%', ' ']) {
        return None;
    }
    let port = match port_text {
        None | Some("") => scheme.default_port(),
        Some(digits) => {
            if !digits.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            // Leading zeros are the same number to a URL parser.
            let trimmed = digits.trim_start_matches('0');
            if trimmed.len() > 5 {
                return None;
            }
            if trimmed.is_empty() { 0 } else { trimmed.parse::<u16>().ok()? }
        }
    };
    Some((Origin { scheme, host: host.to_ascii_lowercase(), port }, rest))
}

fn split_host_port(authority: &str) -> Option<(&str, Option<&str>)> {
    if let Some(inner) = authority.strip_prefix('[') {
        let close = inner.find(']')?;
        let host = &authority[..close + 2];
        return match &inner[close + 1..] {
            "" => Some((host, None)),
            rest => Some((host, Some(rest.strip_prefix(':')?))),
        };
    }
    match authority.matches(':').count() {
        0 => Some((authority, None)),
        1 => {
            let (host, port) = authority.split_once(':')?;
            Some((host, Some(port)))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn origin() -> Origin {
        Origin::parse("http://127.0.0.1:53817").unwrap()
    }

    fn origins() -> Origins {
        Origins::new(origin(), Origin::parse("http://127.0.0.1:53900").unwrap()).unwrap()
    }

    #[test]
    fn parses_and_writes_an_origin() {
        assert_eq!(origin().text(), "http://127.0.0.1:53817");
        assert_eq!(Origin::parse("HTTPS://Example.COM").unwrap().text(), "https://example.com:443");
        assert_eq!(Origin::parse("http://[::1]:8080").unwrap().text(), "http://[::1]:8080");
    }

    #[test]
    fn refuses_what_is_not_an_origin() {
        for text in ["", "127.0.0.1:1", "ftp://127.0.0.1:1", "http://127.0.0.1:1/x", "http://u@127.0.0.1:1", "http://127.0.0.1:99999", "http://", "http://a:b"] {
            assert!(Origin::parse(text).is_err(), "{text}");
        }
    }

    #[test]
    fn the_decision_table() {
        use Destination::*;
        let o = origins();
        let table: &[(&str, Destination)] = &[
            // The application's origin.
            ("http://127.0.0.1:53817", App),
            ("http://127.0.0.1:53817/", App),
            ("http://127.0.0.1:53817/settings?x=1#f", App),
            ("HTTP://127.0.0.1:53817/a", App),
            ("http://127.0.0.1:053817/a", App),
            ("http://127.0.0.1:53817\\a", App),
            ("  http://127.0.0.1:53817/a\n", App),
            ("http://127.0.0.1:538\t17/a", App),
            ("blob:http://127.0.0.1:53817/5f1c", App),
            // The host's own pages.
            ("http://127.0.0.1:53900/admit?code=c", Host),
            ("http://127.0.0.1:053900/startup", Host),
            ("HTTP://127.0.0.1:53900", Host),
            ("blob:http://127.0.0.1:53900/5f1c", Host),
            ("http://127.0.0.1:53900@evil.com/", External),
            ("https://127.0.0.1:53900/", External),
            ("http://localhost:53900/", External),
            // The initial document.
            ("about:blank", Blank),
            ("ABOUT:BLANK", Blank),
            // Another port, scheme or host.
            ("http://127.0.0.1:53818/", External),
            ("http://127.0.0.1/", External),
            ("http://127.0.0.1:/", External),
            ("https://127.0.0.1:53817/", External),
            ("http://localhost:53817/", External),
            ("http://[::1]:53817/", External),
            ("http://example.com/", External),
            ("http://127.0.0.1:53817.evil.com/", External),
            ("http://127.0.0.1.evil.com:53817/", External),
            // Userinfo tricks.
            ("http://127.0.0.1:1@evil.com/", External),
            ("http://127.0.0.1:53817@evil.com/", External),
            ("http://evil.com\\@127.0.0.1:53817/", External),
            ("http://user@127.0.0.1:53817/", External),
            // Trailing dot, case of the host does not matter but a dot does.
            ("http://127.0.0.1.:53817/", External),
            // Malformed or other schemes.
            ("http:127.0.0.1:53817/", External),
            ("http:/127.0.0.1:53817/", External),
            ("//127.0.0.1:53817/", External),
            ("/settings", External),
            ("mailto:a@b.c", External),
            ("file:///etc/passwd", External),
            ("javascript:alert(1)", External),
            ("data:text/html,<p>", External),
            ("blob:http://evil.com/5f1c", External),
            ("blob:blob:http://127.0.0.1:53817/5f1c", External),
            ("http://127.0.0.1:53817:1/", External),
            ("http://127.0.0.1:%35/", External),
            ("", External),
        ];
        for (url, expected) in table {
            assert_eq!(o.classify(url), *expected, "{url}");
        }
    }

    #[test]
    fn default_ports_match_an_origin_written_with_them() {
        let o = Origins::new(Origin::parse("http://example.com:80").unwrap(), origin()).unwrap();
        assert_eq!(o.classify("http://example.com/"), Destination::App);
        assert_eq!(o.classify("http://EXAMPLE.com:80/"), Destination::App);
        assert_eq!(o.classify("https://example.com/"), Destination::External);
    }

    #[test]
    fn the_two_origins_must_differ() {
        assert!(Origins::new(origin(), Origin::parse("HTTP://127.0.0.1:053817").unwrap()).is_err());
    }
}
