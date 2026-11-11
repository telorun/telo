//! Replaying the conformance vectors' dialect rows the engine alone can answer —
//! `catalog.json` and `types.json` — the twin of `cel/nodejs/conformance/dialect-replay.ts`.
//!
//! Each row's `expect` is the `cel` tag engine's whole answer. Of it this driver computes the
//! part `telorun-cel` gives by itself, the **projection**: the check's diagnostics (`code`,
//! `message`, `fix`, in order) and its type when clean, then the row's value or its error
//! (`code`, `celCode`, `message`), and deep-compares it with the same projection of the row.
//! What the tag engine adds — calls, regions, refs, volatility — and every range is outside it.
//!
//! **The host's vocabulary is a parameter, never a name written here.** The nominal types come
//! in as `NominalTypeDefinition`s, and the driver refuses a row declaring a type name the
//! parameter does not hold. The driver takes the rows as a parameter and names no path.
//!
//! A row's two halves are independent: the static half checks against the row's declarations
//! plus the host types; the runtime half evaluates, unchecked, against the bindings with the
//! host types registered too but no declarations. Every conversion and member a host type
//! declares is bound at runtime to the conformance rule `<name>(<conformance text of each
//! argument>)`, as the nine host-backed functions are.
//!
//! Its blind spot: deep equality pins whatever Node answered, and nothing outside the
//! projection is held here.

#![allow(dead_code)]

use std::collections::BTreeSet;
use std::sync::Arc;

use serde_json::{Map, Value};
use telorun_cel::{
    cel_error, register_function_catalog, CatalogRefusal, CelCallContext, CelCatalogHandlers, CelEnvironment,
    CelEnvironmentOptions, CelEvaluationCode, CelValue, EvaluateOptions, FunctionMetadata, NominalTypeDefinition,
    PropertyMap, RegisterCatalogOptions,
};

use super::conformance_error::recorded_error;
use super::conformance_value::{
    conformance_text, encode_conformance_value, json_deep_equal, json_text, read_canonical_conformance_value,
};
use super::language_replay::type_declaration;

pub const CATALOG_FILE: &str = "catalog.json";
pub const CATALOG_ROWS: usize = 195;
pub const TYPES_FILE: &str = "types.json";
pub const TYPES_ROWS: usize = 74;

/// The inputs only a tag site has, which a row of these two files may not carry.
pub const TAG_SITE_INPUTS: [&str; 6] = ["context", "explain", "rootsDeclared", "couldNameModule", "modules", "functions"];

/// How many rows a driven file holds, or nothing for a file this driver does not answer for.
pub fn pinned_rows(file: &str) -> Option<usize> {
    match file {
        CATALOG_FILE => Some(CATALOG_ROWS),
        TYPES_FILE => Some(TYPES_ROWS),
        _ => None,
    }
}

/// Why a file does not hold the rows it is pinned to; nothing when it does.
pub fn row_count_problem(file: &str, rows: &[Value]) -> Option<String> {
    let pinned = pinned_rows(file)?;
    (rows.len() != pinned).then(|| format!("{file} holds {} rows where {pinned} are pinned", rows.len()))
}

/// What the conformance rule answers for a call: its name, then each argument's text.
fn conformance_answer(name: &str, arguments: &[&CelValue]) -> Result<String, CatalogRefusal> {
    let mut texts = Vec::with_capacity(arguments.len());
    for argument in arguments {
        texts.push(conformance_text(argument).map_err(|refusal| CatalogRefusal::new(refusal.0))?);
    }
    Ok(format!("{name}({})", texts.join(", ")))
}

fn text_value(text: &str) -> CelValue {
    CelValue::String(text.into())
}

/// The conformance handler set: each of the nine host-backed functions answers with its
/// own name and each argument's conformance text.
pub fn conformance_handlers() -> CelCatalogHandlers {
    type One = Arc<dyn Fn(&str) -> Result<String, CatalogRefusal> + Send + Sync>;
    let one = |name: &'static str| -> One { Arc::new(move |text| conformance_answer(name, &[&text_value(text)])) };
    CelCatalogHandlers {
        sha256: Some(one("sha256")),
        md5: Some(one("md5")),
        sha1: Some(one("sha1")),
        sha512: Some(one("sha512")),
        hmac: Some(Arc::new(|algorithm, key, message| {
            conformance_answer("hmac", &[&text_value(algorithm), &text_value(key), &text_value(message)])
        })),
        base64_encode: Some(one("base64Encode")),
        base64_decode: Some(one("base64Decode")),
        json: Some(Arc::new(|value| conformance_answer("json", &[value]))),
        join_path: Some(Arc::new(|base, relative| {
            conformance_answer("joinPath", &[&text_value(base), &text_value(relative)])
        })),
    }
}

