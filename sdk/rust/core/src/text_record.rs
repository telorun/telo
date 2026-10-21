//! The `Text` record: what a controller receives wherever a field or a callable
//! parameter is typed by the built-in `Text` fragment. Twin of
//! `sdk/nodejs/src/text-record.ts`.
//!
//! The kernel builds it from the text as written and the module that wrote it:
//! `text` is the Message in its fragment spelling, `context` tells the same words
//! used elsewhere apart, `lang` is the writing module's `lang:` (`und` when it
//! declares none), and `computed` is true when an expression produced the text,
//! which is then never looked up in a catalog. Plain JSON, so a record crosses any
//! wire unchanged.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// A Message in its fragment spelling: a pattern, or a plural selection whose
/// cases are Messages.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MessageSource {
    Pattern(String),
    Selection {
        plural: String,
        cases: BTreeMap<String, MessageSource>,
    },
}

/// A text shown to a person, as its controller receives it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TextRecord {
    pub text: MessageSource,
    pub context: Option<String>,
    pub lang: String,
    pub computed: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_both_message_spellings_and_writes_them_back() {
        let json = serde_json::json!({
            "text": { "plural": "n", "cases": { "one": "{$n} file", "other": "{$n} files" } },
            "context": null,
            "lang": "en",
            "computed": false,
        });
        let record: TextRecord = serde_json::from_value(json.clone()).expect("a record reads");
        assert_eq!(
            record.text,
            MessageSource::Selection {
                plural: "n".into(),
                cases: BTreeMap::from([
                    ("one".into(), MessageSource::Pattern("{$n} file".into())),
                    ("other".into(), MessageSource::Pattern("{$n} files".into())),
                ]),
            }
        );
        assert_eq!(serde_json::to_value(&record).expect("a record writes"), json);
        let plain: TextRecord = serde_json::from_value(serde_json::json!({
            "text": "Open", "context": "verb", "lang": "und", "computed": true,
        }))
        .expect("a pattern record reads");
        assert_eq!(plain.text, MessageSource::Pattern("Open".into()));
        assert_eq!(plain.context.as_deref(), Some("verb"));
    }

    #[test]
    fn refuses_a_record_with_a_key_it_does_not_hold() {
        let refused = serde_json::from_value::<TextRecord>(serde_json::json!({
            "text": "Open", "context": null, "lang": "en", "computed": false, "extra": 1,
        }));
        assert!(refused.is_err());
    }
}
