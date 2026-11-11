//! Replaying the CEL conformance vectors' language rows, whole — the twin of
//! `cel/nodejs/conformance/language-replay.ts`.
//!
//! A row's `expect` is the Node engine's whole answer, so the driver computes this
//! engine's answer ([`language_answer`]) and deep-compares it with the row — there is no
//! list of rows answered otherwise. Beside the answer it holds every row to the format: the
//! keys a row may carry, the two classes of row (cel-spec's import, then the authored
//! `telo/` rows), the rules of `deviation`, the `celCode` vocabulary, and the round trip of
//! every source that reads.
//!
//! The driver takes the rows as a parameter and names no path: the runner
//! (`tests/language_replay.rs`) knows where the vectors live.
//!
//! Its blind spot: deep equality pins whatever the Node engine answered. `deviation.celSpec`
//! is the only check against cel-spec, and only on the rows that carry one.

#![allow(dead_code)]

use serde_json::{Map, Value};
use telorun_cel::{
    has_unparsed, serialize_tree, trees_equal, CelEnvironment, CelEnvironmentOptions, CelEvaluateError, CelValue,
    EvaluateOptions, FieldDeclaration, FunctionMetadata, PropertyMap, ResolvedCall, TypeDeclaration,
};

use super::conformance_error::{check_refusal, language_cel_codes, recorded_error, recorded_range};
use super::conformance_value::{encode_conformance_value, json_deep_equal, json_text, read_canonical_conformance_value};

/// The one file of the vectors this driver answers for.
pub const DRIVEN_FILE: &str = "language.json";

/// How many rows the file holds. A row deleted leaves every other count true, so it is pinned.
pub const LANGUAGE_ROWS: usize = 1816;

/// The prefix of an authored row's id: a row cel-spec's import did not produce.
pub const AUTHORED_ROW_PREFIX: &str = "telo/";

/// The closed set of reasons a row's answer may differ from cel-spec's.
pub const DEVIATION_REASONS: [&str; 4] = [
    // The row calls into a cel-go extension library Telo does not ship.
    "extension-library",
    // The answer needs a cel-spec typing feature the engine does not carry.
    "feature-not-carried",
    // The answer is a name resolved through a container, and Telo declares none.
    "container-not-declared",
    // An input of the cel-spec test the row could not carry.
    "uncarried-input",
];

/// The parts of cel-spec's outcome a `deviation.celSpec` may state.
pub const CEL_SPEC_PARTS: [&str; 4] = ["value", "error", "type", "unknown"];

const ROW_KEYS: [&str; 8] = ["id", "source", "provenance", "declarations", "functions", "bindings", "expect", "deviation"];
const EXPECT_KEYS: [&str; 3] = ["check", "value", "error"];
const ERROR_KEYS: [&str; 4] = ["code", "celCode", "message", "range"];
const DEVIATION_KEYS: [&str; 3] = ["celSpec", "reason", "uncarried"];
const PROVENANCE_KEYS: [&str; 3] = ["file", "section", "test"];

/// The language environment: CEL's own library, with unlisted names reading as `dyn`,
/// optional types on and heterogeneous aggregates allowed. Nothing else — no host
/// catalog, no host type.
pub fn language_environment() -> CelEnvironment {
    CelEnvironment::new(CelEnvironmentOptions {
        unlisted_variables_are_dyn: true,
        enable_optional_types: true,
        homogeneous_aggregate_literals: false,
        ..CelEnvironmentOptions::default()
    })
}

fn text_of<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

/// A row's `declarations` entry as the engine's declaration: a type string, or a record
/// `{ "fields": { … } }` whose fields are in turn type strings or records.
pub fn type_declaration(node: &Value) -> Result<TypeDeclaration, String> {
    match node {
        Value::String(text) => Ok(TypeDeclaration::Text(text.clone())),
        _ => Ok(TypeDeclaration::Fields(field_map(node)?)),
    }
}

