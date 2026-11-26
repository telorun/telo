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
use std::sync::Arc;

use telorun_cel::{
    has_unparsed, read_json_text, serialize_tree, trees_equal, AssumedCondition, CelEnvironment, CelEnvironmentOptions,
    CelEvaluateError, CelValue, CheckAssumption, CheckOptions, EvaluateOptions, FieldDeclaration, FunctionMetadata, JsonSchemaDocument, JsonValue,
    NamespaceFunctionDeclaration, NamespaceOptions, NominalOperatorDeclaration, NominalTypeDefinition, PropertyMap,
    ResolvedCall, SchemaDependency, SchemaOwnTypeAgreement, SchemaRegistrationReport, SchemaTypeAnswer,
    SchemaTypeResolver, TypeDeclaration,
    WithheldReturns, schema_own_types_agree, types_equal,
};

use super::conformance_error::{check_refusal, language_cel_codes, recorded_error, recorded_range};
use super::conformance_value::{encode_conformance_value, json_deep_equal, json_text, read_canonical_conformance_value};

/// The one file of the vectors this driver answers for.
pub const DRIVEN_FILE: &str = "language.json";

/// How many rows the file holds. A row deleted leaves every other count true, so it is pinned.
pub const LANGUAGE_ROWS: usize = 2189;

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

const ROW_KEYS: [&str; 14] = [
    "id",
    "source",
    "provenance",
    "types",
    "declarations",
    "documents",
    "namedTypes",
    "functions",
    "namespaces",
    "variants",
    "bindings",
    "assumptions",
    "expect",
    "deviation",
];
const ASSUMPTION_KEYS: [&str; 3] = ["condition", "holds", "rebound"];
/// What a `types` entry may say: a type definition's own keys, and no implementation.
const TYPE_KEYS: [&str; 11] = [
    "name",
    "base",
    "parameters",
    "operators",
    "comparisons",
    "conversions",
    "members",
    "fields",
    "constructible",
    "required",
    "description",
];
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

fn texts(node: Option<&Value>, what: &str) -> Result<Vec<String>, String> {
    match node {
        None => Ok(Vec::new()),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| item.as_str().map(str::to_string).ok_or_else(|| format!("`{what}` holds {}, not a string", json_text(item))))
            .collect(),
        Some(other) => Err(format!("`{what}` is {}, not a list", json_text(other))),
    }
}

/// One entry of a row's `types` as the definition it is data for.
pub fn type_definition(node: &Value) -> Result<NominalTypeDefinition, String> {
    let held = node.as_object().ok_or_else(|| format!("declares the type {}, which is not an object", json_text(node)))?;
    let text = |key: &str| held.get(key).and_then(Value::as_str).map(str::to_string);
    let operators = match held.get("operators") {
        None => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                Ok(NominalOperatorDeclaration {
                    operator: item.get("operator").and_then(Value::as_str).ok_or("an operator has no `operator`")?.into(),
                    parameters: texts(item.get("parameters"), "parameters")?,
                    returns: item.get("returns").and_then(Value::as_str).ok_or("an operator has no `returns`")?.into(),
                })
            })
            .collect::<Result<_, String>>()?,
        Some(other) => return Err(format!("`operators` is {}, not a list", json_text(other))),
    };
    let fields = match held.get("fields") {
        None => None,
        Some(Value::Object(declared)) => Some(
            declared
                .iter()
                .map(|(name, ty)| {
                    ty.as_str().map(|ty| (name.clone(), ty.to_string())).ok_or_else(|| format!("field {name:?} is not a type"))
                })
                .collect::<Result<PropertyMap<String>, String>>()?,
        ),
        Some(other) => return Err(format!("`fields` is {}, not an object", json_text(other))),
    };
    Ok(NominalTypeDefinition {
        name: text("name").ok_or("a type has no `name`")?,
        base: text("base").ok_or("a type has no `base`")?,
        parameters: texts(held.get("parameters"), "parameters")?,
        operators,
        comparisons: texts(held.get("comparisons"), "comparisons")?,
        conversions: texts(held.get("conversions"), "conversions")?,
        members: texts(held.get("members"), "members")?,
        fields,
        constructible: held.get("constructible").and_then(Value::as_bool).unwrap_or(false),
        required: texts(held.get("required"), "required")?,
        description: text("description"),
    })
}

