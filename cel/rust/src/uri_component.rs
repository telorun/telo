//! No Node twin: ECMAScript's `encodeURIComponent` and `decodeURIComponent`, which
//! `catalog-runtime.ts` takes from its host, V8. Recorded against V8 13.6.233.10-node.28
//! (Node v24.11.1).
//!
//! Encoding writes every character outside `A-Z a-z 0-9 - _ . ! ~ * ' ( )` as the
//! percent-encoded bytes of its UTF-8, in upper-case hexadecimal. It never fails: the one
//! text V8 refuses to encode holds an unpaired surrogate, which no Rust string does.
//!
//! Decoding is ECMA-262's `Decode` with an empty reserved set, in its order. V8 answers
//! every failure with one `URIError` and no position; here a failure says what it is and
//! where, in UTF-16 code units: a `%` not followed by two hexadecimal digits — a
//! continuation byte's included — or a sequence that is not UTF-8 (a lead byte UTF-8 has no
//! use for, a sequence cut short by the text's end, a continuation not written with `%`,
//! one outside `80`–`BF`, an overlong form, a surrogate, a value above U+10FFFF), named at
//! the `%` of its first byte.

/// Where and why a text is not a percent-encoding `decodeURIComponent` reads.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum UriDecodeFault {
    /// The `%` at this UTF-16 offset is not followed by two hexadecimal digits.
    NotHex { offset: usize },
    /// The bytes percent-encoded from the `%` at this UTF-16 offset are not UTF-8.
    NotUtf8 { offset: usize },
}

fn unreserved(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')')
}

const HEX_DIGITS: &[u8; 16] = b"0123456789ABCDEF";