fn field_map(node: &Value) -> Result<PropertyMap<FieldDeclaration>, String> {
    let fields = match node {
        Value::Object(record) if record.len() == 1 => record.get("fields").and_then(Value::as_object),
        _ => None,
    };
    let Some(fields) = fields else {
        return Err(format!("declares {}, which is neither a type nor `{{ fields }}`", json_text(node)));
    };
    let mut out = PropertyMap::new();
    for (name, field) in fields {
        let declared = match field {
            Value::String(text) => FieldDeclaration::Type(text.clone()),
            _ => FieldDeclaration::Fields(field_map(field)?),
        };
        out.insert(name.clone(), declared);
    }
    Ok(out)
}

fn signatures(row: &Value) -> Vec<&str> {
    row.get("functions")
        .and_then(Value::as_array)
        .map(|declared| declared.iter().filter_map(|entry| text_of(entry, "signature")).collect())
        .unwrap_or_default()
}

fn register_functions(environment: &mut CelEnvironment, row: &Value) -> Result<(), String> {
    for signature in signatures(row) {
        environment
            .register_function(signature, FunctionMetadata::default())
            .map_err(|refusal| format!("the function {signature:?} cannot be registered: {refusal}"))?;
    }
    Ok(())
}

/// The environment a row is CHECKED in: its declarations and its functions.
pub fn check_environment(base: &CelEnvironment, row: &Value) -> Result<CelEnvironment, String> {
    let mut environment = base.clone();
    if let Some(declarations) = row.get("declarations").and_then(Value::as_object) {
        for (name, declaration) in declarations {
            environment
                .register_variable(name, type_declaration(declaration)?, None)
                .map_err(|refusal| format!("the variable {name:?} cannot be declared: {refusal}"))?;
        }
    }
    register_functions(&mut environment, row)?;
    Ok(environment)
}

/// The environment a row is EVALUATED in: its functions, and none of its declarations. A
/// declared function is a signature with no implementation, so a call that resolves to it
/// answers `unbound_function`, naming the function and the signature it resolved to.
pub fn evaluation_environment(base: &CelEnvironment, row: &Value) -> Result<CelEnvironment, String> {
    let mut environment = base.clone();
    register_functions(&mut environment, row)?;
    Ok(environment)
}

/// The row's bindings as an activation. Refuses a binding not in its canonical writing.
pub fn activation_of(row: &Value) -> Result<PropertyMap<CelValue>, String> {
    let mut activation = PropertyMap::new();
    if let Some(bindings) = row.get("bindings").and_then(Value::as_object) {
        for (name, node) in bindings {
            let value = read_canonical_conformance_value(node).map_err(|refusal| format!("the binding {name:?}: {refusal}"))?;
            activation.insert(name.clone(), value);
        }
    }
    Ok(activation)
}

/// A call the checker resolved: every field it reports, its range as `{ start, end }`.
fn recorded_call(call: &ResolvedCall) -> Value {
    let strings = |held: &Vec<String>| Value::Array(held.iter().cloned().map(Value::String).collect());
    let mut out = Map::new();
    out.insert("name".into(), Value::String(call.name.clone()));
    out.insert("form".into(), Value::String(call.form.as_str().into()));
    if let Some(namespace) = &call.namespace {
        out.insert("namespace".into(), Value::String(namespace.clone()));
    }
    out.insert("arity".into(), Value::from(call.arity));
    out.insert("range".into(), recorded_range(call.range));
    if let Some(signature) = &call.signature {
        out.insert("signature".into(), Value::String(signature.clone()));
    }
    if let Some(returns) = &call.returns {
        out.insert("returns".into(), Value::String(returns.clone()));
    }
    if let Some(deterministic) = call.deterministic {
        out.insert("deterministic".into(), Value::Bool(deterministic));
    }
    if let Some(host_backed) = call.host_backed {
        out.insert("hostBacked".into(), Value::Bool(host_backed));
    }
    if let Some(throws) = &call.throws {
        out.insert("throws".into(), strings(throws));
    }
    if let Some(argument_types) = &call.argument_types {
        out.insert("argumentTypes".into(), strings(argument_types));
    }
    Value::Object(out)
}

