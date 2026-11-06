//! No Node twin: MD5 (RFC 1321) and SHA-1 (FIPS 180-4), the digests name-based UUIDs are
//! built on — the role `uuid` 14.0.1's `md5.js` and `sha1.js` fill with Node's host,
//! `node:crypto`. They digest a namespace's sixteen bytes and a name's UTF-8 and nothing
//! else, so they serve no security purpose here.

/// The padded message as 64-byte blocks: the bytes, `0x80`, zeros, and the bit length in
/// eight bytes, little-endian for MD5 and big-endian for SHA-1.
fn padded_blocks(message: &[u8], little_endian: bool) -> Vec<[u8; 64]> {
    let bit_length = (message.len() as u64).wrapping_mul(8);
    let mut padded = Vec::with_capacity(message.len() + 72);
    padded.extend_from_slice(message);
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&if little_endian { bit_length.to_le_bytes() } else { bit_length.to_be_bytes() });
    padded.chunks_exact(64).map(|block| block.try_into().expect("a 64-byte chunk")).collect()
}

const MD5_SHIFTS: [u32; 64] = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15,
    21,
];

/// RFC 1321's table: `floor(2^32 × |sin(i + 1)|)`, written out rather than computed, since
/// a host's `sin` is not specified to the last bit.
const MD5_CONSTANTS: [u32; 64] = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501, 0x698098d8,
    0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340,
    0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8, 0x21e1cde6, 0xc33707d6, 0xf4d50d87,
    0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
    0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039,
    0xe6db99e5, 0x1fa27cf8, 0xc4ac5665, 0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92,
    0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb,
    0xeb86d391,
];

/// The MD5 digest of a message.
pub(crate) fn md5(message: &[u8]) -> [u8; 16] {
    let mut state: [u32; 4] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
    for block in padded_blocks(message, true) {
        let words: [u32; 16] =
            std::array::from_fn(|at| u32::from_le_bytes(block[at * 4..at * 4 + 4].try_into().expect("four bytes")));
        let [mut a, mut b, mut c, mut d] = state;
        for round in 0..64 {
            let (mixed, word) = match round / 16 {
                0 => ((b & c) | (!b & d), round),
                1 => ((d & b) | (!d & c), (5 * round + 1) % 16),
                2 => (b ^ c ^ d, (3 * round + 5) % 16),
                _ => (c ^ (b | !d), (7 * round) % 16),
            };
            let sum = a.wrapping_add(mixed).wrapping_add(MD5_CONSTANTS[round]).wrapping_add(words[word]);
            a = d;
            d = c;
            c = b;
            b = b.wrapping_add(sum.rotate_left(MD5_SHIFTS[round]));
        }
        for (held, added) in state.iter_mut().zip([a, b, c, d]) {
            *held = held.wrapping_add(added);
        }
    }
    let mut digest = [0; 16];
    for (at, word) in state.iter().enumerate() {
        digest[at * 4..at * 4 + 4].copy_from_slice(&word.to_le_bytes());
    }
    digest
}