/// `encodeURIComponent`.
pub(crate) fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for &byte in text.as_bytes() {
        if unreserved(byte) {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push(HEX_DIGITS[(byte >> 4) as usize] as char);
            out.push(HEX_DIGITS[(byte & 15) as usize] as char);
        }
    }
    out
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// `decodeURIComponent`.
pub(crate) fn decode_uri_component(text: &str) -> Result<String, UriDecodeFault> {
    let bytes = text.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(text.len());
    // `units` is the UTF-16 offset of byte `at`; only a `%` and what follows it are ASCII
    // the walk reads, so everything else is copied and counted a character at a time.
    let (mut at, mut units) = (0usize, 0usize);
    let mut text_units: Option<usize> = None;
    let octet = |at: usize| -> Option<u8> {
        let high = hex_value(*bytes.get(at + 1)?)?;
        let low = hex_value(*bytes.get(at + 2)?)?;
        Some(high << 4 | low)
    };
    while at < bytes.len() {
        let byte = bytes[at];
        if byte != b'%' {
            let run = bytes[at..].iter().position(|b| *b == b'%').map_or(bytes.len(), |n| at + n);
            let copied = &text[at..run];
            out.extend_from_slice(copied.as_bytes());
            units += if copied.is_ascii() { copied.len() } else { copied.encode_utf16().count() };
            at = run;
            continue;
        }
        let start = units;
        let lead = octet(at).ok_or(UriDecodeFault::NotHex { offset: start })?;
        if lead < 0x80 {
            out.push(lead);
            at += 3;
            units += 3;
            continue;
        }
        let width = lead.leading_ones() as usize;
        let not_utf8 = UriDecodeFault::NotUtf8 { offset: start };
        if width == 1 || width > 4 {
            return Err(not_utf8);
        }
        // ECMA-262 asks for the whole sequence's room, in code units, before reading a
        // continuation.
        let length = *text_units.get_or_insert_with(|| text.encode_utf16().count());
        if start + 2 + 3 * (width - 1) >= length {
            return Err(not_utf8);
        }
        let mut sequence = [lead, 0, 0, 0];
        let mut cursor = at + 3;
        for slot in sequence.iter_mut().take(width).skip(1) {
            if bytes[cursor] != b'%' {
                return Err(not_utf8);
            }
            *slot = octet(cursor).ok_or(UriDecodeFault::NotHex { offset: start + (cursor - at) })?;
            cursor += 3;
        }
        let decoded = std::str::from_utf8(&sequence[..width]).map_err(|_| not_utf8)?;
        out.extend_from_slice(decoded.as_bytes());
        units += cursor - at;
        at = cursor;
    }
    Ok(String::from_utf8(out).expect("every byte copied or decoded is UTF-8"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fnv(text: &str) -> u64 {
        text.bytes().fold(0xcbf2_9ce4_8422_2325, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x100_0000_01b3))
    }

    /// V8's answer as the tables write it: the text, or `!` where it throws.
    fn written(text: &str) -> String {
        decode_uri_component(text).unwrap_or_else(|_| "!".into())
    }

    fn escape(byte: u8) -> String {
        format!("%{byte:02X}")
    }

    #[test]
    fn every_escape_decodes_as_v8() {
        let answers: Vec<String> = (0..=255u8)
            .flat_map(|byte| [written(&escape(byte)), written(&escape(byte).to_ascii_lowercase())])
            .collect();
        assert_eq!(fnv(&answers.join("\n")), EVERY_ESCAPE, "{answers:?}");
    }

    #[test]
    fn every_lead_and_continuation_class_decodes_as_v8() {
        let mut wrong = Vec::new();
        for &(lead, digest) in LEAD_DIGESTS {
            let lead_text = escape(lead);
            let mut answers: Vec<String> =
                CONTINUATIONS.iter().map(|b| written(&format!("{lead_text}{}", escape(*b)))).collect();
            for b in SECOND {
                for c in THIRD {
                    answers.push(written(&format!("{lead_text}{}{}", escape(b), escape(c))));
                }
            }
            for b in FOURTH_SECOND {
                for c in FOURTH_THIRD {
                    for d in FOURTH_LAST {
                        answers.push(written(&format!("{lead_text}{}{}{}", escape(b), escape(c), escape(d))));
                    }
                }
            }
            if fnv(&answers.join("\n")) != digest {
                wrong.push(format!("{lead:#04x}: {answers:?}"));
            }
        }
        assert!(wrong.is_empty(), "{}", wrong.join("\n"));
    }

    #[test]
    fn each_text_decodes_or_names_its_fault() {
        for &(text, expected) in DECODE_ROWS {
            assert_eq!(decode_uri_component(text).as_deref().map_err(|fault| *fault), expected, "{text:?}");
        }
    }

    #[test]
    fn every_character_outside_the_unreserved_set_is_encoded() {
        let ascii: String = (0..128u8).map(char::from).collect();
        assert_eq!(encode_uri_component(&ascii), EVERY_ASCII_ENCODED);
        for &(text, expected) in ENCODE_ROWS {
            assert_eq!(encode_uri_component(text), expected, "{text:?}");
            assert_eq!(decode_uri_component(expected).as_deref(), Ok(text), "decoding {expected:?}");
        }
    }
    // Recorded by executing decodeURIComponent and encodeURIComponent under Node v24.21.0 (V8 13.6.233.17-node.53, ICU 78.3, tz 2026c),
    // against @telorun/cel 0.129.0 at 2ee5ef49.
    /// Every `%XX`, upper case then lower case, in byte order: FNV-1a 64 over V8's answers joined by
    /// line feeds, `!` where it throws.
    const EVERY_ESCAPE: u64 = 0xf73e67e9b3cb42cd;

    /// `(lead byte, digest)`: FNV-1a 64 over V8's answers, `!` where it throws, for the lead followed by
    /// one continuation of each of `CONTINUATIONS`, then by two of `SECOND` × `THIRD`, then by three of
    /// `FOURTH_SECOND` × `FOURTH_THIRD` × `FOURTH_LAST`, every byte percent-encoded in upper case.
    const LEAD_DIGESTS: &[(u8, u64)] = &[
        (0x80, 0x08216d6b234ba300), (0x81, 0x08216d6b234ba300), (0x82, 0x08216d6b234ba300), (0x83, 0x08216d6b234ba300),
        (0x84, 0x08216d6b234ba300), (0x85, 0x08216d6b234ba300), (0x86, 0x08216d6b234ba300), (0x87, 0x08216d6b234ba300),
        (0x88, 0x08216d6b234ba300), (0x89, 0x08216d6b234ba300), (0x8a, 0x08216d6b234ba300), (0x8b, 0x08216d6b234ba300),
        (0x8c, 0x08216d6b234ba300), (0x8d, 0x08216d6b234ba300), (0x8e, 0x08216d6b234ba300), (0x8f, 0x08216d6b234ba300),
        (0x90, 0x08216d6b234ba300), (0x91, 0x08216d6b234ba300), (0x92, 0x08216d6b234ba300), (0x93, 0x08216d6b234ba300),
        (0x94, 0x08216d6b234ba300), (0x95, 0x08216d6b234ba300), (0x96, 0x08216d6b234ba300), (0x97, 0x08216d6b234ba300),
        (0x98, 0x08216d6b234ba300), (0x99, 0x08216d6b234ba300), (0x9a, 0x08216d6b234ba300), (0x9b, 0x08216d6b234ba300),
        (0x9c, 0x08216d6b234ba300), (0x9d, 0x08216d6b234ba300), (0x9e, 0x08216d6b234ba300), (0x9f, 0x08216d6b234ba300),
        (0xa0, 0x08216d6b234ba300), (0xa1, 0x08216d6b234ba300), (0xa2, 0x08216d6b234ba300), (0xa3, 0x08216d6b234ba300),
        (0xa4, 0x08216d6b234ba300), (0xa5, 0x08216d6b234ba300), (0xa6, 0x08216d6b234ba300), (0xa7, 0x08216d6b234ba300),
        (0xa8, 0x08216d6b234ba300), (0xa9, 0x08216d6b234ba300), (0xaa, 0x08216d6b234ba300), (0xab, 0x08216d6b234ba300),
        (0xac, 0x08216d6b234ba300), (0xad, 0x08216d6b234ba300), (0xae, 0x08216d6b234ba300), (0xaf, 0x08216d6b234ba300),
        (0xb0, 0x08216d6b234ba300), (0xb1, 0x08216d6b234ba300), (0xb2, 0x08216d6b234ba300), (0xb3, 0x08216d6b234ba300),
        (0xb4, 0x08216d6b234ba300), (0xb5, 0x08216d6b234ba300), (0xb6, 0x08216d6b234ba300), (0xb7, 0x08216d6b234ba300),
        (0xb8, 0x08216d6b234ba300), (0xb9, 0x08216d6b234ba300), (0xba, 0x08216d6b234ba300), (0xbb, 0x08216d6b234ba300),
        (0xbc, 0x08216d6b234ba300), (0xbd, 0x08216d6b234ba300), (0xbe, 0x08216d6b234ba300), (0xbf, 0x08216d6b234ba300),
        (0xc0, 0x08216d6b234ba300), (0xc1, 0x08216d6b234ba300), (0xc2, 0xd30498a2b192575a), (0xc3, 0xa13de6bcd3868034),
        (0xc4, 0x00b7b8ee735680f2), (0xc5, 0x7aa1758bce8732a0), (0xc6, 0x569efb490c581262), (0xc7, 0x5131993e1c5cc484),
        (0xc8, 0xc20f92fbe392c28a), (0xc9, 0x174dfcda840dde48), (0xca, 0x2229413452eb6b3a), (0xcb, 0x45d9a6df6f371294),
        (0xcc, 0xd01009a071cdaa12), (0xcd, 0x518c5308f72019d0), (0xce, 0x576aa8399f040112), (0xcf, 0x5df1bb9df2412804),
        (0xd0, 0x1eb26d004890889a), (0xd1, 0xcd992ef9e0739b08), (0xd2, 0x118981b8a72acffa), (0xd3, 0x60c6f4276b0fae54),
        (0xd4, 0xb49873ad1ddf9ef2), (0xd5, 0xe609f1b486b07d00), (0xd6, 0xe0922dfc1329e322), (0xd7, 0x7a5d253bf625b6e4),
        (0xd8, 0x1c240a7b1764232a), (0xd9, 0x69b4717ad762b9c8), (0xda, 0x08efeb832d40341a), (0xdb, 0xcb5dee93904b3b74),
        (0xdc, 0x7cb28ba3d0f6ef92), (0xdd, 0xb80c8d589617a550), (0xde, 0x63d53d6096357e32), (0xdf, 0x5b6543ca8356f724),
        (0xe0, 0xe88fbd9d9db71520), (0xe1, 0x7c4277dccf205590), (0xe2, 0x555e8b79453c4674), (0xe3, 0xe75a19077ed980c4),
        (0xe4, 0x85a238bee859a258), (0xe5, 0xcc1adc68fae46078), (0xe6, 0xb173852ec92cd3f4), (0xe7, 0xbeba6b9f1a14c314),
        (0xe8, 0x7b4b326de0095c30), (0xe9, 0x192b2861b7146860), (0xea, 0x70bbb32ffc8904a4), (0xeb, 0x466d9814415a1614),
        (0xec, 0xfdd18840af0d2058), (0xed, 0xe59289b022f4aa70), (0xee, 0xd00c35d12bda76e4), (0xef, 0xfad801e96a1e3be4),
        (0xf0, 0xe00ed9e9dfb02bb2), (0xf1, 0x48818ad63d25f14c), (0xf2, 0xc556d08d41299f74), (0xf3, 0x04646ed710107a2c),
        (0xf4, 0x89e1dd7e8ea4484a), (0xf5, 0x08216d6b234ba300), (0xf6, 0x08216d6b234ba300), (0xf7, 0x08216d6b234ba300),
        (0xf8, 0x08216d6b234ba300), (0xf9, 0x08216d6b234ba300), (0xfa, 0x08216d6b234ba300), (0xfb, 0x08216d6b234ba300),
        (0xfc, 0x08216d6b234ba300), (0xfd, 0x08216d6b234ba300), (0xfe, 0x08216d6b234ba300), (0xff, 0x08216d6b234ba300),
    ];
    const CONTINUATIONS: [u8; 11] = [0x0, 0x41, 0x7f, 0x80, 0x8f, 0x90, 0x9f, 0xa0, 0xbf, 0xc0, 0xff];
    const SECOND: [u8; 8] = [0x7f, 0x80, 0x8f, 0x90, 0x9f, 0xa0, 0xbf, 0xc0];
    const THIRD: [u8; 4] = [0x7f, 0x80, 0xbf, 0xc0];
    const FOURTH_SECOND: [u8; 6] = [0x7f, 0x80, 0x8f, 0x90, 0xbf, 0xc0];
    const FOURTH_THIRD: [u8; 2] = [0x80, 0xc0];
    const FOURTH_LAST: [u8; 3] = [0x80, 0xbf, 0xc0];

    /// `(text, answer)`: V8's decoded text, or a fault where it throws `URIError` — the fault and its
    /// offset this crate's own reading of ECMA-262's order, V8 naming neither.
    const DECODE_ROWS: &[(&str, Result<&str, UriDecodeFault>)] = &[
        ("", Ok("")),
        ("abc", Ok("abc")),
        ("%41%42", Ok("AB")),
        ("%e9", Err(UriDecodeFault::NotUtf8 { offset: 0 })),
        ("%C3%A9", Ok("\u{e9}")),
        ("%c3%a9", Ok("\u{e9}")),
        ("%E4%B8%AD", Ok("\u{4e2d}")),
        ("%F0%9F%98%80", Ok("\u{1f600}")),
        ("%f0%9f%98%80x", Ok("\u{1f600}x")),
        ("a%2Fb%3f", Ok("a/b?")),
        ("%EF%BF%BD", Ok("\u{fffd}")),
        ("%EF%BF%BF", Ok("\u{ffff}")),
        ("%F4%8F%BF%BF", Ok("\u{10ffff}")),
        ("%C2%80", Ok("\u{80}")),
        ("%DF%BF", Ok("\u{7ff}")),
        ("%E0%A0%80", Ok("\u{800}")),
        ("%ED%9F%BF", Ok("\u{d7ff}")),
        ("%EE%80%80", Ok("\u{e000}")),
        ("\u{1f600}%41", Ok("\u{1f600}A")),
        ("\u{e9}%C3%A9", Ok("\u{e9}\u{e9}")),
        ("+%20+", Ok("+ +")),
        ("%25", Ok("%")),
        ("%2525", Ok("%25")),
        ("%", Err(UriDecodeFault::NotHex { offset: 0 })),
        ("%4", Err(UriDecodeFault::NotHex { offset: 0 })),
        ("a%", Err(UriDecodeFault::NotHex { offset: 1 })),
        ("%G0", Err(UriDecodeFault::NotHex { offset: 0 })),
        ("%4G", Err(UriDecodeFault::NotHex { offset: 0 })),
        ("%zz", Err(UriDecodeFault::NotHex { offset: 0 })),
        ("%%41", Err(UriDecodeFault::NotHex { offset: 0 })),
        ("\u{1f600}%", Err(UriDecodeFault::NotHex { offset: 2 })),
        ("\u{e9}%ZZ", Err(UriDecodeFault::NotHex { offset: 1 })),
        ("\u{1f600}%C3%G0", Err(UriDecodeFault::NotHex { offset: 5 })),
        ("%C3%G0", Err(UriDecodeFault::NotHex { offset: 3 })),
        ("%C3%4", Err(UriDecodeFault::NotUtf8 { offset: 0 })),
        ("%E2%82%Z", Err(UriDecodeFault::NotUtf8 { offset: 0 })),
        ("%E2%82%ZZ", Err(UriDecodeFault::NotHex { offset: 6 })),
        ("%E2%G2%AC", Err(UriDecodeFault::NotHex { offset: 3 })),
        ("%F0%9F%98%G0", Err(UriDecodeFault::NotHex { offset: 9 })),
        ("%80", Err(UriDecodeFault::NotUtf8 { offset: 0 })),
        ("%BF", Err(UriDecodeFault::NotUtf8 { offset: 0 })),
        ("%F8%80%80%80%80", Err(UriDecodeFault::NotUtf8 { offset: 0 })),
        ("%FF", Err(UriDecodeFault::NotUtf8 { offset: 0 })),
        ("%C0%80", Err(UriDecodeFault::NotUtf8 { offset: 0 })),
        ("%C1%BF", Err(UriDecodeFault::NotUtf8 { offset: 0 })),
        ("%E0%80%80", Err(UriDecodeFault::NotUtf8 { offset: 0 })),
        ("%E0%9F%BF", Err(UriDecodeFault::NotUtf8 { offset: 0 })),
        ("%F0%80%80%80", Err(UriDecodeFault::NotUtf8 { offset: 0 })),
        ("%F0%8F%BF%BF", Err(UriDecodeFault::NotUtf8 { offset: 0 })),
        ("%ED%A0%80", Err(UriDecodeFault::NotUtf8 { offset: 0 })),
        ("%ED%BF%BF", Err(UriDecodeFault::NotUtf8 { offset: 0 })),
        ("%F4%90%80%80", Err(UriDecodeFault::NotUtf8 { offset: 0 })),
        ("%F5%80%80%80", Err(UriDecodeFault::NotUtf8 { offset: 0 })),
        ("%F7%BF%BF%BF", Err(UriDecodeFault::NotUtf8 { offset: 0 })),
        ("%C3", Err(UriDecodeFault::NotUtf8 { offset: 0 })),
        ("%E2%82", Err(UriDecodeFault::NotUtf8 { offset: 0 })),
        ("%F0%9F%98", Err(UriDecodeFault::NotUtf8 { offset: 0 })),
        ("%C3%A", Err(UriDecodeFault::NotUtf8 { offset: 0 })),
        ("%E2%8\u{1f600}", Err(UriDecodeFault::NotUtf8 { offset: 0 })),
        ("%E2%82\u{1f600}", Err(UriDecodeFault::NotUtf8 { offset: 0 })),
        ("%C3A9", Err(UriDecodeFault::NotUtf8 { offset: 0 })),
        ("%E2%82x", Err(UriDecodeFault::NotUtf8 { offset: 0 })),
        ("%E2x%82%AC", Err(UriDecodeFault::NotUtf8 { offset: 0 })),
        ("%C3%41", Err(UriDecodeFault::NotUtf8 { offset: 0 })),
        ("%C3%C3", Err(UriDecodeFault::NotUtf8 { offset: 0 })),
        ("%E2%41%AC", Err(UriDecodeFault::NotUtf8 { offset: 0 })),
        ("%F0%9F%41%80", Err(UriDecodeFault::NotUtf8 { offset: 0 })),
        ("x\u{1f600}%C3", Err(UriDecodeFault::NotUtf8 { offset: 3 })),
        ("\u{1f600}\u{1f600}%E2%28%A1", Err(UriDecodeFault::NotUtf8 { offset: 4 })),
    ];

    /// `encodeURIComponent` of every ASCII character, U+0000 to U+007F in order.
    const EVERY_ASCII_ENCODED: &str = "%00%01%02%03%04%05%06%07%08%09%0A%0B%0C%0D%0E%0F%10%11%12%13%14%15%16%17%18%19%1A%1B%1C%1D%1E%1F%20!%22%23%24%25%26'()*%2B%2C-.%2F0123456789%3A%3B%3C%3D%3E%3F%40ABCDEFGHIJKLMNOPQRSTUVWXYZ%5B%5C%5D%5E_%60abcdefghijklmnopqrstuvwxyz%7B%7C%7D~%7F";

    /// `(text, encodeURIComponent of it)`.
    const ENCODE_ROWS: &[(&str, &str)] = &[
        ("\u{e9}", "%C3%A9"),
        ("\u{80}", "%C2%80"),
        ("\u{7ff}", "%DF%BF"),
        ("\u{800}", "%E0%A0%80"),
        ("\u{4e2d}", "%E4%B8%AD"),
        ("\u{ffff}", "%EF%BF%BF"),
        ("\u{1f600}", "%F0%9F%98%80"),
        ("\u{10ffff}", "%F4%8F%BF%BF"),
        ("a b&c=d/e?f#g", "a%20b%26c%3Dd%2Fe%3Ff%23g"),
        ("-_.!~*'()", "-_.!~*'()"),
        ("%", "%25"),
        ("\u{2028}\u{feff}", "%E2%80%A8%EF%BB%BF"),
    ];
}