/// The dialect environment: the language environment plus the function catalog, with the
/// conformance handler set installed. The host types are not here: each half registers them
/// on a clone of its own.
pub fn dialect_environment() -> CelEnvironment {
    let mut environment = CelEnvironment::new(CelEnvironmentOptions {
        unlisted_variables_are_dyn: true,
        enable_optional_types: true,
        homogeneous_aggregate_literals: false,
        ..CelEnvironmentOptions::default()
    });
    register_function_catalog(&mut environment, RegisterCatalogOptions { handlers: conformance_handlers() });
    environment
}

fn register_host_types(environment: &mut CelEnvironment, host_types: &[NominalTypeDefinition]) -> Result<(), String> {
    for definition in host_types {
        environment
            .register_type(definition.clone())
            .map_err(|refusal| format!("the host type {:?} cannot be registered: {refusal}", definition.name))?;
    }
    Ok(())
}

/// The environment a row is CHECKED in: the host types, then its declarations.
pub fn static_environment(
    base: &CelEnvironment,
    row: &Value,
    host_types: &[NominalTypeDefinition],
) -> Result<CelEnvironment, String> {
    let mut environment = base.clone();
    register_host_types(&mut environment, host_types)?;
    if let Some(declarations) = row.get("declarations").and_then(Value::as_object) {
        for (name, declaration) in declarations {
            environment
                .register_variable(name, type_declaration(declaration)?, None)
                .map_err(|refusal| format!("the variable {name:?} cannot be declared: {refusal}"))?;
        }
    }
    Ok(environment)
}

/// `Self` as a whole word replaced by a type's name.
fn with_self_named(written: &str, name: &str) -> String {
    let is_word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let mut out = String::new();
    let mut word = String::new();
    let flush = |word: &mut String, out: &mut String| {
        out.push_str(if word == "Self" { name } else { word.as_str() });
        word.clear();
    };
    for c in written.chars() {
        if is_word(c) {
            word.push(c);
        } else {
            flush(&mut word, &mut out);
            out.push(c);
        }
    }
    flush(&mut word, &mut out);
    out
}

/// The name a signature calls: the identifier directly before its parameter list.
fn called_name(signature: &str) -> &str {
    let head = signature.split('(').next().unwrap_or(signature);
    head.rsplit('.').next().unwrap_or(head)
}

/// The environment a row is EVALUATED in: the host types, each conversion and member they
/// declare bound to a conformance implementation, and no declarations.
pub fn runtime_environment(base: &CelEnvironment, host_types: &[NominalTypeDefinition]) -> Result<CelEnvironment, String> {
    let mut environment = base.clone();
    for definition in host_types {
        register_host_types(&mut environment, std::slice::from_ref(definition))?;
        for written in definition.conversions.iter().chain(definition.members.iter()) {
            let signature = with_self_named(written, &definition.name);
            let name = called_name(&signature).to_string();
            let implementation = Arc::new(move |_: &CelCallContext, args: &[CelValue]| {
                let held: Vec<&CelValue> = args.iter().collect();
                match conformance_answer(&name, &held) {
                    Ok(text) => CelValue::String(text.into()),
                    Err(refusal) => cel_error(CelEvaluationCode::InvalidArgument, refusal.message, None).into(),
                }
            });
            environment
                .register_function(
                    signature.as_str(),
                    FunctionMetadata { implementation: Some(implementation), ..FunctionMetadata::default() },
                )
                .map_err(|refusal| format!("{signature:?} cannot be bound: {refusal}"))?;
        }
    }
    Ok(environment)
}

/// The row's bindings as an activation. Refuses a binding not in its canonical writing.
fn activation_of(row: &Value) -> Result<PropertyMap<CelValue>, String> {
    let mut activation = PropertyMap::new();
    if let Some(bindings) = row.get("bindings").and_then(Value::as_object) {
        for (name, node) in bindings {
            let value = read_canonical_conformance_value(node).map_err(|refusal| format!("the binding {name:?}: {refusal}"))?;
            activation.insert(name.clone(), value);
        }
    }
    Ok(activation)
}