/// The engine's whole answer for a row, as the row writes `expect`. The check half runs in
/// the check environment; the evaluation half checks first in the evaluation environment,
/// recording a refusal as the first diagnostic, and otherwise evaluates with the row's
/// bindings.
pub fn language_answer(base: &CelEnvironment, row: &Value) -> Result<Value, String> {
    let source = text_of(row, "source").ok_or("has no string `source`")?;
    let activation = activation_of(row)?;
    let checked = check_environment(base, row)?.check(source);
    let mut check = Map::new();
    let diagnostics = checked
        .diagnostics
        .iter()
        .map(|diagnostic| {
            let mut out = Map::new();
            out.insert("code".into(), Value::String(diagnostic.code.as_str().into()));
            out.insert("message".into(), Value::String(diagnostic.message.clone()));
            out.insert("range".into(), recorded_range(diagnostic.range));
            if let Some(fix) = &diagnostic.fix {
                let mut replacement = Map::new();
                replacement.insert("replacement".into(), Value::String(fix.replacement.clone()));
                out.insert("fix".into(), Value::Object(replacement));
            }
            Value::Object(out)
        })
        .collect();
    check.insert("diagnostics".into(), Value::Array(diagnostics));
    if checked.diagnostics.is_empty() {
        check.insert("type".into(), Value::String(checked.type_name.clone()));
    }
    check.insert("calls".into(), Value::Array(checked.calls.iter().map(recorded_call).collect()));

    let mut answer = Map::new();
    answer.insert("check".into(), Value::Object(check));
    let environment = evaluation_environment(base, row)?;
    let expression = environment.parse(source);
    let refusal = environment.check_parsed(&expression).map_err(|refusal| refusal.message)?;
    if let Some(first) = refusal.diagnostics.first() {
        answer.insert("error".into(), check_refusal(first).to_json());
        return Ok(Value::Object(answer));
    }
    let evaluated = environment
        .compile_parsed(&expression)
        .map_err(CelEvaluateError::from)
        .and_then(|program| program.evaluate(&activation, &EvaluateOptions::default()).map_err(CelEvaluateError::from));
    match evaluated {
        Ok(value) => {
            let encoded = encode_conformance_value(&value).map_err(|refusal| format!("its value cannot be written: {refusal}"))?;
            answer.insert("value".into(), encoded);
        }
        Err(cause) => {
            let recorded = recorded_error(&cause).map_err(|refusal| refusal.0)?;
            answer.insert("error".into(), recorded.to_json());
        }
    }
    Ok(Value::Object(answer))
}

/// A conformance value as cel-spec's equality sees it: `-0` is `0`.
fn cel_spec_text(node: &Value) -> Result<String, String> {
    fn zeroed(held: Value) -> Value {
        match held {
            Value::Array(items) => Value::Array(items.into_iter().map(zeroed).collect()),
            Value::Object(fields) => {
                let negative_zero = fields.get("$telo").and_then(Value::as_str) == Some("double")
                    && fields.get("value").and_then(Value::as_str) == Some("-0");
                if negative_zero {
                    return Value::from(0);
                }
                Value::Object(fields.into_iter().map(|(key, inner)| (key, zeroed(inner))).collect())
            }
            other => other,
        }
    }
    let value = read_canonical_conformance_value(node).map_err(|refusal| refusal.0)?;
    let encoded = encode_conformance_value(&value).map_err(|refusal| refusal.0)?;
    Ok(json_text(&zeroed(encoded)))
}

