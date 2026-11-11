//! The macOS WebKit data store identifier: a UUIDv5 of the application's
//! `identifier` under a fixed namespace, so every Telo app has a store of its own
//! and none uses the shared default (WebKit 14+).
//!
//! No Node twin: this crate has none (see `lib.rs`).

use sha1::{Digest, Sha1};

/// The namespace the store identifiers are derived under. Fixed forever: changing it
/// moves every desktop app to an empty webview store.
pub const STORE_NAMESPACE: [u8; 16] = [
    0x5f, 0x3c, 0x1d, 0x9a, 0x7b, 0x24, 0x4e, 0x68, 0xa1, 0xc5, 0x3d, 0x8e, 0x9f, 0x0b, 0x2c, 0x47,
];

/// RFC 4122 §4.3 name-based UUID, version 5.
pub fn data_store_identifier(identifier: &str) -> [u8; 16] {
    let mut hasher = Sha1::new();
    hasher.update(STORE_NAMESPACE);
    hasher.update(identifier.as_bytes());
    let digest = hasher.finalize();
    let mut uuid = [0u8; 16];
    uuid.copy_from_slice(&digest[..16]);
    uuid[6] = (uuid[6] & 0x0f) | 0x50;
    uuid[8] = (uuid[8] & 0x3f) | 0x80;
    uuid
}

/// The canonical `8-4-4-4-12` text of a UUID.
pub fn uuid_text(uuid: &[u8; 16]) -> String {
    let hex: String = uuid.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_reference_uuid_v5() {
        // uuid.uuid5(UUID('5f3c1d9a-7b24-4e68-a1c5-3d8e9f0b2c47'), name) in Python.
        assert_eq!(uuid_text(&data_store_identifier("run.telo.examples.hello")), "667803e2-a901-5181-80c5-87bb14bd5e78");
        assert_eq!(uuid_text(&data_store_identifier("com.example.App")), "1edec379-c49a-57c7-8eb4-36d57ddd08d4");
    }

    #[test]
    fn the_namespace_is_the_documented_uuid() {
        assert_eq!(uuid_text(&STORE_NAMESPACE), "5f3c1d9a-7b24-4e68-a1c5-3d8e9f0b2c47");
    }

    #[test]
    fn distinct_identifiers_get_distinct_stores() {
        assert_ne!(data_store_identifier("a.b"), data_store_identifier("a.c"));
    }
}
