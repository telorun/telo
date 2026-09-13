//! The package-URL grammar a controller candidate is written in:
//! `pkg:<type>/<namespace…>/<name>@<version>?<qualifiers>#<subpath>`.
//!
//! No Node twin: the Node loaders parse with the `packageurl-js` library. This
//! kernel hand-rolls the grammar rather than taking a dependency for it, and two
//! loaders read it, so it lives once here. Components are percent-decoded, as
//! the library decodes them; a malformed escape makes the PURL unparseable.

use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Purl {
    /// `cargo`, `telo`, `npm`, …
    pub purl_type: String,
    /// The segments between type and name, joined with `/` (`local` for a
    /// bundled `pkg:telo` controller).
    pub namespace: Option<String>,
    pub name: String,
    pub version: Option<String>,
    pub qualifiers: HashMap<String, String>,
    /// The `#fragment`: the controller entry a candidate selects.
    pub subpath: Option<String>,
}

impl Purl {
    pub fn parse(purl: &str) -> Option<Self> {
        let rest = purl.strip_prefix("pkg:")?;
        let (rest, subpath) = match rest.split_once('#') {
            Some((head, subpath)) => (head, Some(decode(subpath)?)),
            None => (rest, None),
        };
        let (rest, query) = match rest.split_once('?') {
            Some((head, query)) => (head, Some(query)),
            None => (rest, None),
        };
        // A version follows the last `@` of the final segment only, so an npm
        // scope (`@telorun/sdk`) is never read as one.
        let last_slash = rest.rfind('/')?;
        let (rest, version) = match rest[last_slash..].rfind('@') {
            Some(at) => (&rest[..last_slash + at], Some(decode(&rest[last_slash + at + 1..])?)),
            None => (rest, None),
        };
        let mut segments = rest.split('/');
        let purl_type = segments.next().filter(|t| !t.is_empty())?.to_ascii_lowercase();
        let mut path: Vec<String> = segments.map(decode).collect::<Option<_>>()?;
        let name = path.pop().filter(|name| !name.is_empty())?;
        let namespace = (!path.is_empty()).then(|| path.join("/"));

        let mut qualifiers = HashMap::new();
        for pair in query.unwrap_or("").split('&').filter(|pair| !pair.is_empty()) {
            if let Some((key, value)) = pair.split_once('=') {
                qualifiers.insert(decode(key)?, decode(value)?);
            }
        }
        Some(Self {
            purl_type,
            namespace,
            name,
            version,
            qualifiers,
            subpath,
        })
    }
}

fn decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::Purl;

    #[test]
    fn parses_type_namespace_name_qualifiers_and_subpath() {
        let cargo =
            Purl::parse("pkg:cargo/telorun-console?local_path=./rust#writeline_controller").unwrap();
        assert_eq!(cargo.purl_type, "cargo");
        assert_eq!(cargo.namespace, None);
        assert_eq!(cargo.name, "telorun-console");
        assert_eq!(cargo.qualifiers["local_path"], "./rust");
        assert_eq!(cargo.subpath.as_deref(), Some("writeline_controller"));

        let dylib = Purl::parse(
            "pkg:telo/local/dylib?path=./rust/lib%20x.so&os=linux&abi=telo-2#writeline_controller",
        )
        .unwrap();
        assert_eq!((dylib.purl_type.as_str(), dylib.namespace.as_deref()), ("telo", Some("local")));
        assert_eq!(dylib.name, "dylib");
        assert_eq!(dylib.qualifiers["path"], "./rust/lib x.so");
        assert_eq!(dylib.qualifiers["abi"], "telo-2");

        let npm = Purl::parse("pkg:npm/@telorun/sdk@1.2.0?local_path=./nodejs#x").unwrap();
        assert_eq!(npm.namespace.as_deref(), Some("@telorun"));
        assert_eq!((npm.name.as_str(), npm.version.as_deref()), ("sdk", Some("1.2.0")));
        assert!(Purl::parse("pkg:telo/local/dylib?path=%zz").is_none());
    }
}