/// Whether the answer agrees with one part of cel-spec's outcome, by the vectors' cel-spec
/// rule: values by CEL equality including the type (NaN equals NaN, `-0` equals `0`, maps
/// regardless of order), any error agreeing with an error, a type against `check.type`.
/// No answer of this engine is an unknown set.
pub fn cel_spec_part_agrees(part: &str, stated: &Value, answer: &Value) -> Result<bool, String> {
    match part {
        "value" => match answer.get("value") {
            Some(value) => Ok(cel_spec_text(stated)? == cel_spec_text(value)?),
            None => Ok(false),
        },
        "error" => Ok(answer.get("error").is_some()),
        "type" => Ok(answer.get("check").and_then(|check| check.get("type")) == Some(stated)),
        "unknown" => Ok(false),
        other => Err(format!("{} is not a part of cel-spec's outcome", json_text(&Value::String(other.into())))),
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ReplayFailure {
    pub id: String,
    pub reason: String,
}

#[derive(Clone, Debug, Default)]
pub struct LanguageReplayReport {
    pub rows: usize,
    /// Rows whose answer was computed and compared.
    pub driven: usize,
    pub round_tripped: usize,
    pub unreadable: usize,
    /// A row breaking the format: its keys, its class, an input that cannot be built.
    pub malformed: Vec<ReplayFailure>,
    /// A row whose `expect` is not the engine's answer.
    pub answers: Vec<ReplayFailure>,
    pub deviations: Vec<ReplayFailure>,
    pub cel_codes: Vec<ReplayFailure>,
    pub round_trip: Vec<ReplayFailure>,
}

fn unknown_keys(value: &Map<String, Value>, allowed: &[&str]) -> Vec<String> {
    value.keys().filter(|key| !allowed.contains(&key.as_str())).cloned().collect()
}

fn is_string_list(node: &Value) -> bool {
    node.as_array().is_some_and(|items| !items.is_empty() && items.iter().all(Value::is_string))
}

/// Why a row breaks the format, before its answer is computed; nothing when it does not.
pub fn row_shape_problems(row: &Value, after_authored: bool) -> Vec<String> {
    let mut problems = Vec::new();
    let Some(raw) = row.as_object() else { return vec!["is not an object".into()] };
    if raw.contains_key("divergence") {
        problems.push("carries `divergence`, which the format no longer has".into());
    }
    let extra: Vec<String> = unknown_keys(raw, &ROW_KEYS).into_iter().filter(|key| key != "divergence").collect();
    if !extra.is_empty() {
        problems.push(format!("carries keys the format does not define: {}", extra.join(", ")));
    }
    let id = text_of(row, "id");
    if id.is_none() {
        problems.push("has no string `id`".into());
    }
    if text_of(row, "source").is_none() {
        problems.push("has no string `source`".into());
    }
    if id.is_some_and(|id| id.starts_with(AUTHORED_ROW_PREFIX)) {
        if raw.contains_key("provenance") {
            problems.push("is authored and carries `provenance`".into());
        }
        if raw.contains_key("deviation") {
            problems.push("is authored and carries `deviation`".into());
        }
    } else {
        if after_authored {
            problems.push("is a cel-spec row after an authored row; authored rows follow the import".into());
        }
        let well_formed = raw.get("provenance").and_then(Value::as_object).is_some_and(|provenance| {
            unknown_keys(provenance, &PROVENANCE_KEYS).is_empty()
                && PROVENANCE_KEYS.iter().all(|key| provenance.get(*key).is_some_and(Value::is_string))
        });
        if !well_formed {
            problems.push("is a cel-spec row without a `provenance` of `file`, `section` and `test`".into());
        }
    }
    if let Some(functions) = raw.get("functions") {
        match functions.as_array() {
            Some(declared) => {
                for entry in declared {
                    let alone = entry.as_object().is_some_and(|fields| {
                        unknown_keys(fields, &["signature"]).is_empty() && fields.get("signature").is_some_and(Value::is_string)
                    });
                    if !alone {
                        problems.push(format!("declares a function that is not `{{ signature }}` alone: {}", json_text(entry)));
                    }
                }
            }
            None => problems.push("carries `functions` that is not a list".into()),
        }
    }
    let Some(expect) = raw.get("expect").and_then(Value::as_object) else {
        problems.push("has no `expect`".into());
        return problems;
    };
    let expect_extra = unknown_keys(expect, &EXPECT_KEYS);
    if !expect_extra.is_empty() {
        problems.push(format!("`expect` carries {}", expect_extra.join(", ")));
    }
    if !expect.get("check").is_some_and(Value::is_object) {
        problems.push("`expect` has no `check`".into());
    }
    if expect.contains_key("value") == expect.contains_key("error") {
        problems.push("`expect` carries neither or both of `value` and `error`".into());
    }
    if let Some(error) = expect.get("error") {
        let well_formed = error.as_object().is_some_and(|fields| {
            unknown_keys(fields, &ERROR_KEYS).is_empty()
                && fields.contains_key("code")
                && fields.contains_key("celCode")
                && fields.get("message").is_some_and(Value::is_string)
        });
        if !well_formed {
            problems.push(format!("`expect.error` is not `{{ code, celCode, message, range? }}`: {}", json_text(error)));
        }
    }
    if let Some(deviation) = raw.get("deviation") {
        match deviation.as_object().filter(|fields| !fields.is_empty()) {
            None => problems.push("carries an empty or malformed `deviation`".into()),
            Some(fields) => {
                let deviation_extra = unknown_keys(fields, &DEVIATION_KEYS);
                if !deviation_extra.is_empty() {
                    problems.push(format!("`deviation` carries {}", deviation_extra.join(", ")));
                }
                if fields.get("uncarried").is_some_and(|uncarried| !is_string_list(uncarried)) {
                    problems.push("`deviation.uncarried` is not a non-empty list of inputs".into());
                }
                if let Some(cel_spec) = fields.get("celSpec") {
                    let well_formed = cel_spec
                        .as_object()
                        .is_some_and(|parts| !parts.is_empty() && unknown_keys(parts, &CEL_SPEC_PARTS).is_empty());
                    if !well_formed {
                        problems.push(format!("`deviation.celSpec` is not a non-empty set of {}", CEL_SPEC_PARTS.join(", ")));
                    }
                }
            }
        }
    }
    problems
}

/// The rules for a row's `deviation`, against the engine's answer.
pub fn deviation_problems(row: &Value, answer: &Value) -> Vec<String> {
    let Some(deviation) = row.get("deviation") else { return Vec::new() };
    let mut problems = Vec::new();
    let cel_spec = deviation.get("celSpec").and_then(Value::as_object);
    let reason = deviation.get("reason").and_then(Value::as_str);
    let uncarried: Vec<&str> = deviation
        .get("uncarried")
        .and_then(Value::as_array)
        .map(|inputs| inputs.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    match (cel_spec, reason) {
        (None, Some(reason)) => problems.push(format!("states the reason {} with no `celSpec`", json_text(&Value::String(reason.into())))),
        (Some(_), None) => problems.push("states cel-spec's outcome with no `reason`".into()),
        _ => {}
    }
    if let Some(reason) = reason.filter(|reason| !DEVIATION_REASONS.contains(reason)) {
        problems.push(format!(
            "states the reason {}, which is not one of {}",
            json_text(&Value::String(reason.into())),
            DEVIATION_REASONS.join(", ")
        ));
    }
    for (part, stated) in cel_spec.into_iter().flatten() {
        match cel_spec_part_agrees(part, stated, answer) {
            Ok(true) => problems.push(format!("`deviation.celSpec.{part}` agrees with the answer — drop it")),
            Ok(false) => {}
            Err(problem) => problems.push(format!("`deviation.celSpec.{part}` cannot be compared: {problem}")),
        }
    }
    if reason == Some("uncarried-input") && uncarried.is_empty() {
        problems.push("states `uncarried-input` with nothing in `uncarried`".into());
    }
    if reason == Some("container-not-declared") && !uncarried.contains(&"container") {
        problems.push("states `container-not-declared` and `uncarried` does not hold `container`".into());
    }
    problems
}

/// The `celCode` vocabulary of a language row's error.
pub fn cel_code_problems(row: &Value) -> Vec<String> {
    let Some(error) = row.get("expect").and_then(|expect| expect.get("error")) else { return Vec::new() };
    let mut problems = Vec::new();
    let code = error.get("code").filter(|code| !code.is_null());
    let cel_code = error.get("celCode").filter(|code| !code.is_null());
    if let Some(cel_code) = cel_code {
        if !cel_code.as_str().is_some_and(|text| language_cel_codes().contains(&text)) {
            problems.push(format!("records the celCode {}, which no language answer can carry", json_text(cel_code)));
        }
    }
    if code.is_some() && cel_code.is_some() {
        problems.push("records both a Telo code and a celCode".into());
    }
    if code.is_none() && cel_code.is_none() {
        problems.push("records an error with no code — the engine failing, never an answer".into());
    }
    problems
}

enum RoundTrip {
    Unreadable,
    Equal,
    Failed(String),
}

fn round_trip(environment: &CelEnvironment, source: &str) -> RoundTrip {
    let expression = environment.parse(source);
    if expression.diagnostic.is_some() {
        return RoundTrip::Unreadable;
    }
    if has_unparsed(&expression.root) {
        return RoundTrip::Failed("read with no diagnostic but left an unparsed hole in the tree".into());
    }
    let written = match serialize_tree(&expression.root) {
        Ok(written) => written,
        Err(refusal) => return RoundTrip::Failed(format!("reads and cannot be written: {refusal}")),
    };
    let reread = environment.parse(&written);
    if reread.diagnostic.is_some() {
        return RoundTrip::Failed(format!("wrote {}, which does not read back", json_text(&Value::String(written))));
    }
    if !trees_equal(&expression.root, &reread.root) {
        return RoundTrip::Failed(format!(
            "wrote {}, which reads back as a different expression",
            json_text(&Value::String(written))
        ));
    }
    RoundTrip::Equal
}

/// Whether a file holds the pinned number of rows.
pub fn row_count_problem(rows: &[Value]) -> Option<String> {
    (rows.len() != LANGUAGE_ROWS).then(|| format!("{DRIVEN_FILE} holds {} rows and the pin is {LANGUAGE_ROWS}", rows.len()))
}

pub fn replay_language_rows(rows: &[Value]) -> LanguageReplayReport {
    let mut report = LanguageReplayReport { rows: rows.len(), ..LanguageReplayReport::default() };
    let mut ids: Vec<&str> = Vec::new();
    let base = language_environment();
    let mut after_authored = false;

    for row in rows {
        let id = text_of(row, "id").unwrap_or("<no id>").to_string();
        let mut shape = row_shape_problems(row, after_authored);
        if id.starts_with(AUTHORED_ROW_PREFIX) {
            after_authored = true;
        }
        if ids.contains(&id.as_str()) {
            shape.push("repeats an id".into());
        }
        if let Some(held) = text_of(row, "id") {
            ids.push(held);
        }
        if !shape.is_empty() {
            report.malformed.extend(shape.into_iter().map(|reason| ReplayFailure { id: id.clone(), reason }));
            continue;
        }

        let answer = match language_answer(&base, row) {
            Ok(answer) => answer,
            Err(problem) => {
                report.malformed.push(ReplayFailure { id, reason: format!("its answer cannot be computed: {problem}") });
                continue;
            }
        };
        report.driven += 1;
        let expect = &row["expect"];
        if !json_deep_equal(&answer, expect) {
            report.answers.push(ReplayFailure {
                id: id.clone(),
                reason: format!("the engine answers {} where the row records {}", json_text(&answer), json_text(expect)),
            });
        }
        report.deviations.extend(deviation_problems(row, &answer).into_iter().map(|reason| ReplayFailure { id: id.clone(), reason }));
        report.cel_codes.extend(cel_code_problems(row).into_iter().map(|reason| ReplayFailure { id: id.clone(), reason }));

        let environment = match check_environment(&base, row) {
            Ok(environment) => environment,
            Err(problem) => {
                report.round_trip.push(ReplayFailure { id, reason: problem });
                continue;
            }
        };
        match round_trip(&environment, text_of(row, "source").expect("a well-formed row has a source")) {
            RoundTrip::Unreadable => report.unreadable += 1,
            RoundTrip::Equal => report.round_tripped += 1,
            RoundTrip::Failed(reason) => report.round_trip.push(ReplayFailure { id, reason }),
        }
    }
    report
}
