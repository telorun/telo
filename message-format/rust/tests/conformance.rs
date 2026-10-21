//! Runs the conformance vectors (`message-format/conformance/`) and every CLDR sample
//! (`message-format/cldr/plurals.json`) against this crate — the rows the Node core runs
//! in `message-format/nodejs/conformance/vector-runner.ts`, with the same counts pinned.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use telorun_message_format::*;

fn read(path: &str) -> JsonValue {
    let file = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join(path);
    let text = fs::read_to_string(&file).unwrap_or_else(|error| panic!("{}: {error}", file.display()));
    parse_json(&text).unwrap_or_else(|error| panic!("{}: {error}", file.display()))
}

fn s(text: &str) -> JsonValue {
    JsonValue::String(text.to_string())
}

fn object(entries: Vec<(&str, JsonValue)>) -> JsonValue {
    JsonValue::object(entries.into_iter().map(|(key, value)| (key.to_string(), value)).collect())
}

fn strings(items: &[String]) -> JsonValue {
    JsonValue::Array(items.iter().map(|item| s(item)).collect())
}

fn pattern_json(pattern: &[PatternPart]) -> JsonValue {
    JsonValue::Array(
        pattern
            .iter()
            .map(|part| match part {
                PatternPart::Text(text) => s(text),
                PatternPart::Placeholder(name) => object(vec![("placeholder", s(name))]),
            })
            .collect(),
    )
}

fn message_json(message: &Message) -> JsonValue {
    match message {
        Message::Pattern(pattern) => pattern_json(pattern),
        Message::Selection(selection) => object(vec![
            ("plural", s(&selection.plural)),
            (
                "cases",
                JsonValue::object(selection.cases.iter().map(|(key, case)| (key.clone(), message_json(case))).collect()),
            ),
        ]),
    }
}

fn problem_json(problem: &MessageProblem) -> JsonValue {
    object(vec![
        ("code", s(problem.code.as_str())),
        ("message", s(&problem.message)),
        ("path", strings(&problem.path)),
        (
            "range",
            match problem.range {
                None => JsonValue::Null,
                Some(range) => object(vec![
                    ("start", JsonValue::Number(range.start as f64)),
                    ("end", JsonValue::Number(range.end as f64)),
                ]),
            },
        ),
    ])
}

fn problems_json(problems: &[MessageProblem]) -> JsonValue {
    JsonValue::Array(problems.iter().map(problem_json).collect())
}

fn error_json(error: &MessageFormatError) -> JsonValue {
    object(vec![("code", s(error.code.as_str())), ("message", s(&error.message))])
}

fn categories_json(categories: &[PluralCategory]) -> JsonValue {
    JsonValue::Array(categories.iter().map(|category| s(category.as_str())).collect())
}

/// Structural equality, an object's keys in any order.
fn same(a: &JsonValue, b: &JsonValue) -> bool {
    match (a, b) {
        (JsonValue::Array(left), JsonValue::Array(right)) => {
            left.len() == right.len() && left.iter().zip(right).all(|(x, y)| same(x, y))
        }
        (JsonValue::Object(left), JsonValue::Object(right)) => {
            left.len() == right.len()
                && left.iter().all(|(key, value)| b.get(key).is_some_and(|other| same(value, other)))
        }
        _ => a == b,
    }
}

fn field<'a>(row: &'a JsonValue, key: &str) -> &'a JsonValue {
    row.get(key).unwrap_or_else(|| panic!("a row has no {key}"))
}

fn text<'a>(row: &'a JsonValue, key: &str) -> &'a str {
    field(row, key).as_str().unwrap_or_else(|| panic!("{key} is not a string"))
}

fn rows<'a>(file: &'a JsonValue, key: &str) -> &'a [JsonValue] {
    field(file, key).as_array().unwrap_or_else(|| panic!("{key} is not a list"))
}

fn message_value(typed: &JsonValue) -> MessageValue {
    let (kind, value) = &typed.as_object().expect("a typed value is an object")[0];
    let value = value.as_str().expect("a typed value holds text");
    match kind.as_str() {
        "string" => MessageValue::String(value.to_string()),
        "int" => MessageValue::Int(value.parse().expect("an int")),
        "uint" => MessageValue::Uint(value.parse().expect("a uint")),
        "double" => MessageValue::Double(value.parse().expect("a double")),
        other => panic!("{other} is no value type"),
    }
}

fn number_value(typed: &JsonValue) -> NumberValue {
    match message_value(typed) {
        MessageValue::Int(value) => NumberValue::Int(value),
        MessageValue::Uint(value) => NumberValue::Uint(value),
        MessageValue::Double(value) => NumberValue::Double(value),
        MessageValue::String(_) => panic!("a number row holds a string"),
    }
}

fn values(map: &JsonValue) -> HashMap<String, MessageValue> {
    map.as_object().expect("values are an object").iter().map(|(name, value)| (name.clone(), message_value(value))).collect()
}