/// The row's types registered onto a copy of the environment, in the order the row lists them.
fn with_types(base: &CelEnvironment, row: &Value) -> Result<CelEnvironment, String> {
    let mut environment = base.clone();
    for node in row.get("types").and_then(Value::as_array).into_iter().flatten() {
        let definition = type_definition(node)?;
        let name = definition.name.clone();
        environment.register_type(definition).map_err(|refusal| format!("the type {name:?} cannot be registered: {refusal}"))?;
    }
    Ok(environment)
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

/// A schema as the engine reads one: its JSON text read back, an object's keys in
/// ECMAScript's own-property order as `JSON.parse` leaves them.
fn schema_node(node: &Value) -> Result<Arc<JsonValue>, String> {
    let text = serde_json::to_string(node).map_err(|refusal| refusal.to_string())?;
    read_json_text(&text).map_err(|refusal| format!("{} is not JSON text the engine reads: {refusal:?}", json_text(node)))
}

/// A declaration typing a name from a schema, `{ "schema": … }`.
fn declared_schema(node: &Value) -> Option<&Value> {
    node.as_object().filter(|held| held.len() == 1).and_then(|held| held.get("schema"))
}

/// The documents a row hands over, each by the row's name for it: a declaration's schema
/// under the declared name, a namespaced function's result under `<namespace>.<name>`, and
/// each `documents` entry under its key.
pub type RowDocuments = Vec<(Arc<JsonValue>, String)>;

/// The row's `documents`, read, and its resolver over them and its `namedTypes`: a node
/// whose `$ref` is exactly a key of `namedTypes` is that named type, and one whose `$ref` is
/// exactly a key of `documents` is read as that document.
fn row_documents(row: &Value) -> Result<(RowDocuments, Option<SchemaTypeResolver>), String> {
    let mut named: RowDocuments = Vec::new();
    let mut documents: Vec<(String, Arc<JsonValue>)> = Vec::new();
    for (name, document) in row.get("documents").and_then(Value::as_object).into_iter().flatten() {
        let node = schema_node(document)?;
        named.push((Arc::clone(&node), name.clone()));
        documents.push((name.clone(), node));
    }
    let mut named_types: Vec<(String, String, Vec<String>)> = Vec::new();
    for (reference, answer) in row.get("namedTypes").and_then(Value::as_object).into_iter().flatten() {
        let name = text_of(answer, "name").ok_or("a `namedTypes` entry names no type")?;
        let args = answer
            .get("args")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|arg| arg.as_str().map(String::from).ok_or("a `namedTypes` argument is not type text"))
            .collect::<Result<Vec<_>, _>>()?;
        named_types.push((reference.clone(), name.into(), args));
    }
    if row.get("documents").is_none() && row.get("namedTypes").is_none() {
        return Ok((named, None));
    }
    let resolver: SchemaTypeResolver = Arc::new(move |document: &JsonSchemaDocument| {
        let JsonValue::Object(entries) = &*document.node else { return None };
        let JsonValue::String(reference) = &**entries.get("$ref")? else { return None };
        if let Some((_, name, args)) = named_types.iter().find(|(held, _, _)| held == reference) {
            return Some(SchemaTypeAnswer::Named { name: name.clone(), args: args.clone() });
        }
        documents
            .iter()
            .find(|(name, _)| name == reference)
            .map(|(_, node)| SchemaTypeAnswer::Document(JsonSchemaDocument { node: Arc::clone(node), root: None }))
    });
    Ok((named, Some(resolver)))
}

fn resolving(base: &CelEnvironment, resolver: Option<SchemaTypeResolver>) -> CelEnvironment {
    match resolver {
        Some(resolver) => base.clone_with_options(CelEnvironmentOptions {
            resolve_schema_type: Some(resolver),
            ..base.options().clone()
        }),
        None => base.clone(),
    }
}

