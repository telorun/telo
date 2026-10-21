//! The three tracked CLDR files read into the tables lookups use: every locale key
//! ASCII-lowercased, each number entry's decimal pattern parsed, each plural rule read.
//! A file this crate cannot read is a defect of the build and panics naming it.

use std::collections::HashMap;

use crate::cldr_data::{NUMBERS_JSON, PARENT_LOCALES_JSON, PLURALS_JSON};
use crate::cldr_locale::CLDR_VERSION;
use crate::decimal_pattern::{parse_decimal_pattern, DecimalPattern};
use crate::json_value::{parse_json, JsonValue};
use crate::message_model::{PluralCategory, PLURAL_CATEGORIES};
use crate::plural_rule::{parse_plural_rule, PluralRule};

#[derive(Clone, Debug)]
pub(crate) struct CldrNumberEntry {
    pub digits: [char; 10],
    pub decimal: String,
    pub group: String,
    pub minus_sign: String,
    pub pattern: DecimalPattern,
    pub minimum_grouping_digits: usize,
}

#[derive(Clone, Debug)]
pub(crate) struct PluralRuleSet {
    pub categories: Vec<PluralCategory>,
    /// The rule of each category but `other`, in category order.
    pub rules: Vec<(PluralCategory, PluralRule)>,
}

pub(crate) struct CldrTables {
    pub numbers: HashMap<String, CldrNumberEntry>,
    pub plurals: HashMap<String, PluralRuleSet>,
    pub main_parents: HashMap<String, String>,
    pub plural_parents: HashMap<String, String>,
    pub likely_scripts: HashMap<String, String>,
}

fn file(name: &str, text: &str) -> JsonValue {
    parse_json(text).unwrap_or_else(|error| panic!("message-format/cldr/{name} does not read: {error}"))
}

fn string<'a>(value: &'a JsonValue, key: &str, at: &str) -> &'a str {
    value.get(key).and_then(JsonValue::as_str).unwrap_or_else(|| panic!("{at} holds no string {key}"))
}

fn entries<'a>(value: &'a JsonValue, key: &str, at: &str) -> &'a [(String, JsonValue)] {
    value.get(key).and_then(JsonValue::as_object).unwrap_or_else(|| panic!("{at} holds no object {key}"))
}

fn lowercase_map(value: &JsonValue, key: &str, at: &str) -> HashMap<String, String> {
    entries(value, key, at)
        .iter()
        .map(|(name, target)| {
            let target = target.as_str().unwrap_or_else(|| panic!("{at} {key}.{name} is not a string"));
            (name.to_ascii_lowercase(), target.to_ascii_lowercase())
        })
        .collect()
}

pub(crate) fn read_tables() -> CldrTables {
    let plurals_file = file("plurals.json", PLURALS_JSON);
    let numbers_file = file("numbers.json", NUMBERS_JSON);
    let parents_file = file("parent-locales.json", PARENT_LOCALES_JSON);

    let mut numbers = HashMap::new();
    for (locale, entry) in entries(&numbers_file, "locales", "numbers.json") {
        let at = format!("numbers.json {locale}");
        let digits: Vec<char> = string(entry, "digits", &at).chars().collect();
        let digits: [char; 10] = digits.try_into().unwrap_or_else(|_| panic!("{at} has no ten digits"));
        let minimum_grouping_digits = string(entry, "minimumGroupingDigits", &at)
            .parse()
            .unwrap_or_else(|_| panic!("{at} minimumGroupingDigits is not a number"));
        numbers.insert(
            locale.to_ascii_lowercase(),
            CldrNumberEntry {
                digits,
                decimal: string(entry, "decimal", &at).to_string(),
                group: string(entry, "group", &at).to_string(),
                minus_sign: string(entry, "minusSign", &at).to_string(),
                pattern: parse_decimal_pattern(string(entry, "pattern", &at))
                    .unwrap_or_else(|| panic!("{at} has a pattern outside the subset")),
                minimum_grouping_digits,
            },
        );
    }

    let mut plurals = HashMap::new();
    for (locale, written) in entries(&plurals_file, "rules", "plurals.json") {
        let at = format!("plurals.json {locale}");
        let categories: Vec<PluralCategory> =
            PLURAL_CATEGORIES.into_iter().filter(|category| written.get(category.as_str()).is_some()).collect();
        let rules = categories
            .iter()
            .filter(|category| **category != PluralCategory::Other)
            .map(|category| {
                let rule = string(written, category.as_str(), &at);
                (*category, parse_plural_rule(rule).unwrap_or_else(|| panic!("{at} {} does not read", category.as_str())))
            })
            .collect();
        plurals.insert(locale.to_ascii_lowercase(), PluralRuleSet { categories, rules });
    }

    for (name, value) in [("plurals.json", &plurals_file), ("numbers.json", &numbers_file), ("parent-locales.json", &parents_file)] {
        let version = string(value, "cldrVersion", name);
        assert!(version == CLDR_VERSION, "message-format/cldr/{name} is CLDR {version}, and the crate declares {CLDR_VERSION}");
    }

    CldrTables {
        numbers,
        plurals,
        main_parents: lowercase_map(&parents_file, "main", "parent-locales.json"),
        plural_parents: lowercase_map(&parents_file, "plurals", "parent-locales.json"),
        likely_scripts: lowercase_map(&parents_file, "likelyScripts", "parent-locales.json"),
    }
}