/// An error as the projection holds it: no range.
fn projected_error(error: &Value) -> Value {
    let mut out = Map::new();
    for key in ["code", "celCode", "message"] {
        out.insert(key.into(), error.get(key).cloned().unwrap_or(Value::Null));
    }
    Value::Object(out)
}

/// The engine's projection of a row's answer. The static half is the engine's check in the
/// static environment; the runtime half its own evaluation, unchecked, with the bindings.
pub fn dialect_projection(
    base: &CelEnvironment,
    runtime: &CelEnvironment,
    row: &Value,
    host_types: &[NominalTypeDefinition],
) -> Result<Value, String> {
    let source = row.get("source").and_then(Value::as_str).ok_or("has no string `source`")?;
    let activation = activation_of(row)?;
    let checked = static_environment(base, row, host_types)?.check(source);
    let diagnostics = checked
        .diagnostics
        .iter()
        .map(|diagnostic| {
            let mut out = Map::new();
            out.insert("code".into(), Value::String(diagnostic.code.as_str().into()));
            out.insert("message".into(), Value::String(diagnostic.message.clone()));
            if let Some(fix) = &diagnostic.fix {
                let mut replacement = Map::new();
                replacement.insert("replacement".into(), Value::String(fix.replacement.clone()));
                out.insert("fix".into(), Value::Object(replacement));
            }
            Value::Object(out)
        })
        .collect();
    let mut check = Map::new();
    check.insert("diagnostics".into(), Value::Array(diagnostics));
    if checked.diagnostics.is_empty() {
        check.insert("type".into(), Value::String(checked.type_name.clone()));
    }
    let mut answer = Map::new();
    answer.insert("check".into(), Value::Object(check));
    match runtime.evaluate(source, &activation, &EvaluateOptions::default()) {
        Ok(value) => {
            let encoded = encode_conformance_value(&value).map_err(|refusal| format!("its value cannot be written: {refusal}"))?;
            answer.insert("value".into(), encoded);
        }
        Err(cause) => {
            let recorded = recorded_error(&cause).map_err(|refusal| refusal.0)?;
            answer.insert("error".into(), projected_error(&recorded.to_json()));
        }
    }
    Ok(Value::Object(answer))
}

/// The same projection of what a row records.
pub fn recorded_projection(row: &Value) -> Value {
    let expect = &row["expect"];
    let check = &expect["check"];
    let mut kept = Map::new();
    kept.insert("diagnostics".into(), check.get("diagnostics").cloned().unwrap_or(Value::Null));
    if let Some(ty) = check.get("type") {
        kept.insert("type".into(), ty.clone());
    }
    let mut out = Map::new();
    out.insert("check".into(), Value::Object(kept));
    if let Some(value) = expect.get("value") {
        out.insert("value".into(), value.clone());
    }
    if let Some(error) = expect.get("error") {
        out.insert("error".into(), projected_error(error));
    }
    Value::Object(out)
}

/// Why a row is not a question the engine alone answers; nothing when it is.
pub fn input_problems(base: &CelEnvironment, row: &Value) -> Vec<String> {
    let mut problems = Vec::new();
    let tag = row.get("tag");
    if tag.and_then(Value::as_str) != Some("cel") {
        let shown = tag.map(json_text).unwrap_or_else(|| "undefined".into());
        problems.push(format!("names the tag {shown}; these files ask the cel engine alone"));
    }
    for key in TAG_SITE_INPUTS {
        if row.get(key).is_some() {
            problems.push(format!("carries `{key}`, an input only a tag site has"));
        }
    }
    if let Some(source) = row.get("source").and_then(Value::as_str) {
        if let Some(diagnostic) = base.parse(source).diagnostic {
            problems.push(format!("does not read: {}", diagnostic.message));
        }
    }
    if let Some(error) = row.get("expect").and_then(|expect| expect.get("error")) {
        let coded = error.get("code").is_some_and(|code| !code.is_null());
        let cel_coded = error.get("celCode").is_some_and(Value::is_string);
        if coded || !cel_coded {
            problems.push(format!("records an error that is not the engine's own: {}", json_text(error)));
        }
    }
    problems
}