/// A namespaced function's result declared as a schema, `{ "schema": … }`, where it is.
fn result_schema(entry: &Value) -> Option<&Value> {
    entry.get("returns").and_then(declared_schema)
}

/// The row's namespaces, each closed, in the order the row writes them, beside the result
/// schemas they hand over.
fn register_namespaces(environment: &mut CelEnvironment, row: &Value) -> Result<RowDocuments, String> {
    let mut named: RowDocuments = Vec::new();
    for (namespace, functions) in row.get("namespaces").and_then(Value::as_object).into_iter().flatten() {
        let mut declared = Vec::new();
        for entry in functions.as_array().ok_or("a namespace holds no list of functions")? {
            if let Some(signature) = text_of(entry, "signature") {
                declared.push(NamespaceFunctionDeclaration::signature(signature));
                continue;
            }
            let name = text_of(entry, "name").ok_or("a namespaced function has neither `signature` nor `name`")?;
            let returns = match (result_schema(entry), text_of(entry, "returns")) {
                (Some(schema), _) => {
                    let node = schema_node(schema)?;
                    named.push((Arc::clone(&node), format!("{namespace}.{name}")));
                    WithheldReturns::Schema(JsonSchemaDocument { node, root: None })
                }
                (None, Some(text)) => WithheldReturns::Text(text.into()),
                (None, None) => return Err(format!("the namespaced function {name:?} has no `returns`")),
            };
            declared.push(NamespaceFunctionDeclaration::withheld(name, returns));
        }
        environment
            .register_namespace(namespace, declared, NamespaceOptions::default())
            .map_err(|refusal| format!("the namespace {namespace:?} cannot be registered: {refusal}"))?;
    }
    Ok(named)
}

/// The environment a row is CHECKED in: its types, its declarations, its functions and its
/// namespaces, beside the documents it handed over.
pub fn check_environment(base: &CelEnvironment, row: &Value) -> Result<(CelEnvironment, RowDocuments), String> {
    let (mut named, resolver) = row_documents(row)?;
    let mut environment = with_types(&resolving(base, resolver), row)?;
    if let Some(declarations) = row.get("declarations").and_then(Value::as_object) {
        for (name, declaration) in declarations {
            let declared = match declared_schema(declaration) {
                Some(schema) => {
                    let node = schema_node(schema)?;
                    named.push((Arc::clone(&node), name.clone()));
                    TypeDeclaration::Schema(JsonSchemaDocument { node, root: None })
                }
                None => type_declaration(declaration)?,
            };
            environment
                .register_variable(name, declared, None)
                .map_err(|refusal| format!("the variable {name:?} cannot be declared: {refusal}"))?;
        }
    }
    register_functions(&mut environment, row)?;
    named.extend(register_namespaces(&mut environment, row)?);
    Ok((environment, named))
}

/// Whether the row types a name or a namespaced function's result from a schema, so its
/// check lists the schema nodes it read.
fn reads_schemas(row: &Value) -> bool {
    let declared = row
        .get("declarations")
        .and_then(Value::as_object)
        .is_some_and(|declarations| declarations.values().any(|declaration| declared_schema(declaration).is_some()));
    declared
        || row.get("namespaces").and_then(Value::as_object).is_some_and(|namespaces| {
            namespaces.values().filter_map(Value::as_array).flatten().any(|entry| result_schema(entry).is_some())
        })
}

