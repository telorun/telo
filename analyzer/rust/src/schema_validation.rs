//! JSON Schema validation, as Telo configures it: one options factory and its seven
//! named configurations. Mirrors `../../nodejs/src/schema-validation.ts` (`createAjv`,
//! `schemaPatternRefusalIn`, the compile wrapper); AJV's own behaviour is the flat
//! `ajv_*` files, the value a validation reads is `schema_opaque_value`'s view, and a
//! value type's default is decoded first by `value_type_defaults`.
//!
//! Every configuration is draft-07, `strict: false`, with JSON Schema's formats and
//! Telo's, every Telo keyword, and RE2 as the pattern language. They differ only in
//! what a validation reports and writes:
//!
//! - `analysis` — every error, no default filled; a `live` value type is asserted;
//! - `analysis-verbose` — `analysis`, each error naming its schema node;
//! - `analysis-defaults` — `analysis` filling defaults, a value type's decoded first;
//! - `primary` — the first error, defaults filled;
//! - `filling` — `primary` run to completion;
//! - `locating` — every error, each naming its schema node, no default filled;
//! - `schema-validate` — the first error, undeclared members removed, no default filled.
//!
//! A schema compiles only after every pattern it holds has been read: at every place the
//! draft-07 meta-schema declares `format: regex`, whether or not the validator would
//! compile that place, a pattern RE2 refuses fails the compile with the seam's sentence.
//!
//! A validation answers three ways — valid, invalid, or an error: it could not finish
//! (`MAX_NESTING`, as AJV's code throws). No caller reads the error as invalid: each
//! reports `SCHEMA_NESTING_EXCEEDED` where its mismatch would go, worded by
//! [`schema_nesting_exceeded_message`].
//!
//! [`cel_value_of`] has no Node twin: JavaScript holds a parsed JSON document as values
//! already, where Rust converts `serde_json` to the value domain once.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use serde_json::Value;
use telorun_cel::JsonValue;
use telorun_cel_value::{CelValue, PropertyMap};

use crate::ajv_core::{draft_07, Ajv, AjvOptions, Validator};
use crate::ajv_keywords::js_of;
use crate::ajv_runtime::SchemaError;
use crate::manifest_schemas::manifest_root_schema;
use crate::schema_opaque_value::{schema_view, value_of_view, JsValue};
use crate::schema_pattern::schema_pattern_refusal;
use crate::schema_error_report::{schema_issues, SchemaIssue};
use crate::schema_findings_judge::{judge_schema_findings, SchemaJudgment};
use crate::schema_node_validator::{NodeValidatorOptions, SchemaNodeValidator};
use crate::stand_in_findings::StandIns;
use crate::value_type_defaults::fill_value_type_defaults;

/// The named configurations, in the order the factory documents them.
pub const SCHEMA_VALIDATION_CONFIGURATIONS: [&str; 7] =
    ["analysis", "analysis-verbose", "analysis-defaults", "primary", "filling", "locating", "schema-validate"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SchemaValidationConfiguration {
    Analysis,
    AnalysisVerbose,
    AnalysisDefaults,
    Primary,
    Filling,
    Locating,
    SchemaValidate,
}

impl SchemaValidationConfiguration {
    pub fn read(name: &str) -> Option<Self> {
        Some(match name {
            "analysis" => Self::Analysis,
            "analysis-verbose" => Self::AnalysisVerbose,
            "analysis-defaults" => Self::AnalysisDefaults,
            "primary" => Self::Primary,
            "filling" => Self::Filling,
            "locating" => Self::Locating,
            "schema-validate" => Self::SchemaValidate,
            _ => return None,
        })
    }

    fn options(self) -> AjvOptions {
        let (all_errors, verbose, use_defaults, remove_additional, assert_live) = match self {
            Self::Analysis => (true, false, false, false, true),
            Self::AnalysisVerbose => (true, true, false, false, true),
            Self::AnalysisDefaults => (true, false, true, false, true),
            Self::Primary => (false, false, true, false, false),
            Self::Filling => (true, false, true, false, false),
            Self::Locating => (true, true, false, false, false),
            Self::SchemaValidate => (false, false, false, true, false),
        };
        AjvOptions { all_errors, verbose, use_defaults, remove_additional, validate_formats: true, assert_live, telo: true }
    }

    /// Whether a value type's default is filled, decoded, before the validator fills its own.
    fn fills_value_type_defaults(self) -> bool {
        matches!(self, Self::AnalysisDefaults | Self::Primary | Self::Filling)
    }

    /// Whether the value type defaults read the documents registered beside the schema —
    /// the kernel's filler does, the analyzer's reads the schema alone.
    fn reads_documents(self) -> bool {
        matches!(self, Self::Primary | Self::Filling)
    }
}

/// The draft-07 meta-schema with `format: regex` alone asserted, through the pattern
/// seam — compiled once, on an instance knowing no Telo keyword and only the formats the
/// meta-schema names.
fn regex_meta_validator() -> &'static Validator {
    static META: OnceLock<Validator> = OnceLock::new();
    META.get_or_init(|| {
        let options = AjvOptions {
            all_errors: true,
            verbose: false,
            use_defaults: false,
            remove_additional: false,
            validate_formats: true,
            assert_live: false,
            telo: false,
        };
        let mut ajv = Ajv::new(options);
        let JsonValue::Object(draft) = &*draft_07() else { unreachable!("the meta-schema is an object") };
        let renamed: PropertyMap<Arc<JsonValue>> = draft
            .iter()
            .map(|(key, value)| {
                let value = if key == "$id" { Arc::new(JsonValue::String("telo:schema-pattern-meta".into())) } else { value.clone() };
                (key, value)
            })
            .collect();
        ajv.compile(Arc::new(JsonValue::Object(renamed))).expect("the pattern meta-schema compiles")
    })
}

