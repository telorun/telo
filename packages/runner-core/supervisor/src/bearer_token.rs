//! Judging the `Authorization: Bearer <token>` of a connection. No Node twin —
//! the crate runs where no runtime is (see the crate README).

#[derive(Debug, PartialEq, Eq)]
pub enum Credential {
    /// No header, another scheme, or an empty token: closed `4401`.
    Missing,
    /// A bearer token that is not this container's: closed `4403`.
    Invalid,
    Valid,
}

pub fn judge(header: Option<&[u8]>, token: &[u8]) -> Credential {
    let Some(header) = header else {
        return Credential::Missing;
    };
    const SCHEME: &[u8] = b"bearer ";
    if header.len() <= SCHEME.len() || !header[..SCHEME.len()].eq_ignore_ascii_case(SCHEME) {
        return Credential::Missing;
    }
    let presented = trim_spaces(&header[SCHEME.len()..]);
    if presented.is_empty() {
        return Credential::Missing;
    }
    if constant_time_eq(presented, token) {
        Credential::Valid
    } else {
        Credential::Invalid
    }
}

fn trim_spaces(bytes: &[u8]) -> &[u8] {
    let start = bytes.iter().position(|b| *b != b' ').unwrap_or(bytes.len());
    let end = bytes.iter().rposition(|b| *b != b' ').map_or(start, |i| i + 1);
    &bytes[start..end]
}

/// Time depends on the lengths only, never on where the bytes first differ.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    let mut difference = (a.len() ^ b.len()) as u64;
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        difference |= u64::from(x ^ y);
    }
    std::hint::black_box(difference) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn judges_each_credential_shape() {
        let token = b"s3cret";
        assert_eq!(judge(None, token), Credential::Missing);
        assert_eq!(judge(Some(b"Basic s3cret"), token), Credential::Missing);
        assert_eq!(judge(Some(b"Bearer "), token), Credential::Missing);
        assert_eq!(judge(Some(b"Bearer s3cre"), token), Credential::Invalid);
        assert_eq!(judge(Some(b"Bearer s3cret!"), token), Credential::Invalid);
        assert_eq!(judge(Some(b"bearer s3cret"), token), Credential::Valid);
    }
}
