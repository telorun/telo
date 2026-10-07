//! A value's written text, as literal tables.
//!
//! No Node test twins this file: `value-text.ts` is three calls into the host
//! (`String`, `TextEncoder`, a fatal `TextDecoder`), and `JSON.stringify` is the
//! host's too. Each row is what the Node build answers for that input, executed.

use telorun_cel_value::{bytes_to_text, double_text, es_number, json_quote, text_to_bytes};

#[test]
fn writes_a_double_as_the_shortest_digits_that_read_back() {
    // The double's bits, then `doubleText` and the host's own `String(value)`. The rows
    // span both notation thresholds (1e21, 1e-7), the two doubles whose shortest
    // candidates tie (settled to the even digit), and the values `doubleText` names.
    const NODE_DOUBLES: &[(u64, &str, &str)] = &[
        (0x0000000000000000, "0", "0"),
        (0x8000000000000000, "-0", "0"),
        (0x3ff0000000000000, "1", "1"),
        (0xbff0000000000000, "-1", "-1"),
        (0x3fb999999999999a, "0.1", "0.1"),
        (0x3fe0000000000000, "0.5", "0.5"),
        (0x3ff8000000000000, "1.5", "1.5"),
        (0x4059000000000000, "100", "100"),
        (0x405edd2f1a9fbe77, "123.456", "123.456"),
        (0xc05edd2f1a9fbe77, "-123.456", "-123.456"),
        (0x444b1ae4d6e2ef50, "1e+21", "1e+21"),
        (0x444b1ae4d6e2ef4f, "999999999999999900000", "999999999999999900000"),
        (0x4480f0cf064dd592, "1e+22", "1e+22"),
        (0x4454542ba12a337c, "1.5e+21", "1.5e+21"),
        (0x441ac53a7e04bcda, "123456789012345680000", "123456789012345680000"),
        (0x4415af1d78b58c40, "100000000000000000000", "100000000000000000000"),
        (0x3eb0c6f7a0b5ed8d, "0.000001", "0.000001"),
        (0x3e7ad7f29abcaf48, "1e-7", "1e-7"),
        (0x3e8421f5f40d8376, "1.5e-7", "1.5e-7"),
        (0x3eb4b3fd5942cd96, "0.000001234", "0.000001234"),
        (0x3e8091b5aeffdb8e, "1.2345e-7", "1.2345e-7"),
        (0xbe7ad7f29abcaf48, "-1e-7", "-1e-7"),
        (0x3ee4f8b588e368f1, "0.00001", "0.00001"),
        (0x0000000000000001, "5e-324", "5e-324"),
        (0x7fefffffffffffff, "1.7976931348623157e+308", "1.7976931348623157e+308"),
        (0x0010000000000000, "2.2250738585072014e-308", "2.2250738585072014e-308"),
        (0x4340000000000000, "9007199254740992", "9007199254740992"),
        (0x4340000000000001, "9007199254740994", "9007199254740994"),
        (0x43b0000000000000, "1152921504606847000", "1152921504606847000"),
        (0x3fd3333333333334, "0.30000000000000004", "0.30000000000000004"),
        (0x3fd5555555555555, "0.3333333333333333", "0.3333333333333333"),
        (0x4011666666666666, "4.35", "4.35"),
        (0x3f02599ed7c6fbd2, "0.000035", "0.000035"),
        (0x4310000000000001, "1125899906842624.2", "1125899906842624.2"),
        (0x4310000000000003, "1125899906842624.8", "1125899906842624.8"),
        (0x4320000000000001, "2251799813685248.5", "2251799813685248.5"),
        (0xc310000000000001, "-1125899906842624.2", "-1125899906842624.2"),
        (0x4340000000000000, "9007199254740992", "9007199254740992"),
        (0x44b52d02c7e14af6, "1e+23", "1e+23"),
        (0x447c7e83209e90b2, "8.41e+21", "8.41e+21"),
        (0x3ea0c6f7a0b5ed8d, "5e-7", "5e-7"),
        (0x419d6f3454000000, "123456789", "123456789"),
        (0x7ff8000000000000, "NaN", "NaN"),
        (0x7ff0000000000000, "+Inf", "Infinity"),
        (0xfff0000000000000, "-Inf", "-Infinity"),
    ];
    for (bits, written, number) in NODE_DOUBLES {
        let value = f64::from_bits(*bits);
        assert_eq!(double_text(value), *written, "{bits:#018x}");
        assert_eq!(es_number(value), *number, "{bits:#018x}");
    }
}

