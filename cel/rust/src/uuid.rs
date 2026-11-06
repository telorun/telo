//! No Node twin: UUIDs as `catalog-runtime.ts` takes them from its dependency `uuid`
//! 14.0.1 — `v1`, `v3`, `v4`, `v5`, `v6`, `v7`, `validate` and `version`, each answering as
//! that package does under Node, with its MD5 and SHA-1 in `uuid_digests.rs`, the clock in
//! `host_clock.rs` and the random source in `host_random.rs`.
//!
//! **State is the process's**, as the package's module state is: one v1 state, which v6
//! advances too, and one v7 state, each behind its own lock. The clock and the random
//! bytes are read before the lock is taken, and the lock is held only while the state is
//! updated, by functions pure over the state, the clock reading and the bytes — the
//! package's `updateV1State` and `updateV7State`, ported, with JavaScript's number
//! arithmetic where the package writes it. Every environment and kernel in a process
//! shares the state.
//!
//! A namespace or a UUID the package's validation pattern refuses is an `InvalidUuid`, and
//! a random source that answers nothing a `RandomSourceUnavailable`; the catalog words
//! both.

use std::sync::Mutex;

use crate::host_clock::now_millis;
use crate::host_random::{random_bytes, RandomSourceUnavailable};
use crate::uuid_digests::{md5, sha1};

/// The text is not a UUID the package's pattern accepts.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct InvalidUuid;

type Bytes = [u8; 16];

/// The milliseconds between the Gregorian epoch of 1582-10-15 and the Unix epoch.
const GREGORIAN_OFFSET_MS: f64 = 12_219_292_800_000.0;

/// ECMAScript's `ToInt32`.
fn to_int32(value: f64) -> i32 {
    if !value.is_finite() {
        return 0;
    }
    value.trunc().rem_euclid(4_294_967_296.0) as u32 as i32
}

fn uuid_text(bytes: &Bytes) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut text = String::with_capacity(36);
    for (at, byte) in bytes.iter().enumerate() {
        if matches!(at, 4 | 6 | 8 | 10) {
            text.push('-');
        }
        text.push(HEX[(byte >> 4) as usize] as char);
        text.push(HEX[(byte & 0x0f) as usize] as char);
    }
    text
}

// --- v1 and v6 --------------------------------------------------------------

/// `uuid`'s v1 state. `msecs` is `None` before the first reading, the package's `-Infinity`.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub(crate) struct V1State {
    pub(crate) msecs: Option<i64>,
    pub(crate) nsecs: i64,
    pub(crate) node: Option<[u8; 6]>,
    pub(crate) clockseq: u16,
}

/// `updateV1State`: a reading in the same millisecond counts up to 10,000 and then takes
/// a new node; a later one starts the count again; an earlier one takes a new node.
pub(crate) fn update_v1_state(state: &mut V1State, now: i64, rnds: &Bytes) {
    match state.msecs {
        Some(msecs) if now == msecs => {
            state.nsecs += 1;
            if state.nsecs >= 10_000 {
                state.node = None;
                state.nsecs = 0;
            }
        }
        Some(msecs) if now < msecs => state.node = None,
        _ => state.nsecs = 0,
    }
    if state.node.is_none() {
        let mut node: [u8; 6] = rnds[10..16].try_into().expect("six bytes");
        node[0] |= 0x01;
        state.node = Some(node);
        state.clockseq = ((u16::from(rnds[8]) << 8) | u16::from(rnds[9])) & 0x3fff;
    }
    state.msecs = Some(now);
}

/// `v1Bytes`: the clock sequence and node default to the random bytes' own.
fn v1_bytes(rnds: &Bytes, msecs: i64, nsecs: i64, clockseq: Option<u16>, node: Option<[u8; 6]>) -> Bytes {
    let clockseq = clockseq.unwrap_or(((u16::from(rnds[8]) << 8) | u16::from(rnds[9])) & 0x3fff);
    let node = node.unwrap_or_else(|| rnds[10..16].try_into().expect("six bytes"));
    let msecs = msecs as f64 + GREGORIAN_OFFSET_MS;
    let low = ((to_int32(msecs) & 0x0fff_ffff) as f64 * 10_000.0 + nsecs as f64) % 4_294_967_296.0;
    let low = low as u32;
    let high = (to_int32(msecs / 4_294_967_296.0 * 10_000.0) & 0x0fff_ffff) as u32;
    let mut bytes = [0; 16];
    bytes[..4].copy_from_slice(&low.to_be_bytes());
    bytes[4] = (high >> 8) as u8;
    bytes[5] = high as u8;
    bytes[6] = ((high >> 24) & 0x0f) as u8 | 0x10;
    bytes[7] = (high >> 16) as u8;
    bytes[8] = (clockseq >> 8) as u8 | 0x80;
    bytes[9] = clockseq as u8;
    bytes[10..].copy_from_slice(&node);
    bytes
}

/// `v1ToV6`: the timestamp's fields reordered most significant first, version 6.
fn v1_to_v6(v1: &Bytes) -> Bytes {
    [
        ((v1[6] & 0x0f) << 4) | ((v1[7] >> 4) & 0x0f),
        ((v1[7] & 0x0f) << 4) | ((v1[4] & 0xf0) >> 4),
        ((v1[4] & 0x0f) << 4) | ((v1[5] & 0xf0) >> 4),
        ((v1[5] & 0x0f) << 4) | ((v1[0] & 0xf0) >> 4),
        ((v1[0] & 0x0f) << 4) | ((v1[1] & 0xf0) >> 4),
        ((v1[1] & 0x0f) << 4) | ((v1[2] & 0xf0) >> 4),
        0x60 | (v1[2] & 0x0f),
        v1[3],
        v1[8],
        v1[9],
        v1[10],
        v1[11],
        v1[12],
        v1[13],
        v1[14],
        v1[15],
    ]
}

static V1: Mutex<V1State> = Mutex::new(V1State { msecs: None, nsecs: 0, node: None, clockseq: 0 });

/// A v1 UUID, or the v1 bytes a v6 UUID is made from: v6 advances the v1 state and takes
/// its clock sequence and node from its own random bytes.
fn next_v1(
    state: &Mutex<V1State>,
    clock: impl FnOnce() -> i64,
    random: impl FnOnce() -> Result<Bytes, RandomSourceUnavailable>,
    for_v6: bool,
) -> Result<Bytes, RandomSourceUnavailable> {
    let now = clock();
    let rnds = random()?;
    let updated = {
        let mut held = state.lock().expect("the UUID state's update never panics");
        update_v1_state(&mut held, now, &rnds);
        *held
    };
    let msecs = updated.msecs.expect("an updated state holds its reading");
    Ok(if for_v6 {
        v1_bytes(&rnds, msecs, updated.nsecs, None, None)
    } else {
        v1_bytes(&rnds, msecs, updated.nsecs, Some(updated.clockseq), updated.node)
    })
}

/// `v1()`.
pub(crate) fn uuid_v1() -> Result<String, RandomSourceUnavailable> {
    next_v1(&V1, now_millis, random_bytes, false).map(|bytes| uuid_text(&bytes))
}

/// `v6()`.
pub(crate) fn uuid_v6() -> Result<String, RandomSourceUnavailable> {
    next_v1(&V1, now_millis, random_bytes, true).map(|bytes| uuid_text(&v1_to_v6(&bytes)))
}

// --- v7 ---------------------------------------------------------------------

/// `uuid`'s v7 state. `msecs` is `None` before the first reading, the package's `-Infinity`.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub(crate) struct V7State {
    pub(crate) msecs: Option<i64>,
    pub(crate) seq: i32,
}

/// `updateV7State`: a later millisecond takes a sequence from the random bytes; any other
/// reading counts on in 32 bits, and moves the millisecond on when the count wraps to zero.
pub(crate) fn update_v7_state(state: &mut V7State, now: i64, rnds: &Bytes) {
    if state.msecs.is_none_or(|msecs| now > msecs) {
        state.seq = (i32::from(rnds[6]) << 23) | (i32::from(rnds[7]) << 16) | (i32::from(rnds[8]) << 8) | i32::from(rnds[9]);
        state.msecs = Some(now);
    } else {
        state.seq = state.seq.wrapping_add(1);
        if state.seq == 0 {
            state.msecs = state.msecs.map(|msecs| msecs + 1);
        }
    }
}

fn v7_bytes(rnds: &Bytes, msecs: i64, seq: i32) -> Bytes {
    let msecs = msecs as f64;
    let seq = seq as u32;
    let byte = |divisor: f64| (to_int32(msecs / divisor) & 0xff) as u8;
    [
        byte(1_099_511_627_776.0),
        byte(4_294_967_296.0),
        byte(16_777_216.0),
        byte(65_536.0),
        byte(256.0),
        byte(1.0),
        0x70 | ((seq >> 28) & 0x0f) as u8,
        (seq >> 20) as u8,
        0x80 | ((seq >> 14) & 0x3f) as u8,
        (seq >> 6) as u8,
        ((seq << 2) as u8) | (rnds[10] & 0x03),
        rnds[11],
        rnds[12],
        rnds[13],
        rnds[14],
        rnds[15],
    ]
}

static V7: Mutex<V7State> = Mutex::new(V7State { msecs: None, seq: 0 });