/// Per listed node of a document the row varies, whether its variant agrees with it there.
fn variant_agreement(row: &Value, named: &RowDocuments, dependencies: &Value) -> Result<Value, String> {
    let variants = row.get("variants").and_then(Value::as_object).ok_or("carries no `variants`")?;
    let (_, resolver) = row_documents(row)?;
    let agreement = SchemaOwnTypeAgreement { resolve_schema_type: resolver, ..SchemaOwnTypeAgreement::default() };
    let mut out = Vec::new();
    for dependency in dependencies.as_array().into_iter().flatten() {
        let document = text_of(dependency, "document").ok_or("a dependency names no document")?;
        let pointer = text_of(dependency, "pointer").ok_or("a dependency has no pointer")?;
        let Some(variant) = variants.get(document) else { continue };
        let (original, _) = named.iter().find(|(_, name)| name == document).ok_or("a dependency names no document handed over")?;
        let agrees = schema_own_types_agree(
            &JsonSchemaDocument { node: Arc::clone(original), root: None },
            &JsonSchemaDocument { node: schema_node(variant)?, root: None },
            pointer,
            &agreement,
        );
        let mut entry = Map::new();
        entry.insert("document".into(), Value::String(document.into()));
        entry.insert("pointer".into(), Value::String(pointer.into()));
        entry.insert("agrees".into(), Value::Bool(agrees));
        out.push(Value::Object(entry));
    }
    Ok(Value::Array(out))
}

/// What one registration's conversion could not judge, and the references it re-entered.
fn recorded_report(report: &SchemaRegistrationReport) -> Value {
    let text = |held: &Option<String>| held.clone().map(Value::String);
    let unjudged = report
        .unjudged
        .iter()
        .map(|node| {
            let mut entry = Map::new();
            entry.insert("pointer".into(), Value::String(node.pointer.clone()));
            if let Some(through) = text(&node.through_reference) {
                entry.insert("throughReference".into(), through);
            }
            entry.insert("keywords".into(), Value::Array(node.keywords.iter().map(|keyword| Value::String((*keyword).into())).collect()));
            if let Some(name) = text(&node.type_name) {
                entry.insert("typeName".into(), name);
            }
            entry.insert("reason".into(), Value::String(node.reason.as_str().into()));
            Value::Object(entry)
        })
        .collect();
    let recursive = report
        .recursive
        .iter()
        .map(|node| {
            let mut entry = Map::new();
            entry.insert("pointer".into(), Value::String(node.pointer.clone()));
            if let Some(through) = text(&node.through_reference) {
                entry.insert("throughReference".into(), through);
            }
            if let Some(reference) = text(&node.reference) {
                entry.insert("reference".into(), reference);
            }
            Value::Object(entry)
        })
        .collect();
    let mut out = Map::new();
    out.insert("name".into(), Value::String(report.name.clone()));
    out.insert("unjudged".into(), Value::Array(unjudged));
    out.insert("recursive".into(), Value::Array(recursive));
    Value::Object(out)
}

fn recorded_dependencies(named: &RowDocuments, dependencies: &[SchemaDependency]) -> Result<Value, String> {
    let mut out = Vec::with_capacity(dependencies.len());
    for dependency in dependencies {
        out.push(recorded_node(named, dependency)?);
    }
    Ok(Value::Array(out))
}

fn recorded_node(named: &RowDocuments, node: &SchemaDependency) -> Result<Value, String> {
    let (_, name) = named
        .iter()
        .find(|(document, _)| Arc::ptr_eq(document, &node.document))
        .ok_or("the check named a document the row did not hand over")?;
    let mut entry = Map::new();
    entry.insert("document".into(), Value::String(name.clone()));
    entry.insert("pointer".into(), Value::String(node.pointer.clone()));
    Ok(Value::Object(entry))
}

/// Every schema node a verdict or the result names is one the same check read.
fn named_nodes_listed(dependencies: &[SchemaDependency], named: &[&SchemaDependency]) -> Result<(), String> {
    match named.iter().find(|node| !dependencies.contains(node)) {
        Some(node) => Err(format!("the check names the schema node {:?}, which it does not list as read", node.pointer)),
        None => Ok(()),
    }
}