#[test]
fn quotes_text_as_json_stringify_quotes_a_string() {
    const NODE_QUOTED: &[(&str, &str)] = &[
        ("", "\"\""),
        ("a", "\"a\""),
        ("\"", "\"\\\"\""),
        ("\\", "\"\\\\\""),
        ("\u{8}\u{c}\u{a}\u{d}\u{9}", "\"\\b\\f\\n\\r\\t\""),
        ("\u{0}", "\"\\u0000\""),
        ("\u{1}\u{1f}", "\"\\u0001\\u001f\""),
        ("\u{7f}", "\"\u{7f}\""),
        ("\u{2028}\u{2029}", "\"\u{2028}\u{2029}\""),
        ("é", "\"é\""),
        ("😀", "\"😀\""),
        ("µs", "\"µs\""),
        ("a/b", "\"a/b\""),
        ("'", "\"'\""),
        ("say \"hi\"\\now", "\"say \\\"hi\\\"\\\\now\""),
        ("\u{feff}", "\"\u{feff}\""),
        ("<script>&", "\"<script>&\""),
    ];
    for (text, quoted) in NODE_QUOTED {
        assert_eq!(json_quote(text), *quoted, "{text:?}");
    }
}

#[test]
fn reads_bytes_as_utf_8_text_and_refuses_bytes_that_are_not() {
    const NODE_TEXT: &[(&[u8], Result<&str, (&str, &str)>)] = &[
        (&[], Ok("")),
        (&[0x61], Ok("a")),
        (&[0xc3, 0xa9], Ok("é")),
        (&[0xef, 0xbb, 0xbf, 0x61], Ok("a")),
        (&[0xef, 0xbb, 0xbf], Ok("")),
        (&[0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x61], Ok("\u{feff}a")),
        (&[0x61, 0xef, 0xbb, 0xbf], Ok("a\u{feff}")),
        (&[0xff], Err(("invalid_conversion", "the bytes are not UTF-8 text"))),
        (&[0xc3], Err(("invalid_conversion", "the bytes are not UTF-8 text"))),
        (&[0xc0, 0x80], Err(("invalid_conversion", "the bytes are not UTF-8 text"))),
        (&[0xed, 0xa0, 0x80], Err(("invalid_conversion", "the bytes are not UTF-8 text"))),
        (&[0xf4, 0x90, 0x80, 0x80], Err(("invalid_conversion", "the bytes are not UTF-8 text"))),
        (&[0xf0, 0x9f, 0x98, 0x80], Ok("😀")),
        (&[0x00], Ok("\u{0}")),
        (&[0x61, 0x80], Err(("invalid_conversion", "the bytes are not UTF-8 text"))),
        (&[0xe2, 0x82], Err(("invalid_conversion", "the bytes are not UTF-8 text"))),
        (&[0xf4, 0x8f, 0xbf, 0xbf], Ok("\u{10ffff}")),
        (&[0xef, 0xbf, 0xbd], Ok("\u{fffd}")),
        (&[0xef, 0xbb], Err(("invalid_conversion", "the bytes are not UTF-8 text"))),
    ];
    for (bytes, text) in NODE_TEXT {
        let read = bytes_to_text(bytes).map_err(|error| {
            assert_eq!(error.range, None);
            (error.code.as_str(), error.message)
        });
        assert_eq!(read, text.map(str::to_string).map_err(|(code, message)| (code, message.to_string())), "{bytes:x?}");
    }
}

#[test]
fn writes_text_as_its_utf_8_bytes() {
    const NODE_BYTES: &[(&str, &[u8])] = &[
        ("", &[]),
        ("a", &[0x61]),
        ("é", &[0xc3, 0xa9]),
        ("😀", &[0xf0, 0x9f, 0x98, 0x80]),
        ("\u{feff}a", &[0xef, 0xbb, 0xbf, 0x61]),
        ("\u{0}", &[0x00]),
        ("µs", &[0xc2, 0xb5, 0x73]),
    ];
    for (text, bytes) in NODE_BYTES {
        assert_eq!(text_to_bytes(text), *bytes, "{text:?}");
    }
}