fn next_v7(
    state: &Mutex<V7State>,
    clock: impl FnOnce() -> i64,
    random: impl FnOnce() -> Result<Bytes, RandomSourceUnavailable>,
) -> Result<Bytes, RandomSourceUnavailable> {
    let now = clock();
    let rnds = random()?;
    let updated = {
        let mut held = state.lock().expect("the UUID state's update never panics");
        update_v7_state(&mut held, now, &rnds);
        *held
    };
    Ok(v7_bytes(&rnds, updated.msecs.expect("an updated state holds its reading"), updated.seq))
}

/// `v7()`.
pub(crate) fn uuid_v7() -> Result<String, RandomSourceUnavailable> {
    next_v7(&V7, now_millis, random_bytes).map(|bytes| uuid_text(&bytes))
}

// --- v4 ---------------------------------------------------------------------

fn v4_bytes(mut rnds: Bytes) -> Bytes {
    rnds[6] = (rnds[6] & 0x0f) | 0x40;
    rnds[8] = (rnds[8] & 0x3f) | 0x80;
    rnds
}

/// `v4()`: sixteen random bytes, version 4 and the RFC variant set.
pub(crate) fn uuid_v4() -> Result<String, RandomSourceUnavailable> {
    random_bytes().map(|rnds| uuid_text(&v4_bytes(rnds)))
}