fn value_at(document: &JsonValue, pointer: &str) -> Option<String> {
    let mut at = document;
    for raw in pointer.split('/').skip(1) {
        let key = raw.replace("~1", "/").replace("~0", "~");
        at = match at {
            JsonValue::Object(map) => map.get(&key)?,
            JsonValue::Array(items) => items.get(key.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    match at {
        JsonValue::String(text) => Some(text.clone()),
        _ => None,
    }
}

/// The first pattern in `schema` RE2 refuses, at any place the draft-07 meta-schema reads
/// a pattern, as the seam's sentence; `None` when there is none.
pub fn schema_pattern_refusal_in(schema: &JsonValue) -> Option<String> {
    if !matches!(schema, JsonValue::Object(_) | JsonValue::Array(_)) {
        return None;
    }
    let errors = match regex_meta_validator().validate(&mut js_of(schema)) {
        Ok(errors) => errors,
        Err(overflow) => return Some(overflow),
    };
    errors.iter().find_map(|error| {
        if error.keyword != "format" || error.params.get("format").and_then(Value::as_str) != Some("regex") {
            return None;
        }
        let pattern = match &error.property_name {
            Some(key) => key.clone(),
            None => value_at(schema, &error.instance_path)?,
        };
        schema_pattern_refusal(&pattern, "")
    })
}

/// The code a static check reports a validation that could not finish under.
pub const SCHEMA_NESTING_EXCEEDED: &str = "SCHEMA_NESTING_EXCEEDED";

/// The sentence of a validation that could not finish: `label` is the declaration
/// (`<Kind>/<name>`), `place` the value it validated (`the value at 'handler'`).
pub fn schema_nesting_exceeded_message(label: &str, place: &str) -> String {
    format!("{label}: {}", schema_nesting_exceeded_sentence(place))
}

/// [`schema_nesting_exceeded_message`] without its label, for a message that names the
/// declaration itself.
pub fn schema_nesting_exceeded_sentence(place: &str) -> String {
    format!(
        "{place} cannot be validated — validating it nests past the depth a validation may reach. Either its schema refers to itself without descending into the value, or the value is nested deeper than a validation can follow: make each self-reference descend into the value at every step, or nest the value less deeply."
    )
}

/// A JSON value as a value: an integer as an int64 (a uint past its range), so a value
/// that passes validation reaches its reader with the integers it was written with. Built
/// without recursion, so no depth of nesting exhausts the stack.
pub fn cel_value_of(value: &Value) -> CelValue {
    enum Step<'v> {
        Enter(&'v Value),
        List(usize),
        Record(&'v serde_json::Map<String, Value>),
    }
    let mut work = vec![Step::Enter(value)];
    let mut done: Vec<CelValue> = Vec::new();
    while let Some(step) = work.pop() {
        match step {
            Step::Enter(Value::Array(items)) => {
                work.push(Step::List(items.len()));
                work.extend(items.iter().rev().map(Step::Enter));
            }
            Step::Enter(Value::Object(map)) => {
                work.push(Step::Record(map));
                work.extend(map.values().rev().map(Step::Enter));
            }
            Step::Enter(scalar) => done.push(match scalar {
                Value::Null => CelValue::Null,
                Value::Bool(b) => CelValue::Bool(*b),
                Value::Number(n) => match (n.as_i64(), n.as_u64()) {
                    (Some(i), _) => CelValue::Int(i),
                    (None, Some(u)) => CelValue::Uint(u),
                    _ => CelValue::Double(n.as_f64().unwrap_or(f64::NAN)),
                },
                Value::String(text) => CelValue::String(text.as_str().into()),
                Value::Array(_) | Value::Object(_) => unreachable!("containers are entered above"),
            }),
            Step::List(len) => {
                let items = done.split_off(done.len() - len);
                done.push(CelValue::List(items.into_iter().collect::<telorun_cel_value::CelList>()));
            }
            Step::Record(map) => {
                let items = done.split_off(done.len() - map.len());
                let mut record = telorun_cel_value::CelRecord::new();
                for (key, item) in map.keys().zip(items) {
                    record.insert(key, item);
                }
                done.push(CelValue::Record(record));
            }
        }
    }
    done.pop().expect("one value was built")
}

/// A JSON value as JavaScript reads one: every number a double, every object in
/// ECMAScript's own-property order. Built without recursion, so no depth of nesting
/// exhausts the stack.
pub fn json_value_of(value: &Value) -> Arc<JsonValue> {
    enum Step<'v> {
        Enter(&'v Value),
        Array(usize),
        Object(&'v serde_json::Map<String, Value>),
    }
    let mut work = vec![Step::Enter(value)];
    let mut done: Vec<Arc<JsonValue>> = Vec::new();
    while let Some(step) = work.pop() {
        match step {
            Step::Enter(Value::Array(items)) => {
                work.push(Step::Array(items.len()));
                work.extend(items.iter().rev().map(Step::Enter));
            }
            Step::Enter(Value::Object(map)) => {
                work.push(Step::Object(map));
                work.extend(map.values().rev().map(Step::Enter));
            }
            Step::Enter(scalar) => done.push(Arc::new(match scalar {
                Value::Null => JsonValue::Null,
                Value::Bool(b) => JsonValue::Bool(*b),
                Value::Number(n) => JsonValue::Number(n.as_f64().unwrap_or(f64::NAN)),
                Value::String(s) => JsonValue::String(s.clone()),
                Value::Array(_) | Value::Object(_) => unreachable!("containers are entered above"),
            })),
            Step::Array(len) => {
                let items = done.split_off(done.len() - len);
                done.push(Arc::new(JsonValue::Array(items)));
            }
            Step::Object(map) => {
                let items = done.split_off(done.len() - map.len());
                done.push(Arc::new(JsonValue::Object(map.keys().map(String::as_str).zip(items).collect())));
            }
        }
    }
    done.pop().expect("one value was built")
}

/// A validator instance of one configuration, holding the documents registered on it.
pub struct SchemaValidation {
    configuration: SchemaValidationConfiguration,
    ajv: Ajv,
    documents: HashMap<String, Value>,
}

/// What one validation answers: whether the value is valid, every error recorded, and
/// the value after defaults were filled and undeclared members removed.
#[derive(Clone, Debug)]
pub struct Validation {
    pub valid: bool,
    pub errors: Vec<SchemaError>,
    pub value: CelValue,
}

/// A compiled schema of one configuration.
pub struct CompiledSchema {
    configuration: SchemaValidationConfiguration,
    validator: Validator,
    schema: Value,
    documents: HashMap<String, Value>,
}

impl SchemaValidation {
    /// An instance of `configuration` with the manifest root registered.
    pub fn new(configuration: SchemaValidationConfiguration) -> Self {
        let mut validation = Self::without_manifest_root(configuration);
        validation.ajv.add_schema(manifest_root_schema(), None, false).expect("the manifest root registers");
        validation
    }

    /// An instance that leaves the manifest root out — for a caller judging another copy
    /// of its fragments.
    pub fn without_manifest_root(configuration: SchemaValidationConfiguration) -> Self {
        Self { configuration, ajv: Ajv::new(configuration.options()), documents: HashMap::new() }
    }

    pub fn configuration(&self) -> SchemaValidationConfiguration {
        self.configuration
    }

    /// Whether a validation fills `default:`s.
    pub fn fills_defaults(&self) -> bool {
        self.configuration.options().use_defaults
    }

    pub(crate) fn ajv(&self) -> &Ajv {
        &self.ajv
    }

    pub(crate) fn ajv_mut(&mut self) -> &mut Ajv {
        &mut self.ajv
    }

    /// Register a document already read as JavaScript reads it, unchecked against the
    /// meta-schema — `addSchema(schema, key, undefined, false)`.
    pub(crate) fn add_document(&mut self, schema: Arc<JsonValue>, key: &str) -> Result<(), String> {
        self.ajv.add_schema(schema.clone(), Some(key), false)?;
        self.documents.insert(key.to_string(), crate::ajv_runtime::json_of(&schema));
        Ok(())
    }

    /// The document `id` names on this instance, read and never compiled.
    pub fn registered_document(&self, id: &str) -> Option<Arc<JsonValue>> {
        self.ajv.registered_document(id)
    }

    /// Register `schema` under `key` (AJV's `addSchema`), held to the meta-schema first.
    pub fn add_schema(&mut self, schema: &Value, key: &str) -> Result<(), String> {
        self.ajv.add_schema(json_value_of(schema), Some(key), true)?;
        self.documents.insert(key.to_string(), schema.clone());
        Ok(())
    }

    /// Compile `schema`: every pattern it holds judged, then AJV's own compile — its
    /// meta-schema check and its reference resolution — the refusal as AJV's message.
    pub fn compile(&mut self, schema: &Value) -> Result<CompiledSchema, String> {
        self.compile_json(json_value_of(schema))
    }

    /// [`compile`](Self::compile) over a schema already read as JavaScript reads it. AJV
    /// knows a schema by its object: compiling the same `Arc` again reuses what the first
    /// compile registered, where an equal copy declaring an `$id` is refused as a second
    /// schema of that id.
    pub fn compile_json(&mut self, schema: Arc<JsonValue>) -> Result<CompiledSchema, String> {
        if let Some(refusal) = schema_pattern_refusal_in(&schema) {
            return Err(refusal);
        }
        let validator = self.ajv.compile(schema.clone())?;
        let schema = crate::ajv_runtime::json_of(&schema);
        Ok(CompiledSchema { configuration: self.configuration, validator, schema, documents: self.documents.clone() })
    }
}

impl CompiledSchema {
    /// Validate `value`; a schema whose subschemas nest without end over it fails as
    /// AJV's code throws, with V8's `RangeError` message.
    pub fn validate(&self, value: &CelValue) -> Result<Validation, String> {
        let mut value = value.clone();
        if self.configuration.fills_value_type_defaults() {
            let resolve = |id: &str| self.documents.get(id);
            let external: Option<&crate::schema_compat::ExternalSchemaResolver<'_>> =
                if self.configuration.reads_documents() { Some(&resolve) } else { None };
            if let Some(filled) = fill_value_type_defaults(&value, &self.schema, external) {
                value = filled;
            }
        }
        let mut view = schema_view(&value);
        let errors = self.validator.validate(&mut view)?;
        let keep_exact = self.configuration != SchemaValidationConfiguration::SchemaValidate;
        Ok(Validation { valid: errors.is_empty(), errors, value: value_of_view(&view, keep_exact) })
    }

    /// Validate the validator's view of a value directly, in place.
    pub fn validate_view(&self, view: &mut JsValue) -> Result<Vec<SchemaError>, String> {
        self.validator.validate(view)
    }
}

/// `judgedSchemaIssues`: issues for `errors`, raised by `host` validating `data` against
/// `schema`, each union decided by the judge on a verbose twin of the host and each finding
/// about a stand-in in `stand_ins` excused. `schema` is the `Arc` the host compiled. An
/// error is a validation that could not finish.
pub fn judged_schema_issues(
    host: &SchemaValidation,
    errors: &[SchemaError],
    data: &CelValue,
    schema: &Arc<JsonValue>,
    stand_ins: StandIns,
) -> Result<Vec<SchemaIssue>, String> {
    let twin = std::cell::RefCell::new(SchemaNodeValidator::new(
        SchemaValidation::new(SchemaValidationConfiguration::AnalysisVerbose),
        NodeValidatorOptions { resolve_reference: Box::new(|id| host.registered_document(id)), canonical: None, fill_defaults: None },
    ));
    let validate = |node: &Arc<JsonValue>, value: &mut CelValue| twin.borrow_mut().findings(schema, node, value);
    let reference = |node: &Arc<JsonValue>, reference: &str| twin.borrow_mut().reference(node, reference);
    let mut judgment = SchemaJudgment { value: data.clone(), schema: schema.clone(), stand_ins, validate: &validate, reference: &reference };
    let judged = judge_schema_findings(errors, &mut judgment)?;
    Ok(schema_issues(&judged, Some(data)))
}

/// `validateAgainstSchema`: a value validated under `analysis`, an instance value opaque —
/// the issues, each union judged, or none. A schema that does not compile is its author's,
/// reported where it is declared, so it yields none here. An error is a validation that
/// could not finish, as AJV's code throws.
pub fn validate_against_schema(data: &CelValue, schema: &Value) -> Result<Vec<SchemaIssue>, String> {
    let mut host = SchemaValidation::new(SchemaValidationConfiguration::Analysis);
    let arc = json_value_of(schema);
    let Ok(compiled) = host.compile_json(arc.clone()) else { return Ok(Vec::new()) };
    let errors = compiled.validate(data)?.errors;
    if errors.is_empty() {
        return Ok(Vec::new());
    }
    judged_schema_issues(&host, &errors, data, &arc, StandIns::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_schema_nesting_without_end_fails_as_ajv_s_code_throws() {
        let mut validation = SchemaValidation::new(SchemaValidationConfiguration::Analysis);
        let schema = serde_json::json!({ "type": "object", "$ref": "#" });
        let compiled = validation.compile(&schema).expect("the schema compiles");
        let mut value = telorun_cel_value::CelRecord::new();
        value.insert("leaf", CelValue::Double(1.0));
        let value = CelValue::Record(value);
        // The walk nests on the heap, so a thread whose stack holds a few native frames
        // reaches the bound and answers that the validation could not finish.
        let answer = std::thread::scope(|scope| {
            std::thread::Builder::new()
                .stack_size(64 << 10)
                .spawn_scoped(scope, || compiled.validate(&value).map(|validation| validation.valid))
                .expect("the thread starts")
                .join()
                .expect("the validation returns")
        });
        assert_eq!(answer, Err("Maximum call stack size exceeded".to_string()));
    }

    /// A list nested `depth` deep around `leaf`, built without recursion.
    fn nested(depth: usize, leaf: CelValue) -> CelValue {
        (0..depth).fold(leaf, |inner, _| CelValue::List(vec![inner].into_iter().collect::<telorun_cel_value::CelList>()))
    }

    #[test]
    fn a_value_of_any_depth_is_validated_on_a_small_stack() {
        const DEPTH: usize = 5_000;
        let mut locating = SchemaValidation::new(SchemaValidationConfiguration::Locating);
        let unique = locating.compile(&serde_json::json!({ "uniqueItems": true })).expect("the schema compiles");
        let twins = CelValue::List(vec![nested(DEPTH, CelValue::Double(1.0)), nested(DEPTH, CelValue::Double(1.0))].into_iter().collect());
        let mut primary = SchemaValidation::new(SchemaValidationConfiguration::Primary);
        let chain_schema = serde_json::json!({
            "type": "object",
            "properties": { "next": { "$ref": "#" }, "after": { "x-telo-type": "Telo.Duration", "default": "1s" } }
        });
        let chain = primary.compile(&chain_schema).expect("the schema compiles");
        let mut linked = CelValue::Record(telorun_cel_value::CelRecord::new());
        for _ in 0..DEPTH {
            let mut record = telorun_cel_value::CelRecord::new();
            record.insert("next", linked);
            linked = CelValue::Record(record);
        }
        // Nothing is held per level on the native stack: a debug build's constant frames
        // need under 96 KiB, where a recursive walk five thousand deep needs megabytes.
        std::thread::scope(|scope| {
            std::thread::Builder::new()
                .stack_size(128 << 10)
                .spawn_scoped(scope, || {
                    // Deep equality, the verbose error's copy of the value, the value read
                    // back and the view released.
                    let judged = unique.validate(&twins).expect("the validation finishes");
                    assert!(!judged.valid);
                    assert_eq!(judged.errors.len(), 1);
                    assert_eq!(judged.errors[0].message, "must NOT have duplicate items (items ## 0 and 1 are identical)");
                    assert!(judged.errors[0].data.is_some());
                    assert!(judged.value == twins);
                    // Every level's decoded default is filled before the walk reaches its bound.
                    assert_eq!(chain.validate(&linked).map(|validation| validation.valid), Err("Maximum call stack size exceeded".to_string()));
                })
                .expect("the thread starts")
                .join()
                .expect("the validations return")
        });
    }
}