/// Every schema a row declares a name by is one an intersection with itself leaves as it is:
/// `allOf: [S, S]`, read against S's document, converts to a type equal to S's.
fn self_intersections_equal(environment: &CelEnvironment, named: &RowDocuments, row: &Value) -> Result<(), String> {
    let declared = environment.definitions().variables;
    for name in row.get("declarations").and_then(Value::as_object).into_iter().flatten().filter_map(|(name, declaration)| declared_schema(declaration).map(|_| name)) {
        let (schema, _) = named.iter().find(|(_, held)| held == name).ok_or("a declared schema the row did not hand over")?;
        let twice = JsonValue::Object(PropertyMap::from_iter([("allOf", Arc::new(JsonValue::Array(vec![Arc::clone(schema), Arc::clone(schema)])))]));
        let mut met = environment.clone();
        met.register_variable(name, TypeDeclaration::Schema(JsonSchemaDocument { node: Arc::new(twice), root: Some(Arc::clone(schema)) }), None)
            .map_err(|refusal| format!("the variable {name:?} cannot be declared: {refusal}"))?;
        let met = met.definitions().variables.into_iter().find(|variable| &variable.name == name).ok_or("a declared name not listed")?;
        let once = declared.iter().find(|variable| &variable.name == name).ok_or("a declared name not listed")?;
        if !types_equal(&met.ty, &once.ty) {
            return Err(format!("the schema of {name:?} met with itself converts to another type"));
        }
    }
    Ok(())
}

/// The environment a row is EVALUATED in: its types and its functions, and none of its
/// declarations. A declared function is a signature with no implementation, so a call that
/// resolves to it answers `unbound_function`, naming the function and the signature it
/// resolved to.
pub fn evaluation_environment(base: &CelEnvironment, row: &Value) -> Result<CelEnvironment, String> {
    let resolver = if row.get("namespaces").is_some() { row_documents(row)?.1 } else { None };
    let mut environment = with_types(&resolving(base, resolver), row)?;
    register_functions(&mut environment, row)?;
    register_namespaces(&mut environment, row)?;
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
    // The argument types themselves are recorded by the names they print as.
    if let Some(argument_type_names) = &call.argument_type_names {
        out.insert("argumentTypeNames".into(), strings(argument_type_names));
    }
    Value::Object(out)
}

/// The row's assumptions, each condition a source the environment checking it parses.
fn assumptions_of(row: &Value) -> Vec<CheckAssumption> {
    row.get("assumptions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|assumption| CheckAssumption {
            condition: AssumedCondition::Source(text_of(assumption, "condition").unwrap_or_default().to_string()),
            holds: assumption.get("holds").and_then(Value::as_bool).unwrap_or_default(),
            rebound: assumption
                .get("rebound")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(String::from)
                .collect(),
        })
        .collect()
}

/// Why a row's `assumptions` break the format: a non-empty list of `{ condition, holds, rebound? }`.
fn assumption_problems(raw: &Map<String, Value>) -> Vec<String> {
    let Some(assumptions) = raw.get("assumptions") else { return Vec::new() };
    let Some(listed) = assumptions.as_array().filter(|listed| !listed.is_empty()) else {
        return vec!["carries `assumptions` that is not a non-empty list".into()];
    };
    listed
        .iter()
        .filter(|assumption| {
            !assumption.as_object().is_some_and(|fields| {
                unknown_keys(fields, &ASSUMPTION_KEYS).is_empty()
                    && fields.get("condition").is_some_and(Value::is_string)
                    && fields.get("holds").is_some_and(Value::is_boolean)
                    && fields
                        .get("rebound")
                        .is_none_or(|rebound| rebound.as_array().is_some_and(|chains| chains.iter().all(Value::is_string)))
            })
        })
        .map(|assumption| format!("carries an assumption that is not `{{ condition, holds, rebound? }}`: {}", json_text(assumption)))
        .collect()
}