fn read_ok(data: &JsonValue) -> Message {
    read_message(data).unwrap_or_else(|problems| panic!("a vector's message does not read: {problems:?}"))
}

fn outcome(result: Result<String, MessageFormatError>) -> JsonValue {
    match result {
        Ok(output) => object(vec![("value", s(&output))]),
        Err(error) => object(vec![("error", error_json(&error))]),
    }
}

fn expected_outcome(row: &JsonValue, output: &str) -> JsonValue {
    match row.get("error") {
        Some(error) => object(vec![("error", error.clone())]),
        None => object(vec![("value", field(row, output).clone())]),
    }
}

/// The samples a UTS #35 rule lists: `a~b` every value at `a`'s precision, `…` none.
fn expand_samples(rule: &str) -> Vec<String> {
    let mut samples = Vec::new();
    let Some(at) = rule.find('@') else { return samples };
    for list in rule[at..].split('@').skip(1) {
        let list = list.strip_prefix("integer").or_else(|| list.strip_prefix("decimal")).unwrap_or(list);
        for item in list.split(',') {
            let item = item.trim();
            if item.is_empty() || item == "…" || item == "..." {
                continue;
            }
            let Some((low, high)) = item.split_once('~') else {
                samples.push(item.to_string());
                continue;
            };
            let digits = low.split_once('.').map_or(0, |(_, fraction)| fraction.len());
            assert_eq!(high.split_once('.').map_or(0, |(_, fraction)| fraction.len()), digits, "{item} mixes precisions");
            let scaled = |text: &str| text.replace('.', "").parse::<u64>().expect("a sample bound");
            for value in scaled(low)..=scaled(high) {
                let text = format!("{value:0width$}", width = digits + 1);
                samples.push(if digits == 0 {
                    text
                } else {
                    format!("{}.{}", &text[..text.len() - digits], &text[text.len() - digits..])
                });
            }
        }
    }
    samples
}