/// The SHA-1 digest of a message.
pub(crate) fn sha1(message: &[u8]) -> [u8; 20] {
    let mut state: [u32; 5] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
    for block in padded_blocks(message, false) {
        let mut schedule = [0u32; 80];
        for at in 0..16 {
            schedule[at] = u32::from_be_bytes(block[at * 4..at * 4 + 4].try_into().expect("four bytes"));
        }
        for at in 16..80 {
            schedule[at] = (schedule[at - 3] ^ schedule[at - 8] ^ schedule[at - 14] ^ schedule[at - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = state;
        for (round, &word) in schedule.iter().enumerate() {
            let (mixed, constant) = match round / 20 {
                0 => ((b & c) | (!b & d), 0x5a827999),
                1 => (b ^ c ^ d, 0x6ed9eba1),
                2 => ((b & c) | (b & d) | (c & d), 0x8f1bbcdc),
                _ => (b ^ c ^ d, 0xca62c1d6),
            };
            let next = a.rotate_left(5).wrapping_add(mixed).wrapping_add(e).wrapping_add(constant).wrapping_add(word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = next;
        }
        for (held, added) in state.iter_mut().zip([a, b, c, d, e]) {
            *held = held.wrapping_add(added);
        }
    }
    let mut digest = [0; 20];
    for (at, word) in state.iter().enumerate() {
        digest[at * 4..at * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    digest
}

#[cfg(test)]
mod tests {
    //! RFC 1321's test suite and FIPS 180-4's examples, and messages of every length from 0
    //! to 300 bytes, each digest Node's `node:crypto`, executed on Node v24.21.0 (V8
    //! 13.6.233.17-node.53, ICU 78.3, tz 2026c) for `@telorun/cel 0.129.0 at 2ee5ef49` and
    //! `uuid` 14.0.1.

    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    fn fnv(text: &str) -> u64 {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for byte in text.bytes() {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0100_0000_01b3);
        }
        hash
    }

    #[test]
    fn the_published_vectors() {
        for (message, md5_hex, sha1_hex) in [
            ("", "d41d8cd98f00b204e9800998ecf8427e", "da39a3ee5e6b4b0d3255bfef95601890afd80709"),
            ("a", "0cc175b9c0f1b6a831c399e269772661", "86f7e437faa5a7fce15d1ddcb9eaeaea377667b8"),
            ("abc", "900150983cd24fb0d6963f7d28e17f72", "a9993e364706816aba3e25717850c26c9cd0d89d"),
            ("message digest", "f96b697d7cb7938d525a2f31aaf161d0", "c12252ceda8be8994d5fa0290a47231c1d16aae3"),
            ("abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b", "32d10c7b8cf96570ca04ce37f2a19d84240d3a89"),
            (
                "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
                "d174ab98d277d9f5a5611c2c9f419d9f",
                "761c457bf73b14d27e9e9265c46f4b4dda11f940",
            ),
            (
                "12345678901234567890123456789012345678901234567890123456789012345678901234567890",
                "57edf4a22be3c955ac49da2e2107b67a",
                "50abf5706a150990a08b2c5ea40fa0e585554732",
            ),
            (
                "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
                "8215ef0796a20bcaaae116d3876c664a",
                "84983e441c3bd26ebaae4aa1f95129e5e54670f1",
            ),
        ] {
            assert_eq!(hex(&md5(message.as_bytes())), md5_hex, "md5 {message:?}");
            assert_eq!(hex(&sha1(message.as_bytes())), sha1_hex, "sha1 {message:?}");
        }
        let million = vec![b'a'; 1_000_000];
        assert_eq!(hex(&md5(&million)), "7707d6ae4e027c70eea2a935c2296f21");
        assert_eq!(hex(&sha1(&million)), "34aa973cd4c4daa4f61eeb2bdbad27316534016f");
    }

    /// Every padding case: messages of 0 to 300 bytes, byte `i` being `(31 i + 7) mod 256`,
    /// held by FNV-1a 64 over the hex digests joined by line feeds.
    #[test]
    fn every_length_to_300_bytes() {
        let messages: Vec<Vec<u8>> =
            (0..=300).map(|length| (0..length).map(|at: usize| (at * 31 + 7) as u8).collect()).collect();
        let md5s: Vec<String> = messages.iter().map(|message| hex(&md5(message))).collect();
        let sha1s: Vec<String> = messages.iter().map(|message| hex(&sha1(message))).collect();
        assert_eq!(md5s[300], "919e4e6eef1223bc54e857dfde80c3ce");
        assert_eq!(sha1s[300], "92de59cf7739d2cf8c2598a6c55b469c29ff92b6");
        assert_eq!(fnv(&md5s.join("\n")), 0xd1a2_d121_bae3_5c44);
        assert_eq!(fnv(&sha1s.join("\n")), 0xa90e_1461_fd2b_d4d4);
    }
}
