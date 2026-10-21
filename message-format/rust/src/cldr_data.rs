//! The tracked CLDR data under `message-format/cldr/`, taken in at build time — the
//! files the Node core's generated `cldr-data.ts` is written from — with the Unicode
//! License V3 its copies must carry.

pub(crate) const PLURALS_JSON: &str = include_str!("../../cldr/plurals.json");
pub(crate) const NUMBERS_JSON: &str = include_str!("../../cldr/numbers.json");
pub(crate) const PARENT_LOCALES_JSON: &str = include_str!("../../cldr/parent-locales.json");

/// The licence of the CLDR data this crate embeds; a program shipping the crate ships it.
pub const CLDR_LICENSE: &str = include_str!("../../cldr/LICENSE");
