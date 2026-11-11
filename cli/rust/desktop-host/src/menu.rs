//! The tray menu model: `desktop-host.md` §3's `menu` — a list of
//! `{ type: "item", item, label, enabled }` and `{ type: "separator" }`, `item`
//! being the entry's index in the whole list, separators counted.
//!
//! No Node twin: this crate has none (see `lib.rs`).

use crate::envelope::{violation, ProtocolError};
use crate::payload::Fields;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MenuEntry {
    Item { item: u32, label: String, enabled: bool },
    Separator,
}

pub fn read_menu(fields: &mut Fields<'_>) -> Result<Vec<MenuEntry>, ProtocolError> {
    let (entries, path) = fields.array("menu")?;
    let mut menu = Vec::with_capacity(entries.len());
    for (index, entry) in entries.iter().enumerate() {
        let at = format!("{path}[{index}]");
        let mut member = Fields::new(entry, &at)?;
        let kind = member.string("type")?;
        let read = match kind.as_str() {
            "separator" => MenuEntry::Separator,
            "item" => {
                let item = member.index("item")?;
                if item as usize != index {
                    return Err(violation(format!("'{at}.item' is {item} but the entry's index is {index}")));
                }
                MenuEntry::Item { item, label: member.string("label")?, enabled: member.boolean("enabled")? }
            }
            other => return Err(violation(format!("'{at}.type' is '{other}', not 'item' or 'separator'"))),
        };
        member.finish()?;
        menu.push(read);
    }
    Ok(menu)
}

/// A menu item's identity in the toolkit, whose ids are global to the process: the tray's
/// name, a unit separator and the item index (parsed from the last separator on).
pub fn item_id(tray: &str, item: u32) -> String {
    format!("{tray}\u{1f}{item}")
}

pub fn parse_item_id(id: &str) -> Option<(&str, u32)> {
    let (tray, item) = id.rsplit_once('\u{1f}')?;
    Some((tray, item.parse().ok()?))
}

/// What `Value` the module end would send for a menu; used by tests of the readers.
pub fn describe(entries: &[MenuEntry]) -> Value {
    Value::Array(
        entries
            .iter()
            .map(|entry| match entry {
                MenuEntry::Separator => serde_json::json!({ "type": "separator" }),
                MenuEntry::Item { item, label, enabled } => serde_json::json!({ "type": "item", "item": item, "label": label, "enabled": enabled }),
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn read(menu: Value) -> Result<Vec<MenuEntry>, ProtocolError> {
        let payload = json!({ "menu": menu });
        let mut fields = Fields::new(&payload, "").unwrap();
        read_menu(&mut fields)
    }

    #[test]
    fn reads_items_and_separators_with_their_index_in_the_whole_list() {
        let menu = json!([
            { "type": "item", "item": 0, "label": "Open", "enabled": true },
            { "type": "separator" },
            { "type": "item", "item": 2, "label": "Quit", "enabled": false },
        ]);
        let entries = read(menu.clone()).unwrap();
        assert_eq!(entries[1], MenuEntry::Separator);
        assert_eq!(entries[2], MenuEntry::Item { item: 2, label: "Quit".into(), enabled: false });
        assert_eq!(describe(&entries), menu);
    }

    #[test]
    fn an_item_index_that_skips_the_separators_is_refused() {
        assert!(read(json!([{ "type": "separator" }, { "type": "item", "item": 0, "label": "A", "enabled": true }])).is_err());
    }

    #[test]
    fn refuses_an_unknown_type_a_missing_member_and_an_unlisted_one() {
        assert!(read(json!([{ "type": "submenu" }])).is_err());
        assert!(read(json!([{ "type": "item", "item": 0, "label": "A" }])).is_err());
        assert!(read(json!([{ "type": "separator", "label": "x" }])).is_err());
        assert!(read(json!("nope")).is_err());
    }

    #[test]
    fn item_ids_round_trip_through_a_tray_name_holding_the_separator() {
        assert_eq!(parse_item_id(&item_id("tray", 3)), Some(("tray", 3)));
        assert_eq!(parse_item_id(&item_id("a\u{1f}b", 12)), Some(("a\u{1f}b", 12)));
        assert_eq!(parse_item_id("no-separator"), None);
    }
}