/// Every type name a row's declarations mention, so a missing host type is named.
fn declared_type_names(rows: &[Value]) -> BTreeSet<String> {
    fn read(declaration: &Value, names: &mut BTreeSet<String>) {
        match declaration {
            Value::String(text) => {
                for name in text.split(|c: char| matches!(c, '<' | '>' | ',') || c.is_whitespace()) {
                    let mut chars = name.chars();
                    let first_capital = chars.next().is_some_and(|c| c.is_ascii_uppercase());
                    if first_capital && name.chars().count() > 1 {
                        names.insert(name.to_string());
                    }
                }
            }
            Value::Object(record) => {
                if let Some(fields) = record.get("fields").and_then(Value::as_object) {
                    for field in fields.values() {
                        read(field, names);
                    }
                }
            }
            _ => {}
        }
    }
    let mut names = BTreeSet::new();
    for row in rows {
        if let Some(declarations) = row.get("declarations").and_then(Value::as_object) {
            for declaration in declarations.values() {
                read(declaration, &mut names);
            }
        }
    }
    names
}

/// Which type names a row declares that the supplied host types do not account for. A row
/// the driver cannot build an environment for would otherwise be "answered" by whatever an
/// undeclared name reads as, which is not an answer at all.
pub fn unknown_declared_types(rows: &[Value], host_types: &[NominalTypeDefinition]) -> Vec<String> {
    declared_type_names(rows)
        .into_iter()
        .filter(|name| !host_types.iter().any(|definition| &definition.name == name))
        .collect()
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct DialectReplayFailure {
    pub id: String,
    pub reason: String,
}

#[derive(Clone, Debug, Default)]
pub struct DialectReplayReport {
    pub file: String,
    pub rows: usize,
    /// Rows whose projection was computed and compared.
    pub driven: usize,
    /// A row breaking the format, or one whose answer cannot be computed.
    pub malformed: Vec<DialectReplayFailure>,
    /// A row that is not a question the engine alone answers.
    pub inputs: Vec<DialectReplayFailure>,
    /// A row whose projection is not the engine's.
    pub answers: Vec<DialectReplayFailure>,
}

pub fn replay_dialect_rows(file: &str, rows: &[Value], host_types: &[NominalTypeDefinition]) -> DialectReplayReport {
    let mut report = DialectReplayReport { file: file.into(), rows: rows.len(), ..DialectReplayReport::default() };
    let base = dialect_environment();
    let runtime = match runtime_environment(&base, host_types) {
        Ok(runtime) => runtime,
        Err(reason) => {
            report.malformed.push(DialectReplayFailure { id: file.into(), reason });
            return report;
        }
    };
    let mut ids = BTreeSet::new();
    for row in rows {
        let id = row.get("id").and_then(Value::as_str);
        let shaped = id.is_some() && row.get("source").is_some_and(Value::is_string) && row.get("expect").and_then(|e| e.get("check")).is_some();
        let Some(id) = id.filter(|_| shaped) else {
            let shown = row.get("id").map(json_text).unwrap_or_else(|| "undefined".into());
            report.malformed.push(DialectReplayFailure {
                id: shown,
                reason: "lacks a string `id`, a string `source` or `expect.check`".into(),
            });
            continue;
        };
        if !ids.insert(id.to_string()) {
            report.malformed.push(DialectReplayFailure { id: id.into(), reason: "repeats an id".into() });
        }
        let refused = input_problems(&base, row);
        if !refused.is_empty() {
            report.inputs.extend(refused.into_iter().map(|reason| DialectReplayFailure { id: id.into(), reason }));
            continue;
        }
        let answer = match dialect_projection(&base, &runtime, row, host_types) {
            Ok(answer) => answer,
            Err(reason) => {
                report.malformed.push(DialectReplayFailure { id: id.into(), reason: format!("its answer cannot be computed: {reason}") });
                continue;
            }
        };
        report.driven += 1;
        let recorded = recorded_projection(row);
        if !json_deep_equal(&answer, &recorded) {
            report.answers.push(DialectReplayFailure {
                id: id.into(),
                reason: format!("the engine answers {} where the row records {}", json_text(&answer), json_text(&recorded)),
            });
        }
    }
    report
}