/// The engine's whole answer for a row, as the row writes `expect`. The check half runs in
/// the check environment; the evaluation half checks first in the evaluation environment,
/// recording a refusal as the first diagnostic, and otherwise evaluates with the row's
/// bindings.
pub fn language_answer(base: &CelEnvironment, row: &Value) -> Result<Value, String> {
    let source = text_of(row, "source").ok_or("has no string `source`")?;
    let activation = activation_of(row)?;
    let asked = reads_schemas(row);
    let (environment, named) = check_environment(base, row)?;
    let checked = environment
        .check_with(source, CheckOptions { schema_dependencies: asked, schema_nodes: asked, assumptions: assumptions_of(row) })
        .map_err(|refusal| refusal.message)?;
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
            if let Some(node) = &diagnostic.schema_node {
                out.insert("schemaNode".into(), recorded_node(&named, node)?);
            }
            if diagnostic.absent {
                out.insert("absent".into(), Value::Bool(true));
            }
            Ok(Value::Object(out))
        })
        .collect::<Result<_, String>>()?;
    check.insert("diagnostics".into(), Value::Array(diagnostics));
    if checked.diagnostics.is_empty() {
        check.insert("type".into(), Value::String(checked.type_name.clone()));
    }
    check.insert("calls".into(), Value::Array(checked.calls.iter().map(recorded_call).collect()));
    if asked {
        let dependencies = checked.schema_dependencies.as_deref().ok_or("the check did not list what it read")?;
        let origins = checked.result_origins.as_deref().ok_or("the check listed no result origins")?;
        let mut nodes: Vec<&SchemaDependency> =
            checked.diagnostics.iter().filter_map(|diagnostic| diagnostic.schema_node.as_ref()).collect();
        nodes.extend(origins.iter().filter_map(|origin| origin.schema_node.as_ref()));
        named_nodes_listed(dependencies, &nodes)?;
        self_intersections_equal(&environment, &named, row)?;
        let recorded = recorded_dependencies(&named, dependencies)?;
        let mut recorded_origins = Vec::with_capacity(origins.len());
        for origin in origins {
            let mut entry = Map::new();
            entry.insert("range".into(), recorded_range(origin.range));
            entry.insert("type".into(), Value::String(origin.type_name.clone()));
            if let Some(node) = &origin.schema_node {
                entry.insert("schemaNode".into(), recorded_node(&named, node)?);
            }
            recorded_origins.push(Value::Object(entry));
        }
        check.insert("resultOrigins".into(), Value::Array(recorded_origins));
        let agreement = match row.get("variants") {
            Some(_) => Some(variant_agreement(row, &named, &recorded)?),
            None => None,
        };
        check.insert("schemaDependencies".into(), recorded);
        if let Some(agreement) = agreement {
            check.insert("variantAgreement".into(), agreement);
        }
    }
    if row.get("namedTypes").is_some() {
        check.insert("schemaReports".into(), Value::Array(environment.schema_reports().iter().map(recorded_report).collect()));
    }

    let mut answer = Map::new();
    answer.insert("check".into(), Value::Object(check));
    let environment = evaluation_environment(base, row)?;
    let expression = environment.parse(source);
    let refusal = environment
        .check_parsed_with(&expression, CheckOptions { assumptions: assumptions_of(row), ..CheckOptions::default() })
        .map_err(|refusal| refusal.message)?;
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
    if let Some(types) = raw.get("types") {
        match types.as_array().filter(|declared| !declared.is_empty()) {
            None => problems.push("carries `types` that is not a non-empty list".into()),
            Some(declared) => {
                for definition in declared {
                    let data = definition.as_object().is_some_and(|keys| {
                        unknown_keys(keys, &TYPE_KEYS).is_empty()
                            && keys.get("name").is_some_and(Value::is_string)
                            && keys.get("base").is_some_and(Value::is_string)
                    });
                    if !data {
                        problems.push(format!(
                            "declares a type that is not definition data with a `name` and a `base`: {}",
                            json_text(definition)
                        ));
                    }
                }
            }
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
    problems.extend(namespace_problems(raw));
    problems.extend(variant_problems(row, raw));
    problems.extend(named_type_problems(raw));
    problems.extend(assumption_problems(raw));
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

/// Why a row's `namespaces` break the format.
fn namespace_problems(raw: &Map<String, Value>) -> Vec<String> {
    let Some(namespaces) = raw.get("namespaces") else { return Vec::new() };
    let Some(namespaces) = namespaces.as_object().filter(|held| !held.is_empty()) else {
        return vec!["carries `namespaces` that is not a non-empty map".into()];
    };
    let mut problems = Vec::new();
    for (name, functions) in namespaces {
        let Some(functions) = functions.as_array() else {
            problems.push(format!("declares the namespace {} with no list of functions", json_text(&Value::String(name.clone()))));
            continue;
        };
        for entry in functions {
            let Some(fields) = entry.as_object() else {
                problems.push(format!(
                    "declares a namespaced function that is neither `{{ signature }}` nor `{{ name, returns }}`: {}",
                    json_text(entry)
                ));
                continue;
            };
            let whole = unknown_keys(fields, &["signature"]).is_empty() && fields.get("signature").is_some_and(Value::is_string);
            let returns = fields.get("returns");
            let withheld = unknown_keys(fields, &["name", "returns"]).is_empty()
                && fields.get("name").is_some_and(Value::is_string)
                && (returns.is_some_and(Value::is_string)
                    || returns.and_then(Value::as_object).is_some_and(|held| {
                        unknown_keys(held, &["schema"]).is_empty() && held.get("schema").is_some_and(Value::is_object)
                    }));
            if !whole && !withheld {
                problems.push(format!(
                    "declares a namespaced function that is neither `{{ signature }}` nor `{{ name, returns }}`: {}",
                    json_text(entry)
                ));
            }
        }
    }
    problems
}

/// The row's name for each document it hands over, without reading any.
fn document_names(row: &Value) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for (name, declaration) in row.get("declarations").and_then(Value::as_object).into_iter().flatten() {
        if declared_schema(declaration).is_some() {
            names.push(name.clone());
        }
    }
    for (namespace, functions) in row.get("namespaces").and_then(Value::as_object).into_iter().flatten() {
        for entry in functions.as_array().into_iter().flatten() {
            if let (Some(name), Some(_)) = (text_of(entry, "name"), result_schema(entry)) {
                names.push(format!("{namespace}.{name}"));
            }
        }
    }
    names.extend(row.get("documents").and_then(Value::as_object).into_iter().flatten().map(|(name, _)| name.clone()));
    names
}

/// Why a row's `namedTypes` break the format: each a `{ name, args? }` of type text.
fn named_type_problems(raw: &Map<String, Value>) -> Vec<String> {
    let Some(named_types) = raw.get("namedTypes") else { return Vec::new() };
    let Some(named_types) = named_types.as_object().filter(|held| !held.is_empty()) else {
        return vec!["carries `namedTypes` that is not a non-empty map".into()];
    };
    let mut problems = Vec::new();
    for (reference, named) in named_types {
        let valid = named.as_object().is_some_and(|held| {
            held.keys().all(|key| key == "name" || key == "args")
                && held.get("name").is_some_and(Value::is_string)
                && held.get("args").is_none_or(|args| args.as_array().is_some_and(|args| args.iter().all(Value::is_string)))
        });
        if !valid {
            let quoted = json_text(&Value::String(reference.clone()));
            problems.push(format!("names the type of {quoted} with a value that is not `{{ name, args? }}`"));
        }
    }
    problems
}

/// Why a row's `variants` break the format: each names a document the row hands over.
fn variant_problems(row: &Value, raw: &Map<String, Value>) -> Vec<String> {
    let Some(variants) = raw.get("variants") else { return Vec::new() };
    let Some(variants) = variants.as_object().filter(|held| !held.is_empty()) else {
        return vec!["carries `variants` that is not a non-empty map".into()];
    };
    let named = document_names(row);
    let mut problems = Vec::new();
    for (name, variant) in variants {
        let quoted = json_text(&Value::String(name.clone()));
        if !named.contains(name) {
            problems.push(format!("varies {quoted}, which names no document the row hands over"));
        } else if !variant.is_object() {
            problems.push(format!("varies {quoted} with a value that is not a schema"));
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
            Ok((environment, _)) => environment,
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