// --- v3 and v5 --------------------------------------------------------------

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// `validate()`: the package's pattern, `[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}`,
/// the nil UUID or the max UUID, the whole text, ignoring ASCII case.
pub(crate) fn uuid_validate(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    let shaped = bytes.iter().enumerate().all(|(at, &byte)| match at {
        8 | 13 | 18 | 23 => byte == b'-',
        _ => hex_value(byte).is_some(),
    });
    if !shaped {
        return false;
    }
    let digits = || bytes.iter().filter(|&&byte| byte != b'-');
    if digits().all(|&byte| byte == b'0') || digits().all(|&byte| byte.eq_ignore_ascii_case(&b'f')) {
        return true;
    }
    matches!(bytes[14], b'1'..=b'8') && matches!(bytes[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B')
}

/// `version()`: the version digit — 0 for the nil UUID and 15 for the max.
pub(crate) fn uuid_version(text: &str) -> Result<u8, InvalidUuid> {
    if !uuid_validate(text) {
        return Err(InvalidUuid);
    }
    Ok(hex_value(text.as_bytes()[14]).expect("a valid UUID's version is a hexadecimal digit"))
}

/// `parse()`: the sixteen bytes a valid UUID writes.
fn uuid_parse(text: &str) -> Result<Bytes, InvalidUuid> {
    if !uuid_validate(text) {
        return Err(InvalidUuid);
    }
    let mut digits = text.bytes().filter(|&byte| byte != b'-').map(|byte| hex_value(byte).expect("validated"));
    Ok(std::array::from_fn(|_| {
        let high = digits.next().expect("thirty-two digits");
        let low = digits.next().expect("thirty-two digits");
        (high << 4) | low
    }))
}

/// `v35`: the digest of the namespace's bytes and the name's UTF-8, version and variant set.
fn name_based(version: u8, digest: &[u8]) -> Bytes {
    let mut bytes: Bytes = digest[..16].try_into().expect("a digest of sixteen bytes or more");
    bytes[6] = (bytes[6] & 0x0f) | version;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    bytes
}

fn hashed_message(name: &str, namespace: &str) -> Result<Vec<u8>, InvalidUuid> {
    let mut message = uuid_parse(namespace)?.to_vec();
    message.extend_from_slice(name.as_bytes());
    Ok(message)
}

/// `v3(name, namespace)`: MD5.
pub(crate) fn uuid_v3(name: &str, namespace: &str) -> Result<String, InvalidUuid> {
    let message = hashed_message(name, namespace)?;
    Ok(uuid_text(&name_based(0x30, &md5(&message))))
}

/// `v5(name, namespace)`: SHA-1.
pub(crate) fn uuid_v5(name: &str, namespace: &str) -> Result<String, InvalidUuid> {
    let message = hashed_message(name, namespace)?;
    Ok(uuid_text(&name_based(0x50, &sha1(&message))))
}

#[cfg(test)]
mod tests {
    //! Every expected UUID, state and verdict is `uuid` 14.0.1's, executed under Node
    //! v24.21.0 (V8 13.6.233.17-node.53, ICU 78.3, tz 2026c) for `@telorun/cel 0.129.0 at
    //! 2ee5ef49`: its `v1`,
    //! `v3`, `v5`, `v6`, `v7`, `validate` and `version`, and the `updateV1State` and
    //! `updateV7State` its `v1.js` and `v7.js` export, run with the same clock readings and
    //! random bytes.

    use super::*;
    use std::collections::HashSet;

    fn bytes_of(hex: &str) -> Vec<u8> {
        (0..hex.len()).step_by(2).map(|at| u8::from_str_radix(&hex[at..at + 2], 16).expect("hex")).collect()
    }

    fn rnds_of(hex: &str) -> Bytes {
        bytes_of(hex).try_into().expect("sixteen bytes")
    }

    fn counting(fill: u8) -> Bytes {
        std::array::from_fn(|at| (at as u8).wrapping_mul(17).wrapping_add(fill))
    }

    #[test]
    fn rfc_9562_vectors() {
        let node = [0x9f, 0x6b, 0xde, 0xce, 0xd8, 0x46];
        let v1 = v1_bytes(&[0; 16], 1_645_557_742_000, 0, Some(0x33c8), Some(node));
        assert_eq!(uuid_text(&v1), "c232ab00-9414-11ec-b3c8-9f6bdeced846");
        let mut rnds = [0; 16];
        rnds[8] = 0x33;
        rnds[9] = 0xc8;
        rnds[10..].copy_from_slice(&node);
        assert_eq!(uuid_text(&v1_to_v6(&v1_bytes(&rnds, 1_645_557_742_000, 0, None, None))), "1ec9414c-232a-6b00-b3c8-9f6bdeced846");
        let rnds = rnds_of("00000000000000000000000c0c07398f");
        assert_eq!(uuid_text(&v7_bytes(&rnds, 0x017F_22E2_79B0, -868_863_689)), "017f22e2-79b0-7cc3-98c4-dc0c0c07398f");
        assert_eq!(uuid_v3("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8").as_deref(), Ok("5df41881-3aed-3515-88a7-2f4a814cf09e"));
        assert_eq!(uuid_v5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8").as_deref(), Ok("2ed6657d-e927-568b-95e1-2665a8aea6a2"));
        assert_eq!(uuid_v3("www.widgets.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8").as_deref(), Ok("3d813cbb-47fb-32ba-91df-831e1593ac29"));
    }

    #[test]
    fn name_based_uuids_as_uuid_answers_them() {
        for &(namespace, name, v3, v5) in NAME_BASED {
            let name = if name == "x×1000" { "x".repeat(1000) } else { name.to_owned() };
            assert_eq!(uuid_v3(&name, namespace).ok().as_deref(), v3, "v3 {namespace:?} {name:?}");
            assert_eq!(uuid_v5(&name, namespace).ok().as_deref(), v5, "v5 {namespace:?} {name:?}");
            assert_eq!(uuid_v3(&name, namespace).is_err(), v3.is_none());
        }
    }

    #[test]
    fn validates_and_reads_the_version_as_uuid_does() {
        for &(text, valid, version) in CHECKED {
            assert_eq!(uuid_validate(text), valid, "{text:?}");
            assert_eq!(uuid_version(text).ok(), version, "{text:?}");
        }
        assert_eq!(uuid_version("00000000-0000-0000-0000-000000000000"), Ok(0));
        assert_eq!(uuid_version("FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF"), Ok(15));
        assert_eq!(uuid_version("6ba7b810-9dad-11d1-80b4-00c04fd430c8\n"), Err(InvalidUuid));
    }

    /// A run of clock readings — the same millisecond, the next, backwards, the epoch,
    /// before it, the largest instant — each with its random bytes, through both states.
    #[test]
    fn state_updates_and_uuids_as_uuid_makes_them() {
        let mut v1 = V1State::default();
        let mut v7 = V7State::default();
        for &(now, rnds, msecs, nsecs, node, clockseq, v7_msecs, seq, v1_text, v6_text, v7_text) in STEPS {
            let rnds = rnds_of(rnds);
            update_v1_state(&mut v1, now, &rnds);
            update_v7_state(&mut v7, now, &rnds);
            let expected_node: [u8; 6] = bytes_of(node).try_into().expect("six bytes");
            assert_eq!(v1, V1State { msecs: Some(msecs), nsecs, node: Some(expected_node), clockseq }, "v1 at {now}");
            assert_eq!(v7, V7State { msecs: Some(v7_msecs), seq }, "v7 at {now}");
            assert_eq!(uuid_text(&v1_bytes(&rnds, msecs, nsecs, Some(clockseq), Some(expected_node))), v1_text);
            assert_eq!(uuid_text(&v1_to_v6(&v1_bytes(&rnds, msecs, nsecs, None, None))), v6_text);
            assert_eq!(uuid_text(&v7_bytes(&rnds, v7_msecs, seq)), v7_text);
        }
    }

    #[test]
    fn a_v1_count_of_ten_thousand_takes_a_new_node() {
        let fixed = counting(0);
        let node = Some([1, 2, 3, 4, 5, 6]);
        let mut state = V1State { msecs: Some(5), nsecs: 9998, node, clockseq: 7 };
        update_v1_state(&mut state, 5, &fixed);
        assert_eq!(state, V1State { msecs: Some(5), nsecs: 9999, node, clockseq: 7 });
        update_v1_state(&mut state, 5, &fixed);
        assert_eq!(state, V1State { msecs: Some(5), nsecs: 0, node: Some([0xab, 0xbb, 0xcc, 0xdd, 0xee, 0xff]), clockseq: 2201 });
        let mut back = V1State { msecs: Some(10), nsecs: 42, node, clockseq: 7 };
        update_v1_state(&mut back, 9, &fixed);
        assert_eq!(back, V1State { msecs: Some(9), nsecs: 42, node: Some([0xab, 0xbb, 0xcc, 0xdd, 0xee, 0xff]), clockseq: 2201 });
        let mut fresh = V1State::default();
        for _ in 0..10_001 {
            update_v1_state(&mut fresh, 77, &fixed);
        }
        assert_eq!(fresh, V1State { msecs: Some(77), nsecs: 0, node: Some([0xab, 0xbb, 0xcc, 0xdd, 0xee, 0xff]), clockseq: 2201 });
    }

    /// The v7 count runs in 32 bits: past `i32::MAX` it is negative, and at zero the
    /// millisecond moves on.
    #[test]
    fn a_v7_count_wraps_at_32_bits() {
        let fixed = counting(0);
        for (seq, msecs, next) in [(-1, 1001, 0), (i32::MAX, 1000, i32::MIN), (i32::MIN, 1000, i32::MIN + 1), (0, 1000, 1), (123, 1000, 124)] {
            let mut state = V7State { msecs: Some(1000), seq };
            update_v7_state(&mut state, 999, &fixed);
            assert_eq!(state, V7State { msecs: Some(msecs), seq: next }, "from {seq}");
        }
        let mut state = V7State { msecs: Some(1000), seq: 5 };
        update_v7_state(&mut state, 1001, &[255; 16]);
        assert_eq!(state, V7State { msecs: Some(1001), seq: i32::MAX });
    }

    /// JavaScript's number arithmetic at the ends: before the Gregorian epoch, the year 1,
    /// the epoch, 2^48 − 1 and the largest instant.
    #[test]
    fn uuid_bytes_at_the_ends_of_the_clock() {
        let fixed = counting(0);
        for (msecs, v1, v6, v7) in [
            (-12_219_292_800_000, "0000270f-0000-1000-bfff-000000000000", "00000000-0000-6000-8899-aabbccddeeff", "f5e3fa65-ac00-7fff-bfff-febbccddeeff"),
            (-12_219_292_800_001, "ffffffff-0000-1000-bfff-000000000000", "0000000f-fffd-68f0-8899-aabbccddeeff", "f5e3fa65-acff-7fff-bfff-febbccddeeff"),
            (-62_135_596_800_000, "1bcbe70f-9ddd-1912-bfff-000000000000", "9129ddd1-bcbc-6000-8899-aabbccddeeff", "c87deed4-2800-7fff-bfff-febbccddeeff"),
            (0, "1381670f-1dd2-11b2-bfff-000000000000", "1b21dd21-3814-6000-8899-aabbccddeeff", "00000000-0000-7fff-bfff-febbccddeeff"),
            (1, "13818e1f-1dd2-11b2-bfff-000000000000", "1b21dd21-3816-6710-8899-aabbccddeeff", "00000000-0001-7fff-bfff-febbccddeeff"),
            (281_474_976_710_655, "13813fff-1dd2-18c2-bfff-000000000000", "8c21dd21-3811-68f0-8899-aabbccddeeff", "ffffffff-ffff-7fff-bfff-febbccddeeff"),
            (8_640_000_000_000_000, "c541670f-940d-10bc-bfff-000000000000", "0bc940dc-5414-6000-8899-aabbccddeeff", "b208c2dc-0000-7fff-bfff-febbccddeeff"),
        ] {
            assert_eq!(uuid_text(&v1_bytes(&fixed, msecs, 9999, Some(0x3fff), Some([0; 6]))), v1, "v1 at {msecs}");
            assert_eq!(uuid_text(&v1_to_v6(&v1_bytes(&fixed, msecs, 0, None, None))), v6, "v6 at {msecs}");
            assert_eq!(uuid_text(&v7_bytes(&fixed, msecs, -1)), v7, "v7 at {msecs}");
        }
    }

    /// v6 advances the v1 state: a v6 in the millisecond of a v1 counts one on from it.
    #[test]
    fn v6_shares_the_v1_state() {
        let state = Mutex::new(V1State::default());
        let first = counting(1);
        let second = counting(2);
        next_v1(&state, || 1_767_225_600_000, || Ok(first), false).expect("answers");
        let v6 = next_v1(&state, || 1_767_225_600_000, || Ok(second), true).expect("answers");
        assert_eq!(v6, v1_bytes(&second, 1_767_225_600_000, 1, None, None));
        assert_eq!(state.lock().expect("held").nsecs, 1);
    }

    /// The clock and the random bytes are read before the state's lock is taken.
    #[test]
    fn the_lock_is_free_while_the_clock_and_the_source_are_read() {
        let v1 = Mutex::new(V1State::default());
        let v7 = Mutex::new(V7State::default());
        next_v1(&v1, || { assert!(v1.try_lock().is_ok()); 1 }, || { assert!(v1.try_lock().is_ok()); Ok(counting(0)) }, false).expect("answers");
        next_v1(&v1, || { assert!(v1.try_lock().is_ok()); 1 }, || { assert!(v1.try_lock().is_ok()); Ok(counting(0)) }, true).expect("answers");
        next_v7(&v7, || { assert!(v7.try_lock().is_ok()); 1 }, || { assert!(v7.try_lock().is_ok()); Ok(counting(0)) }).expect("answers");
    }

    #[test]
    fn a_failing_source_leaves_the_state_alone() {
        let v1 = Mutex::new(V1State::default());
        let v7 = Mutex::new(V7State::default());
        let failure = RandomSourceUnavailable { cause: getrandom::Error::UNSUPPORTED };
        assert_eq!(next_v1(&v1, || 1, || Err(failure), false), Err(failure));
        assert_eq!(next_v7(&v7, || 1, || Err(failure)), Err(failure));
        assert_eq!(*v1.lock().expect("held"), V1State::default());
        assert_eq!(*v7.lock().expect("held"), V7State::default());
    }

    #[test]
    fn v4_is_random_bytes_with_version_and_variant() {
        assert_eq!(uuid_text(&v4_bytes([0xff; 16])), "ffffffff-ffff-4fff-bfff-ffffffffffff");
        assert_eq!(uuid_text(&v4_bytes([0; 16])), "00000000-0000-4000-8000-000000000000");
        let made: HashSet<String> = (0..1000).map(|_| uuid_v4().expect("the source answers")).collect();
        assert_eq!(made.len(), 1000);
        assert!(made.iter().all(|text| uuid_version(text) == Ok(4)));
    }

    /// The tests that read the process's own state take turns.
    static PROCESS_STATE: Mutex<()> = Mutex::new(());

    /// `uuid_v6` advances the process's v1 state, and its timestamp is the state's.
    #[test]
    fn the_process_v6_advances_the_v1_state() {
        let _turn = PROCESS_STATE.lock().expect("held");
        uuid_v1().expect("the source answers");
        let before = *V1.lock().expect("held");
        let v6 = uuid_v6().expect("the source answers");
        let after = *V1.lock().expect("held");
        assert_ne!(before, after);
        let hex = v6.replace('-', "");
        let digits = format!("{}{}", &hex[..12], &hex[13..16]);
        let expected = ((after.msecs.expect("read") + 12_219_292_800_000) as u64 * 10_000 + after.nsecs as u64) & ((1 << 60) - 1);
        assert_eq!(u64::from_str_radix(&digits, 16), Ok(expected));
    }

    /// Eight threads making v1 and v7 UUIDs at once over the process's state: every one is
    /// distinct, and each thread's v7s rise.
    #[test]
    fn eight_threads_share_the_state() {
        let _turn = PROCESS_STATE.lock().expect("held");
        let threads: Vec<_> = (0..8)
            .map(|_| {
                std::thread::spawn(|| {
                    let mut made = Vec::with_capacity(40_000);
                    let mut last_v7 = String::new();
                    for _ in 0..20_000 {
                        made.push(uuid_v1().expect("the source answers"));
                        let v7 = uuid_v7().expect("the source answers");
                        assert!(v7 > last_v7, "{v7} after {last_v7}");
                        last_v7.clone_from(&v7);
                        made.push(v7);
                    }
                    made
                })
            })
            .collect();
        let mut all = HashSet::new();
        for thread in threads {
            for made in thread.join().expect("the thread completes") {
                assert!(all.insert(made));
            }
        }
        assert_eq!(all.len(), 320_000);
        assert_eq!(uuid_version(&uuid_v6().expect("the source answers")), Ok(6));
    }

    /// `(namespace, name, v3(name, namespace), v5(name, namespace))`, `None` where `uuid` throws `Invalid UUID`.
    const NAME_BASED: &[(&str, &str, Option<&str>, Option<&str>)] = &[
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "", Some("c87ee674-4ddc-3efe-a74e-dfe25da5d7b3"), Some("4ebd0208-8328-5d69-8c44-ec50939c0967")),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "a", Some("4c104dd0-4821-30d5-9ce3-0e7a1f8b7c0d"), Some("4f3f2898-69e3-5a0d-820a-c4e87987dbce")),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "www.example.com", Some("5df41881-3aed-3515-88a7-2f4a814cf09e"), Some("2ed6657d-e927-568b-95e1-2665a8aea6a2")),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "python.org", Some("6fa459ea-ee8a-3ca4-894e-db77e160355e"), Some("886313e1-3b8a-5372-9b90-0c9aee199e5d")),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "😀", Some("4ee426a1-9210-355a-9c1d-505466d19eb5"), Some("52096f1e-2b44-5520-929f-9e587f0f4899")),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "é", Some("3a356d77-46a8-3ec1-8205-b80596740632"), Some("ebfe0af8-3997-5ade-b634-ba92cf69f557")),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "Straße", Some("dabdf274-1b53-34d8-823a-c50aac21148c"), Some("adbd7160-bf7f-503d-ab5a-5b6d14ae781d")),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "日本語", Some("f9e3b804-0a0d-3dd0-a874-0baf0cb21aab"), Some("9786f370-913c-51ea-845e-7f3469bc5966")),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "x×1000", Some("fc7824ed-b6de-340b-8ec5-8ce01b490bd7"), Some("f6d12730-a238-51ed-bf69-3689855f9bbf")),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "\n", Some("2ccd7176-ce43-324b-a3e2-51135c301e3d"), Some("eabb2961-e9dc-5b2a-a15f-69b95c896f0b")),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c8", " ", Some("ad4c985d-0c36-39ed-812e-9f52b217e22d"), Some("e4651143-99bb-5707-b2a5-93f9534add4f")),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "a\0b", Some("002a0ada-f547-375a-bab5-896a11d1927e"), Some("0a63f66b-e02f-5d2d-9fd4-aad819cf5352")),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "􏿿", Some("b563a77f-706a-3c14-840b-23e884253305"), Some("b3e2daa1-4e3f-5c57-9cef-281b2f2ae5b3")),
        ("6ba7b811-9dad-11d1-80b4-00c04fd430c8", "", Some("14cdb9b4-de01-3faa-aff5-65bc2f771745"), Some("1b4db7eb-4057-5ddf-91e0-36dec72071f5")),
        ("6ba7b811-9dad-11d1-80b4-00c04fd430c8", "a", Some("33838e93-63bc-3732-bf9e-b68d970b79c2"), Some("e1407479-3136-56c0-9908-bb02fb0339e2")),
        ("6ba7b811-9dad-11d1-80b4-00c04fd430c8", "www.example.com", Some("a777199a-c522-31c4-8f4b-335feec7215b"), Some("b63cdfa4-3df9-568e-97ae-006c5b8fd652")),
        ("6ba7b811-9dad-11d1-80b4-00c04fd430c8", "python.org", Some("22fe6191-c161-3d86-a432-a81f343eda08"), Some("7af94e2b-4dd9-50f0-9c9a-8a48519bdef0")),
        ("6ba7b811-9dad-11d1-80b4-00c04fd430c8", "😀", Some("61de432c-c2e8-3f22-b369-f87d0a010d0b"), Some("f0793165-4aab-598c-9164-4efc598481b2")),
        ("6ba7b811-9dad-11d1-80b4-00c04fd430c8", "é", Some("cf43a1a7-73ba-3f29-a1f8-6a00e2deece6"), Some("10e1d6de-dc68-53f0-883a-30ec870dd739")),
        ("6ba7b811-9dad-11d1-80b4-00c04fd430c8", "Straße", Some("3bfb0a99-cef6-3805-97c5-2834571a54a4"), Some("43911992-cd1e-5e78-95b0-fa78838024d1")),
        ("6ba7b811-9dad-11d1-80b4-00c04fd430c8", "日本語", Some("41e0d515-537f-35bf-91f3-d5d5ebb74baf"), Some("7d340f48-c165-55f5-8ac5-8d642da1c20d")),
        ("6ba7b811-9dad-11d1-80b4-00c04fd430c8", "x×1000", Some("ba1e1cdf-2d61-3212-baf9-16264e17408a"), Some("68491f23-75a7-557d-943b-00881c13ae1e")),
        ("6ba7b811-9dad-11d1-80b4-00c04fd430c8", "\n", Some("2a310a0d-74cb-30ed-b4d1-0c1412b1f80b"), Some("6b9822e5-560c-5dd6-8c22-6fc5fb837c47")),
        ("6ba7b811-9dad-11d1-80b4-00c04fd430c8", " ", Some("74f4890e-3f88-3248-bad3-02d275a636a0"), Some("e0ccaace-c027-52a5-a807-2065497f8860")),
        ("6ba7b811-9dad-11d1-80b4-00c04fd430c8", "a\0b", Some("5ce262b2-00ae-38e4-9ed2-1a7ce9c526a5"), Some("7881dd1e-3474-5a4c-847c-b4137040609a")),
        ("6ba7b811-9dad-11d1-80b4-00c04fd430c8", "􏿿", Some("c92b309f-08f3-319a-9df8-139c4cca7532"), Some("61f9d275-0e1f-5330-9108-33be210c35fa")),
        ("6ba7b812-9dad-11d1-80b4-00c04fd430c8", "", Some("596b79dc-00dd-3991-a72f-d3696c38c64f"), Some("0a68eb57-c88a-5f34-9e9d-27f85e68af4f")),
        ("6ba7b812-9dad-11d1-80b4-00c04fd430c8", "a", Some("a20740b4-71b5-3b90-852e-bdb859da9fdd"), Some("d720e32d-4765-5177-b65b-42dd7f6e6445")),
        ("6ba7b812-9dad-11d1-80b4-00c04fd430c8", "www.example.com", Some("c2c1e4de-6589-389e-9375-32a90c6a83a8"), Some("a5e87d3b-479e-52da-b98a-db251a851854")),
        ("6ba7b812-9dad-11d1-80b4-00c04fd430c8", "python.org", Some("edc9f521-7078-3737-aeed-76056ffc7959"), Some("cd5d0bff-2444-5d26-ab53-4f7db1cb733d")),
        ("6ba7b812-9dad-11d1-80b4-00c04fd430c8", "😀", Some("7f75cb32-d63d-3b4c-a85f-26e7da8599e0"), Some("60bcfc3c-0bf6-5ade-902f-1d3c45ea37a7")),
        ("6ba7b812-9dad-11d1-80b4-00c04fd430c8", "é", Some("1a3d3880-8407-3402-a599-d49648585f49"), Some("4c9d8941-1dcb-56d3-9fe5-b5aef28ef637")),
        ("6ba7b812-9dad-11d1-80b4-00c04fd430c8", "Straße", Some("b2624144-efd7-3e41-b74d-38313468e4de"), Some("14b143b6-45b4-57ae-81b4-1dc83972be1e")),
        ("6ba7b812-9dad-11d1-80b4-00c04fd430c8", "日本語", Some("971d34d5-889b-3eab-bdf8-c015c35fe864"), Some("9b95cc93-0d1f-5a68-8a5a-c1548f02488b")),
        ("6ba7b812-9dad-11d1-80b4-00c04fd430c8", "x×1000", Some("2c90be6b-41ad-34a5-83ca-c6d652384d49"), Some("0ee7e31f-a49b-55bf-a896-2c72533f360c")),
        ("6ba7b812-9dad-11d1-80b4-00c04fd430c8", "\n", Some("8ca85ccd-d4e1-3586-80a9-4343017e18fb"), Some("ce1dbb22-0d7e-5b98-9c63-0462d7ddf056")),
        ("6ba7b812-9dad-11d1-80b4-00c04fd430c8", " ", Some("b4d9e9f8-7a9f-36e3-aab3-71cb7e1d3c4a"), Some("30ad1567-db66-54b2-a9db-034700f81b17")),
        ("6ba7b812-9dad-11d1-80b4-00c04fd430c8", "a\0b", Some("e96fca8b-1039-3575-8743-4d17261037a8"), Some("7b3b400f-4415-5958-a230-454632df1c5d")),
        ("6ba7b812-9dad-11d1-80b4-00c04fd430c8", "􏿿", Some("cf40bdea-cbf1-3a8a-a21c-d049feb40c83"), Some("326c6bef-5df9-5143-9602-e3754d4f8694")),
        ("6ba7b814-9dad-11d1-80b4-00c04fd430c8", "", Some("7aaf118c-f174-3eba-9ec5-680cd791a020"), Some("b4bdf874-8c03-5bd8-8fd7-5e409dfd82c0")),
        ("6ba7b814-9dad-11d1-80b4-00c04fd430c8", "a", Some("501a4af4-b763-3357-87ea-eaac989f199d"), Some("54a0a790-c611-5b5b-b50e-ff01490ecdfa")),
        ("6ba7b814-9dad-11d1-80b4-00c04fd430c8", "www.example.com", Some("f4ea5e25-91d4-38b0-b74f-af6c57210cae"), Some("a1d3adb1-15b7-5395-a05f-9051a08769a2")),
        ("6ba7b814-9dad-11d1-80b4-00c04fd430c8", "python.org", Some("94c1b751-792a-3c8b-8eb7-95ea2c6645bb"), Some("e9246a06-296f-5b50-be57-0519806c97e8")),
        ("6ba7b814-9dad-11d1-80b4-00c04fd430c8", "😀", Some("d236d2bb-c97d-3830-8eb8-7af18d8f6793"), Some("9f83a997-144c-5fad-9c02-82965caff4d2")),
        ("6ba7b814-9dad-11d1-80b4-00c04fd430c8", "é", Some("20c22913-7363-3451-acc1-9a072290e0e5"), Some("d13e05fb-cfd5-575b-8154-f5979b02b254")),
        ("6ba7b814-9dad-11d1-80b4-00c04fd430c8", "Straße", Some("689bb741-1737-3fd0-b44f-b12e2acd7ada"), Some("7922cfa9-adcc-556f-9208-808396d2347b")),
        ("6ba7b814-9dad-11d1-80b4-00c04fd430c8", "日本語", Some("c3c901e8-917f-3678-9551-3eaa4a3c9561"), Some("d6a3c043-f8a4-550a-8393-7b4ca7c2e1ce")),
        ("6ba7b814-9dad-11d1-80b4-00c04fd430c8", "x×1000", Some("61852423-f841-37a1-aa7f-8d0c2c1f8794"), Some("8f61a586-4256-50a9-9c5c-c33dc7cff218")),
        ("6ba7b814-9dad-11d1-80b4-00c04fd430c8", "\n", Some("7c877458-0aa7-3e1d-8670-55e2fc6e89e2"), Some("44f7706c-36da-5b21-b1c4-41e0746e19f1")),
        ("6ba7b814-9dad-11d1-80b4-00c04fd430c8", " ", Some("23d77d8f-e4cc-3685-a90f-0f99ac4ae8d1"), Some("927f762a-89d2-58a6-bd1f-c74d6c1e1378")),
        ("6ba7b814-9dad-11d1-80b4-00c04fd430c8", "a\0b", Some("c1576095-51a7-3c69-88f8-ec03a6f8b554"), Some("ecb68dec-0597-5fed-b8af-fbaa8cfef2f7")),
        ("6ba7b814-9dad-11d1-80b4-00c04fd430c8", "􏿿", Some("60e5eee1-491e-371c-ad5a-9bb8292a591b"), Some("3c5c99e1-6786-5024-b3ed-c5c7b146916e")),
        ("00000000-0000-0000-0000-000000000000", "", Some("4ae71336-e44b-39bf-b9d2-752e234818a5"), Some("e129f27c-5103-5c5c-844b-cdf0a15e160d")),
        ("00000000-0000-0000-0000-000000000000", "a", Some("0531103a-d8fc-3dd4-b972-d98e4750994e"), Some("35b65f33-a679-5e76-af3c-273ea349ede4")),
        ("00000000-0000-0000-0000-000000000000", "www.example.com", Some("e1dbb77c-40ca-39dd-a59b-3973a877b11b"), Some("399fc331-be2b-5b56-b676-d6f38dae5aaa")),
        ("00000000-0000-0000-0000-000000000000", "python.org", Some("0421fac3-a9c6-3ea3-aee8-8f20aff3f278"), Some("93128362-2d8d-548e-84ff-e93cd1378be5")),
        ("00000000-0000-0000-0000-000000000000", "😀", Some("f446c78a-d903-36d8-9e39-50a9cf8982ca"), Some("ed9395b9-a2ae-56ca-9445-71a0432a2aba")),
        ("00000000-0000-0000-0000-000000000000", "é", Some("3d862ef1-b058-35da-b67c-26a5d5d1ea66"), Some("ed49db43-7e04-576f-8b0f-7b95da62fc9c")),
        ("00000000-0000-0000-0000-000000000000", "Straße", Some("b34bf16c-a497-3c78-b80c-939709982c24"), Some("a8d04f41-fd06-5d53-b859-6a5cd7e73f9a")),
        ("00000000-0000-0000-0000-000000000000", "日本語", Some("0e9fa5c8-0582-3056-931f-0ea169201fec"), Some("52148488-55ac-500b-ac94-96094b734d07")),
        ("00000000-0000-0000-0000-000000000000", "x×1000", Some("d730a91b-ff93-3e40-985e-a3af092c4090"), Some("eb4f0d86-5740-5307-9578-a50bbed6d9a9")),
        ("00000000-0000-0000-0000-000000000000", "\n", Some("4f3fc553-924d-3ed1-8857-588f8edfc4e3"), Some("c8dc4bf5-e405-5004-8ee8-5d5101bfaaf3")),
        ("00000000-0000-0000-0000-000000000000", " ", Some("afd59108-0604-321a-a47f-566712b593c7"), Some("06921d9c-e2aa-5308-9817-b8f902bfde05")),
        ("00000000-0000-0000-0000-000000000000", "a\0b", Some("8156568e-4ae6-3f34-a93e-18e2c6cbbf78"), Some("a7650b9f-f19f-5300-8a13-91160ea8de2c")),
        ("00000000-0000-0000-0000-000000000000", "􏿿", Some("30ccf226-966e-30eb-87d5-9271b9f18798"), Some("f1bd36d5-dcbb-51fe-9e65-0b0ca3c09e59")),
        ("ffffffff-ffff-ffff-ffff-ffffffffffff", "", Some("8d79cbc9-a4ec-3de1-92fc-91ba625b13c2"), Some("52e0e9d4-f46c-57ca-9bcb-0708d1863369")),
        ("ffffffff-ffff-ffff-ffff-ffffffffffff", "a", Some("df7deefd-be40-3497-96e2-f993fd08ce08"), Some("060edf93-465a-5b8d-ae9f-f26981b42a3d")),
        ("ffffffff-ffff-ffff-ffff-ffffffffffff", "www.example.com", Some("24ee1ef6-7a07-3d3c-becc-73acb814a207"), Some("8a315bc9-eb0b-5330-8d92-2f3b7b55e0ac")),
        ("ffffffff-ffff-ffff-ffff-ffffffffffff", "python.org", Some("74013f1a-fb30-3086-ab48-de2a19839698"), Some("a41f099a-490a-57aa-a997-7dbcd912c96e")),
        ("ffffffff-ffff-ffff-ffff-ffffffffffff", "😀", Some("f257d300-58db-35f9-ad73-6c1c7c17d87c"), Some("7302f867-d8dd-5f37-a0fc-4cdb23022b93")),
        ("ffffffff-ffff-ffff-ffff-ffffffffffff", "é", Some("3ac57cdd-aa58-3df8-b5b2-aed2d818ea84"), Some("f5da4834-fb17-5531-bf80-18d60a84221e")),
        ("ffffffff-ffff-ffff-ffff-ffffffffffff", "Straße", Some("30a97f21-cab3-3667-921f-451cf15e4375"), Some("45dead0c-e196-52ed-89ea-da1d3cfe51ea")),
        ("ffffffff-ffff-ffff-ffff-ffffffffffff", "日本語", Some("ab72b7ac-d5d3-3368-b412-1c5470440355"), Some("faeaeecb-7280-57b2-9784-59059f97834b")),
        ("ffffffff-ffff-ffff-ffff-ffffffffffff", "x×1000", Some("765aadc7-f0db-3ee1-a939-1eacf1330a87"), Some("91db8aa8-1d00-59df-9651-a3e9738893aa")),
        ("ffffffff-ffff-ffff-ffff-ffffffffffff", "\n", Some("b5585e3f-95b8-3a38-a854-7a0c1013d514"), Some("2d730ed1-bcf3-5a2f-bc73-ed2be3699395")),
        ("ffffffff-ffff-ffff-ffff-ffffffffffff", " ", Some("38bc7c22-c4f4-3da7-8bca-7857a3f8b49e"), Some("6b030b1a-cac6-52c1-ab90-1013e54dc8f8")),
        ("ffffffff-ffff-ffff-ffff-ffffffffffff", "a\0b", Some("ed64ded0-bc58-3e45-92a4-4c7b733d2fc3"), Some("996b926b-7750-502d-95e4-87bb70bd0571")),
        ("ffffffff-ffff-ffff-ffff-ffffffffffff", "􏿿", Some("551b18d2-0c46-36fc-aeba-2a57812c8e54"), Some("addc510b-8c89-5c07-bde7-c8e71e07a70a")),
        ("FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF", "", Some("8d79cbc9-a4ec-3de1-92fc-91ba625b13c2"), Some("52e0e9d4-f46c-57ca-9bcb-0708d1863369")),
        ("FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF", "a", Some("df7deefd-be40-3497-96e2-f993fd08ce08"), Some("060edf93-465a-5b8d-ae9f-f26981b42a3d")),
        ("FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF", "www.example.com", Some("24ee1ef6-7a07-3d3c-becc-73acb814a207"), Some("8a315bc9-eb0b-5330-8d92-2f3b7b55e0ac")),
        ("FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF", "python.org", Some("74013f1a-fb30-3086-ab48-de2a19839698"), Some("a41f099a-490a-57aa-a997-7dbcd912c96e")),
        ("FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF", "😀", Some("f257d300-58db-35f9-ad73-6c1c7c17d87c"), Some("7302f867-d8dd-5f37-a0fc-4cdb23022b93")),
        ("FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF", "é", Some("3ac57cdd-aa58-3df8-b5b2-aed2d818ea84"), Some("f5da4834-fb17-5531-bf80-18d60a84221e")),
        ("FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF", "Straße", Some("30a97f21-cab3-3667-921f-451cf15e4375"), Some("45dead0c-e196-52ed-89ea-da1d3cfe51ea")),
        ("FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF", "日本語", Some("ab72b7ac-d5d3-3368-b412-1c5470440355"), Some("faeaeecb-7280-57b2-9784-59059f97834b")),
        ("FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF", "x×1000", Some("765aadc7-f0db-3ee1-a939-1eacf1330a87"), Some("91db8aa8-1d00-59df-9651-a3e9738893aa")),
        ("FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF", "\n", Some("b5585e3f-95b8-3a38-a854-7a0c1013d514"), Some("2d730ed1-bcf3-5a2f-bc73-ed2be3699395")),
        ("FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF", " ", Some("38bc7c22-c4f4-3da7-8bca-7857a3f8b49e"), Some("6b030b1a-cac6-52c1-ab90-1013e54dc8f8")),
        ("FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF", "a\0b", Some("ed64ded0-bc58-3e45-92a4-4c7b733d2fc3"), Some("996b926b-7750-502d-95e4-87bb70bd0571")),
        ("FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF", "􏿿", Some("551b18d2-0c46-36fc-aeba-2a57812c8e54"), Some("addc510b-8c89-5c07-bde7-c8e71e07a70a")),
        ("6BA7B810-9DAD-11D1-80B4-00C04FD430C8", "", Some("c87ee674-4ddc-3efe-a74e-dfe25da5d7b3"), Some("4ebd0208-8328-5d69-8c44-ec50939c0967")),
        ("6BA7B810-9DAD-11D1-80B4-00C04FD430C8", "a", Some("4c104dd0-4821-30d5-9ce3-0e7a1f8b7c0d"), Some("4f3f2898-69e3-5a0d-820a-c4e87987dbce")),
        ("6BA7B810-9DAD-11D1-80B4-00C04FD430C8", "www.example.com", Some("5df41881-3aed-3515-88a7-2f4a814cf09e"), Some("2ed6657d-e927-568b-95e1-2665a8aea6a2")),
        ("6BA7B810-9DAD-11D1-80B4-00C04FD430C8", "python.org", Some("6fa459ea-ee8a-3ca4-894e-db77e160355e"), Some("886313e1-3b8a-5372-9b90-0c9aee199e5d")),
        ("6BA7B810-9DAD-11D1-80B4-00C04FD430C8", "😀", Some("4ee426a1-9210-355a-9c1d-505466d19eb5"), Some("52096f1e-2b44-5520-929f-9e587f0f4899")),
        ("6BA7B810-9DAD-11D1-80B4-00C04FD430C8", "é", Some("3a356d77-46a8-3ec1-8205-b80596740632"), Some("ebfe0af8-3997-5ade-b634-ba92cf69f557")),
        ("6BA7B810-9DAD-11D1-80B4-00C04FD430C8", "Straße", Some("dabdf274-1b53-34d8-823a-c50aac21148c"), Some("adbd7160-bf7f-503d-ab5a-5b6d14ae781d")),
        ("6BA7B810-9DAD-11D1-80B4-00C04FD430C8", "日本語", Some("f9e3b804-0a0d-3dd0-a874-0baf0cb21aab"), Some("9786f370-913c-51ea-845e-7f3469bc5966")),
        ("6BA7B810-9DAD-11D1-80B4-00C04FD430C8", "x×1000", Some("fc7824ed-b6de-340b-8ec5-8ce01b490bd7"), Some("f6d12730-a238-51ed-bf69-3689855f9bbf")),
        ("6BA7B810-9DAD-11D1-80B4-00C04FD430C8", "\n", Some("2ccd7176-ce43-324b-a3e2-51135c301e3d"), Some("eabb2961-e9dc-5b2a-a15f-69b95c896f0b")),
        ("6BA7B810-9DAD-11D1-80B4-00C04FD430C8", " ", Some("ad4c985d-0c36-39ed-812e-9f52b217e22d"), Some("e4651143-99bb-5707-b2a5-93f9534add4f")),
        ("6BA7B810-9DAD-11D1-80B4-00C04FD430C8", "a\0b", Some("002a0ada-f547-375a-bab5-896a11d1927e"), Some("0a63f66b-e02f-5d2d-9fd4-aad819cf5352")),
        ("6BA7B810-9DAD-11D1-80B4-00C04FD430C8", "􏿿", Some("b563a77f-706a-3c14-840b-23e884253305"), Some("b3e2daa1-4e3f-5c57-9cef-281b2f2ae5b3")),
        ("f81d4fae-7dec-41d0-a765-00a0c91e6bf6", "", Some("05d568ad-0653-3875-9997-cc4c0a0e3baa"), Some("2e090527-6d62-5adf-97ca-d3bd2ed8736e")),
        ("f81d4fae-7dec-41d0-a765-00a0c91e6bf6", "a", Some("1f5ccbcc-8e7b-34f9-9541-d7e88fefef4d"), Some("7ab3f8a0-ebc5-508f-bd48-8128a861a567")),
        ("f81d4fae-7dec-41d0-a765-00a0c91e6bf6", "www.example.com", Some("ed9b85d1-b12c-3980-a51a-50a7cb02f760"), Some("82cdcc2e-5c17-5fd0-a118-fc8274526a64")),
        ("f81d4fae-7dec-41d0-a765-00a0c91e6bf6", "python.org", Some("1dec53e6-0ce8-3b02-8461-c516459ae04b"), Some("96f84398-7eb4-524e-a226-1065d29c0d6a")),
        ("f81d4fae-7dec-41d0-a765-00a0c91e6bf6", "😀", Some("0885086e-7dad-39e7-b3ed-45eb27f84940"), Some("f5e9c1f3-87ad-5ad5-b309-c4de9dce1e78")),
        ("f81d4fae-7dec-41d0-a765-00a0c91e6bf6", "é", Some("1a3f67e2-385e-3ab7-a292-9e0b157a5eb9"), Some("60efff3f-655b-59b6-8491-8a1d3907c3bf")),
        ("f81d4fae-7dec-41d0-a765-00a0c91e6bf6", "Straße", Some("e79e9d56-5b40-3deb-86b9-408bb87e6cc4"), Some("5ecf1c09-9544-52e3-be29-bbf81efda174")),
        ("f81d4fae-7dec-41d0-a765-00a0c91e6bf6", "日本語", Some("d6eba44e-ec77-33fc-a167-585d1e909205"), Some("7750388f-e1b3-5b20-adcd-5b58d5e7733d")),
        ("f81d4fae-7dec-41d0-a765-00a0c91e6bf6", "x×1000", Some("0820a5d1-94ac-30fb-88f9-bad308f1e18c"), Some("7740e412-b883-5282-b58d-3e49fe656177")),
        ("f81d4fae-7dec-41d0-a765-00a0c91e6bf6", "\n", Some("d592d386-df91-34c8-9ee0-92a9ecf9adca"), Some("c6aa4623-11f1-5392-a748-e922b9300329")),
        ("f81d4fae-7dec-41d0-a765-00a0c91e6bf6", " ", Some("de4aa8a0-099c-308b-a960-da291eb9233a"), Some("8424dedd-aeae-5fbc-bc20-af6c4393d41f")),
        ("f81d4fae-7dec-41d0-a765-00a0c91e6bf6", "a\0b", Some("3b29a0d7-cf00-3f4d-8e1b-4cd6037e775e"), Some("056e81fb-40e9-54e3-9d7d-1d855161f5e4")),
        ("f81d4fae-7dec-41d0-a765-00a0c91e6bf6", "􏿿", Some("db88b0f1-114b-33ea-a53f-23be3d8972f6"), Some("ee393f06-de8e-55d5-83e5-7525f7676620")),
        ("0190163d-8694-739b-aea5-966c26f8ad91", "", Some("87822abd-8b2c-3eca-8a60-178b6ec7dc01"), Some("1b3edf73-5a1e-55d5-8dc6-c9932753de64")),
        ("0190163d-8694-739b-aea5-966c26f8ad91", "a", Some("c9de8c61-8e38-3889-a0b9-204bfe39494f"), Some("2b4e2895-30ec-5329-bcc1-7081256a17e2")),
        ("0190163d-8694-739b-aea5-966c26f8ad91", "www.example.com", Some("d1fd88af-4f2b-3e85-a62a-d6af37b6d295"), Some("16d49e20-1947-5cf1-ba72-f32de652e326")),
        ("0190163d-8694-739b-aea5-966c26f8ad91", "python.org", Some("8ed2ce23-4047-3244-a02d-158654df7b91"), Some("fbd7b11a-f8ac-59df-88f1-dc50839dac5e")),
        ("0190163d-8694-739b-aea5-966c26f8ad91", "😀", Some("1318e0ee-8476-33f9-a808-f4caa3d2fc24"), Some("7b86563c-5019-51de-8efd-19f09d4a7f82")),
        ("0190163d-8694-739b-aea5-966c26f8ad91", "é", Some("1e9f32ef-2bc8-34ed-a8de-56e639e307f0"), Some("36b43564-fbd2-559e-96c0-ebf3c0d2a4f0")),
        ("0190163d-8694-739b-aea5-966c26f8ad91", "Straße", Some("0c86b2b2-28ac-374d-8322-87b495fb9c56"), Some("7e685126-01ec-5ecd-9099-419de72244a6")),
        ("0190163d-8694-739b-aea5-966c26f8ad91", "日本語", Some("d9018ba5-b8a8-34a4-bdf9-a5fcd6951557"), Some("da954996-9e06-5dba-bc59-f800c932198c")),
        ("0190163d-8694-739b-aea5-966c26f8ad91", "x×1000", Some("1a52e530-5271-3743-92a0-ad4c4a537cdc"), Some("0df19270-c6b0-5769-98f2-9f93233bc877")),
        ("0190163d-8694-739b-aea5-966c26f8ad91", "\n", Some("c46e1c4f-0cff-386d-b9ca-c745bd7d9b35"), Some("0692daf9-f146-5227-9014-37444a0e8040")),
        ("0190163d-8694-739b-aea5-966c26f8ad91", " ", Some("780f7148-7953-37fe-902d-fb722a910b59"), Some("6440e650-b076-5ff7-bbae-c121832d9cfc")),
        ("0190163d-8694-739b-aea5-966c26f8ad91", "a\0b", Some("ea9eef22-1673-381c-b7f0-e9d9ad69bd51"), Some("991404a3-d9d3-5c44-bb0d-3233f844554e")),
        ("0190163d-8694-739b-aea5-966c26f8ad91", "􏿿", Some("56eddd91-bb8e-3a7a-9dc1-1919f95305ff"), Some("1b7de389-ef15-5f58-a127-17e808045e69")),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c", "", None, None),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c", "a", None, None),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c", "www.example.com", None, None),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c", "python.org", None, None),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c", "😀", None, None),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c", "é", None, None),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c", "Straße", None, None),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c", "日本語", None, None),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c", "x×1000", None, None),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c", "\n", None, None),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c", " ", None, None),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c", "a\0b", None, None),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c", "􏿿", None, None),
        ("6ba7b810-9dad-01d1-80b4-00c04fd430c8", "", None, None),
        ("6ba7b810-9dad-01d1-80b4-00c04fd430c8", "a", None, None),
        ("6ba7b810-9dad-01d1-80b4-00c04fd430c8", "www.example.com", None, None),
        ("6ba7b810-9dad-01d1-80b4-00c04fd430c8", "python.org", None, None),
        ("6ba7b810-9dad-01d1-80b4-00c04fd430c8", "😀", None, None),
        ("6ba7b810-9dad-01d1-80b4-00c04fd430c8", "é", None, None),
        ("6ba7b810-9dad-01d1-80b4-00c04fd430c8", "Straße", None, None),
        ("6ba7b810-9dad-01d1-80b4-00c04fd430c8", "日本語", None, None),
        ("6ba7b810-9dad-01d1-80b4-00c04fd430c8", "x×1000", None, None),
        ("6ba7b810-9dad-01d1-80b4-00c04fd430c8", "\n", None, None),
        ("6ba7b810-9dad-01d1-80b4-00c04fd430c8", " ", None, None),
        ("6ba7b810-9dad-01d1-80b4-00c04fd430c8", "a\0b", None, None),
        ("6ba7b810-9dad-01d1-80b4-00c04fd430c8", "􏿿", None, None),
        ("6ba7b810-9dad-11d1-c0b4-00c04fd430c8", "", None, None),
        ("6ba7b810-9dad-11d1-c0b4-00c04fd430c8", "a", None, None),
        ("6ba7b810-9dad-11d1-c0b4-00c04fd430c8", "www.example.com", None, None),
        ("6ba7b810-9dad-11d1-c0b4-00c04fd430c8", "python.org", None, None),
        ("6ba7b810-9dad-11d1-c0b4-00c04fd430c8", "😀", None, None),
        ("6ba7b810-9dad-11d1-c0b4-00c04fd430c8", "é", None, None),
        ("6ba7b810-9dad-11d1-c0b4-00c04fd430c8", "Straße", None, None),
        ("6ba7b810-9dad-11d1-c0b4-00c04fd430c8", "日本語", None, None),
        ("6ba7b810-9dad-11d1-c0b4-00c04fd430c8", "x×1000", None, None),
        ("6ba7b810-9dad-11d1-c0b4-00c04fd430c8", "\n", None, None),
        ("6ba7b810-9dad-11d1-c0b4-00c04fd430c8", " ", None, None),
        ("6ba7b810-9dad-11d1-c0b4-00c04fd430c8", "a\0b", None, None),
        ("6ba7b810-9dad-11d1-c0b4-00c04fd430c8", "􏿿", None, None),
        (" 6ba7b810-9dad-11d1-80b4-00c04fd430c8", "", None, None),
        (" 6ba7b810-9dad-11d1-80b4-00c04fd430c8", "a", None, None),
        (" 6ba7b810-9dad-11d1-80b4-00c04fd430c8", "www.example.com", None, None),
        (" 6ba7b810-9dad-11d1-80b4-00c04fd430c8", "python.org", None, None),
        (" 6ba7b810-9dad-11d1-80b4-00c04fd430c8", "😀", None, None),
        (" 6ba7b810-9dad-11d1-80b4-00c04fd430c8", "é", None, None),
        (" 6ba7b810-9dad-11d1-80b4-00c04fd430c8", "Straße", None, None),
        (" 6ba7b810-9dad-11d1-80b4-00c04fd430c8", "日本語", None, None),
        (" 6ba7b810-9dad-11d1-80b4-00c04fd430c8", "x×1000", None, None),
        (" 6ba7b810-9dad-11d1-80b4-00c04fd430c8", "\n", None, None),
        (" 6ba7b810-9dad-11d1-80b4-00c04fd430c8", " ", None, None),
        (" 6ba7b810-9dad-11d1-80b4-00c04fd430c8", "a\0b", None, None),
        (" 6ba7b810-9dad-11d1-80b4-00c04fd430c8", "􏿿", None, None),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c8\n", "", None, None),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c8\n", "a", None, None),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c8\n", "www.example.com", None, None),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c8\n", "python.org", None, None),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c8\n", "😀", None, None),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c8\n", "é", None, None),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c8\n", "Straße", None, None),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c8\n", "日本語", None, None),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c8\n", "x×1000", None, None),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c8\n", "\n", None, None),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c8\n", " ", None, None),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c8\n", "a\0b", None, None),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c8\n", "􏿿", None, None),
        ("", "", None, None),
        ("", "a", None, None),
        ("", "www.example.com", None, None),
        ("", "python.org", None, None),
        ("", "😀", None, None),
        ("", "é", None, None),
        ("", "Straße", None, None),
        ("", "日本語", None, None),
        ("", "x×1000", None, None),
        ("", "\n", None, None),
        ("", " ", None, None),
        ("", "a\0b", None, None),
        ("", "􏿿", None, None),
        ("not a uuid", "", None, None),
        ("not a uuid", "a", None, None),
        ("not a uuid", "www.example.com", None, None),
        ("not a uuid", "python.org", None, None),
        ("not a uuid", "😀", None, None),
        ("not a uuid", "é", None, None),
        ("not a uuid", "Straße", None, None),
        ("not a uuid", "日本語", None, None),
        ("not a uuid", "x×1000", None, None),
        ("not a uuid", "\n", None, None),
        ("not a uuid", " ", None, None),
        ("not a uuid", "a\0b", None, None),
        ("not a uuid", "􏿿", None, None),
    ];

    /// `(text, validate(text), version(text))`, `None` where `version` throws `Invalid UUID`.
    const CHECKED: &[(&str, bool, Option<u8>)] = &[
        ("00000000-0000-0000-0000-000000000000", true, Some(0)),
        ("ffffffff-ffff-ffff-ffff-ffffffffffff", true, Some(15)),
        ("FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF", true, Some(15)),
        ("fFfFfFfF-ffff-FFFF-ffff-FFFFFFFFFFFF", true, Some(15)),
        ("00000000-0000-0000-0000-000000000001", false, None),
        ("6ba7b810-9dad-01d1-80b4-00c04fd430c8", false, None),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c8", true, Some(1)),
        ("6ba7b810-9dad-21d1-80b4-00c04fd430c8", true, Some(2)),
        ("6ba7b810-9dad-31d1-80b4-00c04fd430c8", true, Some(3)),
        ("6ba7b810-9dad-41d1-80b4-00c04fd430c8", true, Some(4)),
        ("6ba7b810-9dad-51d1-80b4-00c04fd430c8", true, Some(5)),
        ("6ba7b810-9dad-61d1-80b4-00c04fd430c8", true, Some(6)),
        ("6ba7b810-9dad-71d1-80b4-00c04fd430c8", true, Some(7)),
        ("6ba7b810-9dad-81d1-80b4-00c04fd430c8", true, Some(8)),
        ("6ba7b810-9dad-91d1-80b4-00c04fd430c8", false, None),
        ("6ba7b810-9dad-a1d1-80b4-00c04fd430c8", false, None),
        ("6ba7b810-9dad-b1d1-80b4-00c04fd430c8", false, None),
        ("6ba7b810-9dad-c1d1-80b4-00c04fd430c8", false, None),
        ("6ba7b810-9dad-d1d1-80b4-00c04fd430c8", false, None),
        ("6ba7b810-9dad-e1d1-80b4-00c04fd430c8", false, None),
        ("6ba7b810-9dad-f1d1-80b4-00c04fd430c8", false, None),
        ("6ba7b810-9dad-A1d1-80b4-00c04fd430c8", false, None),
        ("6ba7b810-9dad-B1d1-80b4-00c04fd430c8", false, None),
        ("6ba7b810-9dad-C1d1-80b4-00c04fd430c8", false, None),
        ("6ba7b810-9dad-D1d1-80b4-00c04fd430c8", false, None),
        ("6ba7b810-9dad-E1d1-80b4-00c04fd430c8", false, None),
        ("6ba7b810-9dad-F1d1-80b4-00c04fd430c8", false, None),
        ("6ba7b810-9dad-g1d1-80b4-00c04fd430c8", false, None),
        ("6ba7b810-9dad-11d1-00b4-00c04fd430c8", false, None),
        ("6ba7b810-9dad-11d1-10b4-00c04fd430c8", false, None),
        ("6ba7b810-9dad-11d1-20b4-00c04fd430c8", false, None),
        ("6ba7b810-9dad-11d1-30b4-00c04fd430c8", false, None),
        ("6ba7b810-9dad-11d1-40b4-00c04fd430c8", false, None),
        ("6ba7b810-9dad-11d1-50b4-00c04fd430c8", false, None),
        ("6ba7b810-9dad-11d1-60b4-00c04fd430c8", false, None),
        ("6ba7b810-9dad-11d1-70b4-00c04fd430c8", false, None),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c8", true, Some(1)),
        ("6ba7b810-9dad-11d1-90b4-00c04fd430c8", true, Some(1)),
        ("6ba7b810-9dad-11d1-a0b4-00c04fd430c8", true, Some(1)),
        ("6ba7b810-9dad-11d1-b0b4-00c04fd430c8", true, Some(1)),
        ("6ba7b810-9dad-11d1-c0b4-00c04fd430c8", false, None),
        ("6ba7b810-9dad-11d1-d0b4-00c04fd430c8", false, None),
        ("6ba7b810-9dad-11d1-e0b4-00c04fd430c8", false, None),
        ("6ba7b810-9dad-11d1-f0b4-00c04fd430c8", false, None),
        ("6ba7b810-9dad-11d1-A0b4-00c04fd430c8", true, Some(1)),
        ("6ba7b810-9dad-11d1-B0b4-00c04fd430c8", true, Some(1)),
        ("6ba7b810-9dad-11d1-C0b4-00c04fd430c8", false, None),
        ("6ba7b810-9dad-11d1-D0b4-00c04fd430c8", false, None),
        ("6ba7b810-9dad-11d1-E0b4-00c04fd430c8", false, None),
        ("6ba7b810-9dad-11d1-F0b4-00c04fd430c8", false, None),
        ("6ba7b810-9dad-11d1-g0b4-00c04fd430c8", false, None),
        ("6BA7B810-9DAD-11D1-80B4-00C04FD430C8", true, Some(1)),
        (" 6ba7b810-9dad-11d1-80b4-00c04fd430c8", false, None),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c8 ", false, None),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c8\n", false, None),
        ("\n6ba7b810-9dad-11d1-80b4-00c04fd430c8", false, None),
        ("6ba7b8109dad11d180b400c04fd430c8", false, None),
        ("{6ba7b810-9dad-11d1-80b4-00c04fd430c8}", false, None),
        ("urn:uuid:6ba7b810-9dad-11d1-80b4-00c04fd430c8", false, None),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c", false, None),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430c80", false, None),
        ("6ba7b810_9dad_11d1_80b4_00c04fd430c8", false, None),
        ("6ba7b810-9dad-11d1-80b4-00c04fd430٣٨", false, None),
        ("６ba7b810-9dad-11d1-80b4-00c04fd430c8", false, None),
        ("", false, None),
        ("nil", false, None),
        ("max", false, None),
        ("0190163d-8694-739b-aea5-966c26f8ad91", true, Some(7)),
        ("1ec9414c-232a-6b00-b3c8-9f6bdeced846", true, Some(6)),
        ("c232ab00-9414-11ec-b3c8-9f6bdeced846", true, Some(1)),
        ("00000000-0000-0000-0000-00000000000g", false, None),
        ("00000000-0000-0000-0000-000000000000\n", false, None),
    ];

    /// `(clock, random bytes, then the v1 state — msecs, nsecs, node, clockseq — and the v7 state —
    /// msecs, seq — after both updates, and the v1, v6 and v7 UUIDs made from them)`.
    const STEPS: &[(i64, &str, i64, i64, &str, u16, i64, i32, &str, &str, &str)] = &[
        (1767225600000, "28d84b8d867814eb01e1d8aa7d6bb802", 1767225600000, 0, "d9aa7d6bb802", 481, 1767225600000, 183173601, "d0c3c000-e6a4-11f0-81e1-d9aa7d6bb802", "1f0e6a4d-0c3c-6000-81e1-d8aa7d6bb802", "019b76da-a800-70ae-ac07-84aa7d6bb802"),
        (1767225600000, "96abd4202e1f5bee108bda2ac73cd350", 1767225600000, 1, "d9aa7d6bb802", 481, 1767225600000, 183173602, "d0c3c001-e6a4-11f0-81e1-d9aa7d6bb802", "1f0e6a4d-0c3c-6001-908b-da2ac73cd350", "019b76da-a800-70ae-ac07-8a2ac73cd350"),
        (1767225600000, "5cf3218d9e33c2bc362b08248f783b7a", 1767225600000, 2, "d9aa7d6bb802", 481, 1767225600000, 183173603, "d0c3c002-e6a4-11f0-81e1-d9aa7d6bb802", "1f0e6a4d-0c3c-6002-b62b-08248f783b7a", "019b76da-a800-70ae-ac07-8c248f783b7a"),
        (1767225600001, "68834e5b94280d3e38f4fc9c8e21c9c5", 1767225600001, 0, "d9aa7d6bb802", 481, 1767225600001, 113129716, "d0c3e710-e6a4-11f0-81e1-d9aa7d6bb802", "1f0e6a4d-0c3e-6710-b8f4-fc9c8e21c9c5", "019b76da-a801-706b-b8e3-d09c8e21c9c5"),
        (1767225599000, "052b00a6368b726f130e74e043cbe1bc", 1767225599000, 0, "75e043cbe1bc", 4878, 1767225600001, 113129717, "d02b2980-e6a4-11f0-930e-75e043cbe1bc", "1f0e6a4d-02b2-6980-930e-74e043cbe1bc", "019b76da-a801-706b-b8e3-d4e043cbe1bc"),
        (1767225599000, "8ba7998dc2f1d2c7a78780fc9a8ba9a3", 1767225599000, 1, "75e043cbe1bc", 4878, 1767225600001, 113129718, "d02b2981-e6a4-11f0-930e-75e043cbe1bc", "1f0e6a4d-02b2-6981-a787-80fc9a8ba9a3", "019b76da-a801-706b-b8e3-d8fc9a8ba9a3"),
        (1767225601000, "109365a341ece3b16a45b427a1e835e4", 1767225601000, 0, "75e043cbe1bc", 4878, 1767225601000, 1907452485, "d15c5680-e6a4-11f0-930e-75e043cbe1bc", "1f0e6a4d-15c5-6680-aa45-b427a1e835e4", "019b76da-abe8-771b-85a9-1427a1e835e4"),
        (1767225601000, "1459ca5d31f560f415f0563337cab582", 1767225601000, 1, "75e043cbe1bc", 4878, 1767225601000, 1907452486, "d15c5681-e6a4-11f0-930e-75e043cbe1bc", "1f0e6a4d-15c5-6681-95f0-563337cab582", "019b76da-abe8-771b-85a9-1a3337cab582"),
        (0, "371e79883d603f2b57e88dfebb6cab89", 0, 1, "8dfebb6cab89", 6120, 1767225601000, 1907452487, "13814001-1dd2-11b2-97e8-8dfebb6cab89", "1b21dd21-3814-6001-97e8-8dfebb6cab89", "019b76da-abe8-771b-85a9-1dfebb6cab89"),
        (-1, "e2b79fb0e74ad82d843497e2be4c177b", -1, 1, "97e2be4c177b", 1076, 1767225601000, 1907452488, "138118f1-1dd2-11b2-8434-97e2be4c177b", "1b21dd21-3811-68f1-8434-97e2be4c177b", "019b76da-abe8-771b-85a9-23e2be4c177b"),
        (-1, "00971398388a1d82436df025af15a7c1", -1, 2, "97e2be4c177b", 1076, 1767225601000, 1907452489, "138118f2-1dd2-11b2-8434-97e2be4c177b", "1b21dd21-3811-68f2-836d-f025af15a7c1", "019b76da-abe8-771b-85a9-2425af15a7c1"),
        (253402300799999, "a2be85a474a1c6d443b58b68929ae81e", 253402300799999, 0, "97e2be4c177b", 1076, 253402300799999, 1674855349, "1002d8f0-c652-14dc-8434-97e2be4c177b", "4dcc6521-002d-68f0-83b5-8b68929ae81e", "e677d21f-dbff-763d-910e-d768929ae81e"),
        (1767225602000, "bca9b350c7ab8159e4a2f919a8ba761b", 1767225602000, 0, "f919a8ba761b", 9378, 253402300799999, 1674855350, "d1f4ed00-e6a4-11f0-a4a2-f919a8ba761b", "1f0e6a4d-1f4e-6d00-a4a2-f919a8ba761b", "e677d21f-dbff-763d-910e-d919a8ba761b"),
        (1767225602000, "cc449496f64b2449ed31a3e0255a2b7a", 1767225602000, 1, "f919a8ba761b", 9378, 253402300799999, 1674855351, "d1f4ed01-e6a4-11f0-a4a2-f919a8ba761b", "1f0e6a4d-1f4e-6d01-ad31-a3e0255a2b7a", "e677d21f-dbff-763d-910e-dfe0255a2b7a"),
        (1767225602000, "8bd7896a0fa0da4b3ab3f112dc4e52a3", 1767225602000, 2, "f919a8ba761b", 9378, 253402300799999, 1674855352, "d1f4ed02-e6a4-11f0-a4a2-f919a8ba761b", "1f0e6a4d-1f4e-6d02-bab3-f112dc4e52a3", "e677d21f-dbff-763d-910e-e112dc4e52a3"),
        (1767225602001, "a2fb8e1e173157e66ac27f21f24dd219", 1767225602001, 0, "f919a8ba761b", 9378, 253402300799999, 1674855353, "d1f51410-e6a4-11f0-a4a2-f919a8ba761b", "1f0e6a4d-1f51-6410-aac2-7f21f24dd219", "e677d21f-dbff-763d-910e-e721f24dd219"),
    ];
}
