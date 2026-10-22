//! ECMAScript's `toLowerCase` and `toUpperCase` — `es_to_lower_case` and
//! `es_to_upper_case`, the casing `lowerAscii` and `upperAscii` answer with — over the
//! engine's own Unicode 17.0 data.
//!
//! Every expected text is what Node's `String.prototype.toLowerCase` /
//! `toUpperCase` answered, executed on Node 24.21.0 (V8 with ICU 78.3, Unicode 17.0),
//! the host of `@telorun/cel 0.120.1 at b4a2b6e9`, whose `lowerAscii` and `upperAscii`
//! answer with it.
//! Every code point's own mapping is pinned inside the crate (`re2_syntax.rs`); here
//! whole texts: the full mappings that change a text's length, and Final_Sigma — `Σ`
//! lowers to `ς` where a cased letter comes before it and none after it, a
//! case-ignorable character between passed over, and a character that is both, such as
//! `ʰ` or `ͅ`, passed over as ignorable (`ʰΣ` lowers to `ʰσ`, `AΣʰ` to `aςʰ`).

use telorun_cel::{es_to_lower_case, es_to_upper_case};

/// `(text, Node's toLowerCase, Node's toUpperCase)`.
const NODE_ANSWERS: &[(&str, &str, &str)] = &[
        ("", "", ""),
        ("HeLLo, World 123", "hello, world 123", "HELLO, WORLD 123"),
        ("ÀÉÎÕÜ àéîõü", "àéîõü àéîõü", "ÀÉÎÕÜ ÀÉÎÕÜ"),
        ("İstanbul", "i̇stanbul", "İSTANBUL"),
        ("ı", "ı", "I"),
        ("ß", "ß", "SS"),
        ("straße", "straße", "STRASSE"),
        ("ŉ", "ŉ", "ʼN"),
        ("ﬃ", "ﬃ", "FFI"),
        ("ﬀ", "ﬀ", "FF"),
        ("ΐ", "ΐ", "Ϊ́"),
        ("ǅ", "ǆ", "Ǆ"),
        ("ǈ", "ǉ", "Ǉ"),
        ("Ω", "ω", "Ω"),
        ("K", "k", "K"),
        ("Å", "å", "Å"),
        ("ΟΔΥΣΣΕΥΣ", "οδυσσευς", "ΟΔΥΣΣΕΥΣ"),
        ("Σ", "σ", "Σ"),
        ("ΑΣ", "ας", "ΑΣ"),
        ("ΑΣΑ", "ασα", "ΑΣΑ"),
        ("ΑΣ.", "ας.", "ΑΣ."),
        ("ΑΣ.Α", "ασ.α", "ΑΣ.Α"),
        ("Α.Σ", "α.ς", "Α.Σ"),
        ("ʰΣ", "ʰσ", "ʰΣ"),
        ("AΣʰ", "aςʰ", "AΣʰ"),
        ("AΣʰB", "aσʰb", "AΣʰB"),
        ("ͅΣ", "ͅσ", "ΙΣ"),
        ("AΣͅ", "aςͅ", "AΣΙ"),
        ("AΣ'", "aς'", "AΣ'"),
        ("AΣ́", "aς́", "AΣ́"),
        ("ÁΣ", "áς", "ÁΣ"),
        ("1Σ", "1σ", "1Σ"),
        ("AΣ1", "aς1", "AΣ1"),
        ("𐐀Σ", "𐐨ς", "𐐀Σ"),
        ("AΣ𐐀", "aσ𐐨", "AΣ𐐀"),
        ("ΣΑΣ ΣΑΣ", "σας σας", "ΣΑΣ ΣΑΣ"),
        ("Σ\u{200d}Α", "σ\u{200d}α", "Σ\u{200d}Α"),
        ("😀Σ", "😀σ", "😀Σ"),
        ("ΑΣ😀", "ας😀", "ΑΣ😀"),
        ("𐐀𐐁", "𐐨𐐩", "𐐀𐐁"),
        ("𐐨", "𐐨", "𐐀"),
        ("ǰ", "ǰ", "J̌"),
        ("ẞ", "ß", "ẞ"),
        ("ᾈ", "ᾀ", "ἈΙ"),
        ("ᾀ", "ᾀ", "ἈΙ"),
        ("Ꭰ", "ꭰ", "Ꭰ"),
        ("ꭰ", "ꭰ", "Ꭰ"),
        ("Ⓐ", "ⓐ", "Ⓐ"),
        ("ⓐ", "ⓐ", "Ⓐ"),
        ("Ꞔ", "ꞔ", "Ꞔ"),
        ("İ̇", "i̇̇", "İ̇"),
        ("i̇", "i̇", "İ"),
        ("꟎", "꟏", "꟎"),
        ("𖺠", "𖺻", "𖺠"),
        ("𐵐", "𐵰", "𐵐"),
];

#[test]
fn cases_every_text_as_node_does() {
    for (text, lower, upper) in NODE_ANSWERS {
        assert_eq!(es_to_lower_case(text), *lower, "{text:?}");
        assert_eq!(es_to_upper_case(text), *upper, "{text:?}");
    }
}

/// The casing is the engine's own Unicode 17.0, whatever the Rust toolchain or a host
/// knows: U+A7CE and U+16EA0, cased first in Unicode 17.0, lower to U+A7CF and U+16EBB,
/// as Node 24.21's V8 lowers them. A host on an older Unicode leaves them as they are;
/// this engine answers with its own data.
#[test]
fn cases_with_the_engines_own_unicode_17() {
    assert_eq!(es_to_lower_case("\u{a7ce}\u{16ea0}"), "\u{a7cf}\u{16ebb}");
    assert_eq!(es_to_upper_case("\u{a7cf}\u{16ebb}"), "\u{a7ce}\u{16ea0}");
}