#[test]
fn the_conformance_vectors_answer_as_recorded() {
    let mut failures: Vec<String> = Vec::new();
    let mut expect = |set: &'static str, id: &str, actual: JsonValue, expected: &JsonValue| {
        if !same(&actual, expected) {
            failures.push(format!("{set} {id}: answered {actual:?}, expected {expected:?}"));
        }
    };
    let mut tally: HashMap<&str, usize> = HashMap::new();

    let patterns = read("conformance/patterns.json");
    for row in rows(&patterns, "rows") {
        *tally.entry("patterns").or_default() += 1;
        let id = text(row, "id");
        match parse_pattern(text(row, "source")) {
            Ok(pattern) => {
                expect(
                    "patterns",
                    id,
                    object(vec![("pattern", pattern_json(&pattern)), ("canonical", s(&serialize_pattern(&pattern)))]),
                    &object(vec![("pattern", field(row, "pattern").clone()), ("canonical", field(row, "canonical").clone())]),
                );
                let again = parse_pattern(&serialize_pattern(&pattern)).map(|again| pattern_json(&again));
                expect("patterns", id, again.unwrap_or(JsonValue::Null), &pattern_json(&pattern));
            }
            Err(problem) => expect(
                "patterns",
                id,
                object(vec![("problem", problem_json(&problem))]),
                &object(vec![("problem", field(row, "problem").clone())]),
            ),
        }
    }

    let messages = read("conformance/messages.json");
    for row in rows(&messages, "rows") {
        *tally.entry("messages").or_default() += 1;
        let id = text(row, "id");
        let expected = match row.get("problems") {
            Some(problems) => object(vec![("problems", problems.clone())]),
            None if text(row, "read") == "message" => object(vec![
                ("message", field(row, "message").clone()),
                ("identity", field(row, "identity").clone()),
                ("variables", field(row, "variables").clone()),
            ]),
            None => object(vec![
                ("text", field(row, "text").clone()),
                ("identity", field(row, "identity").clone()),
                ("variables", field(row, "variables").clone()),
            ]),
        };
        let actual = if text(row, "read") == "message" {
            match read_message(field(row, "data")) {
                Ok(message) => object(vec![
                    ("message", message_json(&message)),
                    ("identity", s(&message_identity(&message))),
                    ("variables", strings(&message_variables(&message))),
                ]),
                Err(problems) => object(vec![("problems", problems_json(&problems))]),
            }
        } else {
            match read_text(field(row, "data")) {
                Ok(read) => {
                    let context = read.context.as_deref().map_or(JsonValue::Null, s);
                    let identity = text_identity(&read);
                    object(vec![
                        ("text", object(vec![("message", message_json(&read.message)), ("context", context)])),
                        (
                            "identity",
                            object(vec![
                                ("source", s(&identity.source)),
                                ("context", identity.context.as_deref().map_or(JsonValue::Null, s)),
                            ]),
                        ),
                        ("variables", strings(&message_variables(&read.message))),
                    ])
                }
                Err(problems) => object(vec![("problems", problems_json(&problems))]),
            }
        };
        expect("messages", id, actual, &expected);
    }

    let numbers = read("conformance/numbers.json");
    for row in rows(&numbers, "rows") {
        *tally.entry("numbers").or_default() += 1;
        let id = text(row, "id");
        let value = number_value(field(row, "value"));
        let lang = text(row, "lang");
        match (format_number(value, lang), row.get("refusal")) {
            (Err(error), Some(refusal)) => {
                expect("numbers", id, error_json(&error), refusal);
                let category = plural_category(value, lang).map(|c| s(c.as_str())).unwrap_or_else(|e| error_json(&e));
                expect("numbers", id, category, refusal);
            }
            (result, _) => {
                let actual = match result {
                    Ok(output) => object(vec![
                        ("text", s(&output)),
                        ("category", plural_category(value, lang).map(|c| s(c.as_str())).unwrap_or(JsonValue::Null)),
                    ]),
                    Err(error) => error_json(&error),
                };
                let expected = object(vec![
                    ("text", row.get("text").cloned().unwrap_or(JsonValue::Null)),
                    ("category", row.get("category").cloned().unwrap_or(JsonValue::Null)),
                ]);
                expect("numbers", id, actual, &expected);
            }
        }
    }

    let format = read("conformance/format.json");
    for row in rows(&format, "rows") {
        *tally.entry("format").or_default() += 1;
        let actual = outcome(format_message(&read_ok(field(row, "message")), text(row, "lang"), &values(field(row, "values"))));
        expect("format", text(row, "id"), actual, &expected_outcome(row, "output"));
    }

    let checks = read("conformance/checks.json");
    for row in rows(&checks, "categories") {
        *tally.entry("categories").or_default() += 1;
        expect("categories", text(row, "id"), categories_json(&plural_categories(text(row, "lang"))), field(row, "categories"));
    }
    for row in rows(&checks, "categoryProblems") {
        *tally.entry("categoryProblems").or_default() += 1;
        let problems = invalid_plural_categories(&read_ok(field(row, "message")), text(row, "lang"));
        expect("categoryProblems", text(row, "id"), problems_json(&problems), field(row, "problems"));
    }
    for row in rows(&checks, "unknownVariables") {
        *tally.entry("unknownVariables").or_default() += 1;
        let problems = unknown_variables(&read_ok(field(row, "translation")), &read_ok(field(row, "source")));
        expect("unknownVariables", text(row, "id"), problems_json(&problems), field(row, "problems"));
    }

    let lookup = read("conformance/lookup.json");
    for row in rows(&lookup, "chains") {
        *tally.entry("chains").or_default() += 1;
        expect("chains", text(row, "id"), strings(&truncation_chain(text(row, "tag"))), field(row, "chain"));
    }
    for row in rows(&lookup, "lookups") {
        *tally.entry("lookups").or_default() += 1;
        let available: Vec<String> =
            field(row, "available").as_array().unwrap().iter().map(|tag| tag.as_str().unwrap().to_string()).collect();
        let result = lookup_language(text(row, "requested"), &available).map_or(JsonValue::Null, s);
        expect("lookups", text(row, "id"), result, field(row, "result"));
    }

    let working_group = read("conformance/mf2-working-group/cases.json");
    for row in rows(&working_group, "rows") {
        *tally.entry("workingGroup").or_default() += 1;
        let id = text(row, "id");
        match read_message(field(row, "src")) {
            Err(problems) => expect(
                "workingGroup",
                id,
                object(vec![("problem", problem_json(&problems[0]))]),
                &object(vec![("problem", field(row, "problem").clone())]),
            ),
            Ok(message) => {
                let actual = outcome(format_message(&message, text(row, "locale"), &values(field(row, "params"))));
                expect("workingGroup", id, actual, &expected_outcome(row, "output"));
            }
        }
    }

    let plurals = read("cldr/plurals.json");
    for (locale, rules) in field(&plurals, "rules").as_object().unwrap() {
        for (category, rule) in rules.as_object().unwrap() {
            for sample in expand_samples(rule.as_str().unwrap()) {
                *tally.entry("cldrSamples").or_default() += 1;
                let answer = plural_category_of_decimal(&sample, locale).map_or(JsonValue::Null, |c| s(c.as_str()));
                expect("cldrSamples", &format!("{locale} {sample}"), answer, &s(category));
            }
        }
    }

    assert!(failures.is_empty(), "{} vectors disagree:\n{}", failures.len(), failures.join("\n"));
    let pinned: HashMap<&str, usize> = HashMap::from([
        ("patterns", 46),
        ("messages", 38),
        ("numbers", 81),
        ("format", 44),
        ("categories", 15),
        ("categoryProblems", 8),
        ("unknownVariables", 9),
        ("chains", 7),
        ("lookups", 12),
        ("workingGroup", 247),
        ("cldrSamples", 12396),
    ]);
    assert_eq!(tally, pinned);
}
