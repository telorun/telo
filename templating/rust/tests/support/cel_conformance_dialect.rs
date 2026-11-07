//! A dialect row driven through its tag engine's own seams — the twin of
//! `templating/nodejs/tests/cel-conformance-dialect.ts`: `analyze` in the dialect
//! environment plus the row's declarations, functions and module names; then `compile` and
//! evaluation without the declarations, the row's bindings as the activation and its module
//! functions as the dispatch table.
//!
//! A module name is a namespace on the environment, declared open with what the row says
//! the host knows about each qualified function, because whether such a call reaches a
//! function at all is the analyzer's verdict and never this engine's.
//!
//! The rows are read as JSON values and the answer is built as one, so a row compares with
//! the deep equality of `serde_json`'s map, which ignores key order.
//!
//! Node items with no twin: `dispatchTracingEnvironment` and `catalogOverloads` — the
//! catalog-dispatch gate is not run here; and `AsyncLocalStorage` — a row is evaluated on
//! one thread, and the handler refusals it meets are kept per thread.

#![allow(dead_code)]

use std::cell::RefCell;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};
use telo_templating::{
    AnalyzeEnv, CallError, CelEngine, CelHandlers, CompileEnv, CompileOutcome, InterpolateEngine, ModuleCallDispatch,
    ModuleCallFlagValues, ModuleFunction, SqlEngine, TemplatingEngine,
};
use telorun_cel::{
    CatalogRefusal, CelCallContext, CelEnvironment, FieldDeclaration, FunctionMetadata, NamespaceFunctionDeclaration,
    NamespaceOptions, PropertyMap, TypeDeclaration,
};
use telorun_cel_value::{cel_error, CelEvaluationCode, CelValue};

use super::cel_conformance_value::{decode, encode, typed_frame_text};

/// The tags a dialect row may name.
pub const DIALECT_TAGS: [&str; 3] = ["cel", "interpolate", "sql"];

thread_local! {
    /// The typed frame's refusals of handler arguments, kept by the row evaluation they
    /// happened in.
    static HANDLER_REFUSALS: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}

fn frame_args(name: &str, args: &[CelValue]) -> Result<String, CatalogRefusal> {
    let mut texts = Vec::with_capacity(args.len());
    for arg in args {
        match typed_frame_text(arg) {
            Ok(text) => texts.push(text),
            Err(message) => {
                HANDLER_REFUSALS.with(|refusals| {
                    refusals.borrow_mut().push(format!(
                        "the handler '{name}' was handed a value the typed frame cannot write ({message})"
                    ))
                });
                return Err(CatalogRefusal::new(message));
            }
        }
    }
    Ok(format!("{name}({})", texts.join(", ")))
}

fn text(value: &str) -> CelValue {
    CelValue::String(value.into())
}

/// The conformance handler set: each answers its own name and the typed-frame text of every
/// argument it was handed, and is defined only over values the typed frame writes.
pub fn conformance_handlers() -> CelHandlers {
    let one = |name: &'static str| -> Option<Arc<dyn Fn(&str) -> Result<String, CatalogRefusal> + Send + Sync>> {
        Some(Arc::new(move |value: &str| frame_args(name, &[text(value)])))
    };
    CelHandlers {
        sha256: one("sha256"),
        md5: one("md5"),
        sha1: one("sha1"),
        sha512: one("sha512"),
        hmac: Some(Arc::new(|algorithm: &str, key: &str, message: &str| {
            frame_args("hmac", &[text(algorithm), text(key), text(message)])
        })),
        base64_encode: one("base64Encode"),
        base64_decode: one("base64Decode"),
        json: Some(Arc::new(|value: &CelValue| frame_args("json", std::slice::from_ref(value)))),
        join_path: Some(Arc::new(|base: &str, relative: &str| frame_args("joinPath", &[text(base), text(relative)]))),
    }
}

/// The engine driving a tag — the one place a dialect tag is tied to an engine.
fn engine_of(tag: &str) -> &'static dyn TemplatingEngine {
    match tag {
        "cel" => &CelEngine,
        "interpolate" => &InterpolateEngine,
        "sql" => &SqlEngine,
        other => panic!("No dialect engine drives the tag '{other}'"),
    }
}

fn declaration_of(declaration: &Value) -> TypeDeclaration {
    match declaration {
        Value::String(text) => TypeDeclaration::Text(text.clone()),
        Value::Object(object) => TypeDeclaration::Fields(fields_of(object)),
        other => panic!("a declaration is a type or a field map, not {other}"),
    }
}

fn fields_of(object: &Map<String, Value>) -> PropertyMap<FieldDeclaration> {
    let Some(Value::Object(fields)) = object.get("fields") else { panic!("a record declaration carries its fields") };
    fields
        .iter()
        .map(|(name, held)| {
            let field = match held {
                Value::String(text) => FieldDeclaration::Type(text.clone()),
                Value::Object(nested) => FieldDeclaration::Fields(fields_of(nested)),
                other => panic!("a field is a type or a field map, not {other}"),
            };
            (name.as_str(), field)
        })
        .collect()
}

#[allow(unused_variables)]
fn with_functions(env: &CelEnvironment, row: &Value) -> CelEnvironment {
    let mut cloned = env.clone();
    for function in row.get("functions").and_then(Value::as_array).into_iter().flatten() {
        let signature = function["signature"].as_str().expect("a function names its signature");
        let answer: Result<CelValue, String> = match function.get("error").and_then(Value::as_str) {
            Some(message) => Err(message.into()),
            None => Ok(decode(&function["result"]).unwrap_or_else(|refusal| panic!("{signature}: {refusal}"))),
        };
        let implementation = Arc::new(move |context: &CelCallContext, args: &[CelValue]| {
            match &answer {
                Ok(value) => value.clone(),
                Err(message) => cel_error(CelEvaluationCode::InvalidArgument, message.clone(), context.range).into(),
            }
        });
        cloned
            .register_function(signature, FunctionMetadata { implementation: Some(implementation), ..FunctionMetadata::default() })
            .unwrap_or_else(|refusal| panic!("{signature}: {refusal}"));
    }
    cloned
}

/// A row's module names as open namespaces, carrying the result type and flags of every
/// qualified function the row says the host knows.
fn with_module_names(mut env: CelEnvironment, modules: Option<&Value>) -> CelEnvironment {
    let Some(modules) = modules else { return env };
    let functions = modules.get("functions").and_then(Value::as_object);
    for name in modules["names"].as_array().expect("a row's modules name some").iter().filter_map(Value::as_str) {
        let prefix = format!("{name}.");
        let declared = functions
            .into_iter()
            .flatten()
            .filter_map(|(qualified, function)| {
                let member = qualified.strip_prefix(&prefix)?;
                let mut declaration =
                    NamespaceFunctionDeclaration::withheld(member, function["returns"].as_str().expect("returns"));
                declaration.deterministic = function["deterministic"].as_bool().expect("deterministic");
                declaration.host_backed = function["hostBacked"].as_bool().expect("hostBacked");
                Some(declaration)
            })
            .collect();
        env.register_namespace(name, declared, NamespaceOptions { open: true })
            .unwrap_or_else(|refusal| panic!("{name}: {refusal}"));
    }
    env
}

fn static_environment(env: &CelEnvironment, row: &Value) -> CelEnvironment {
    let mut cloned = env.clone();
    for (name, declaration) in row.get("declarations").and_then(Value::as_object).into_iter().flatten() {
        cloned
            .register_variable(name, declaration_of(declaration), None)
            .unwrap_or_else(|refusal| panic!("{name}: {refusal}"));
    }
    with_module_names(with_functions(&cloned, row), row.get("modules"))
}

fn module_names_of(row: &Value) -> Option<HashSet<String>> {
    row.get("modules").map(|modules| {
        modules["names"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect()
    })
}

fn module_function<'r>(row: &'r Value, qualified: &str) -> Option<&'r Value> {
    row.get("modules")?.get("functions")?.get(qualified)
}

/// The static half: what the tag engine's `analyze` answers, plus the regions it reports.
pub fn analyze_dialect_row(env: &CelEnvironment, row: &Value) -> Map<String, Value> {
    let engine = engine_of(row["tag"].as_str().expect("a row names its tag"));
    let source = row["source"].as_str().expect("a row holds its source");
    let site = static_environment(env, row);
    let module_names = module_names_of(row);
    let could_name: Option<Vec<String>> = row.get("couldNameModule").map(|names| {
        names.as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect()
    });
    let result_schema = |qualified: &str| module_function(row, qualified)?.get("resultSchema").cloned();
    let flags = |qualified: &str| {
        module_function(row, qualified).map(|function| ModuleCallFlagValues {
            deterministic: function["deterministic"].as_bool().expect("deterministic"),
            host_backed: function["hostBacked"].as_bool().expect("hostBacked"),
        })
    };
    let could_name_module = |name: &str| could_name.as_ref().is_some_and(|names| names.iter().any(|held| held == name));
    let has_modules = module_names.is_some();
    let analysis = AnalyzeEnv {
        cel_env: &site,
        context_schema: row.get("context"),
        roots_declared: row.get("rootsDeclared") == Some(&Value::Bool(true)),
        module_names: module_names.as_ref(),
        module_call_result: has_modules.then_some(&result_schema as &dyn Fn(&str) -> Option<Value>),
        module_call_flags: has_modules.then_some(&flags as &dyn Fn(&str) -> Option<ModuleCallFlagValues>),
        could_name_module: could_name.is_some().then_some(&could_name_module as &dyn Fn(&str) -> bool),
    };
    let result = engine.analyze(source, &analysis);
    let mut check = Map::new();
    check.insert(
        "diagnostics".into(),
        result
            .diagnostics
            .iter()
            .map(|diagnostic| {
                let mut out = Map::new();
                out.insert("code".into(), diagnostic.code.clone().map_or(Value::Null, Value::String));
                out.insert("message".into(), Value::String(diagnostic.message.clone()));
                if let Some(fix) = &diagnostic.fix {
                    out.insert("fix".into(), json!({ "replacement": fix.replacement }));
                }
                Value::Object(out)
            })
            .collect(),
    );
    if let Some(type_name) = &result.type_name {
        check.insert("type".into(), Value::String(type_name.clone()));
    }
    check.insert(
        "calls".into(),
        result
            .calls
            .iter()
            .map(|call| {
                let mut out = Map::new();
                out.insert("name".into(), Value::String(call.name.clone()));
                out.insert("form".into(), Value::String(call.form.as_str().into()));
                if call.module_call {
                    out.insert("moduleCall".into(), Value::Bool(true));
                }
                out.insert("arity".into(), json!(call.arity));
                if let Some(arguments) = &call.arguments {
                    let arguments: Vec<Value> = arguments
                        .iter()
                        .map(|argument| {
                            let mut held = Map::new();
                            if let Some(type_name) = &argument.type_name {
                                held.insert("type".into(), Value::String(type_name.clone()));
                            }
                            if let Some(chain) = &argument.chain {
                                held.insert("chain".into(), json!(chain));
                            }
                            Value::Object(held)
                        })
                        .collect();
                    out.insert("arguments".into(), Value::Array(arguments));
                }
                out.insert("start".into(), json!(call.start));
                out.insert("end".into(), json!(call.end));
                if let Some(deterministic) = call.deterministic {
                    out.insert("deterministic".into(), Value::Bool(deterministic));
                }
                if let Some(host_backed) = call.host_backed {
                    out.insert("hostBacked".into(), Value::Bool(host_backed));
                }
                Value::Object(out)
            })
            .collect(),
    );
    if let Some(literal) = &result.string_literal {
        check.insert("stringLiteral".into(), Value::String(literal.clone()));
    }
    if let Some(read_types) = &result.read_types {
        check.insert("readTypes".into(), json!(read_types));
    }
    check.insert(
        "regions".into(),
        engine
            .expression_regions(source)
            .iter()
            .map(|region| json!({ "start": region.start, "end": region.end }))
            .collect(),
    );
    check
}

/// A module function's scripted failure, or the codec's refusal inside one.
#[derive(Debug)]
pub struct RowFailure {
    pub code: Option<String>,
    pub message: String,
}

/// An error as a row records it: a Telo code where one names it, else `null`.
fn conformance_error(code: Option<&str>, message: &str) -> Value {
    let code = code.filter(|code| {
        code.strip_prefix("ERR_").is_some_and(|rest| {
            !rest.is_empty() && rest.bytes().all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        })
    });
    json!({ "code": code, "message": message })
}

/// The row's module functions as the dispatch table, each recording the call it was handed
/// before it answers as scripted.
fn dispatch_table_of(modules: &Value, dispatched: &Arc<Mutex<Vec<Value>>>) -> ModuleCallDispatch<RowFailure> {
    modules
        .get("functions")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .map(|(qualified, function)| {
            let name = qualified.clone();
            let function = function.clone();
            let record = Arc::clone(dispatched);
            let bound: ModuleFunction<RowFailure> = Arc::new(move |args: &[CelValue]| {
                let mut written = Vec::with_capacity(args.len());
                for arg in args {
                    written.push(encode(arg).map_err(|message| RowFailure { code: None, message })?);
                }
                record.lock().unwrap().push(json!({ "name": name, "arguments": written }));
                if let Some(error) = function.get("error") {
                    return Err(RowFailure {
                        code: error["code"].as_str().map(str::to_owned),
                        message: error["message"].as_str().expect("a scripted error has a message").into(),
                    });
                }
                let result = function
                    .get("result")
                    .unwrap_or_else(|| panic!("The module function '{name}' scripts neither a result nor an error"));
                decode(result).map_err(|message| RowFailure { code: None, message })
            });
            (qualified.clone(), bound)
        })
        .collect()
}

/// What evaluating a row answered.
pub struct Evaluation {
    /// `refs`, sorted, and `volatile` — absent where compiling failed.
    pub compiled: Option<(Vec<String>, bool)>,
    pub dispatched: Option<Vec<Value>>,
    pub outcome: Result<CelValue, Value>,
}

/// The runtime half: `compile` without declarations, then evaluation with the bindings as
/// the activation and the row's module functions as the dispatch table. A row whose
/// evaluation hands a handler a value the typed frame refuses is malformed: `Err`.
pub fn evaluate_dialect_row(env: &CelEnvironment, row: &Value) -> Result<Evaluation, String> {
    let id = row["id"].as_str().unwrap_or("?");
    let engine = engine_of(row["tag"].as_str().expect("a row names its tag"));
    let source = row["source"].as_str().expect("a row holds its source");
    let modules = row.get("modules");
    let dispatched: Arc<Mutex<Vec<Value>>> = Arc::default();
    let module_names = module_names_of(row);
    let compile_env = with_functions(env, row);
    let compiled = match engine.compile(source, &CompileEnv { cel_env: &compile_env, module_names: module_names.as_ref() }) {
        Ok(CompileOutcome::Compiled(compiled)) => compiled,
        Ok(other) => panic!("the '{}' engine compiled to {other:?}, not a compiled value", engine.name()),
        Err(error) => {
            return Ok(Evaluation {
                compiled: None,
                dispatched: modules.map(|_| Vec::new()),
                outcome: Err(conformance_error(error.code.as_deref(), &error.message)),
            });
        }
    };
    let mut refs = compiled.refs().to_vec();
    refs.sort();
    let activation: PropertyMap<CelValue> = row
        .get("bindings")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .map(|(name, value)| (name.as_str(), decode(value).unwrap_or_else(|refusal| panic!("{id}: {name}: {refusal}"))))
        .collect();
    let table = modules.map(|modules| dispatch_table_of(modules, &dispatched));
    HANDLER_REFUSALS.with(|refusals| refusals.borrow_mut().clear());
    let answered = compiled.call(&activation, table.as_ref());
    let refusals = HANDLER_REFUSALS.with(|refusals| std::mem::take(&mut *refusals.borrow_mut()));
    // Read off the handler, not off what evaluation answered: an operator may absorb it.
    if let Some(refusal) = refusals.first() {
        return Err(format!("The row '{id}' is malformed: {refusal}"));
    }
    let outcome = answered.map_err(|error| match error {
        CallError::Templating(error) => conformance_error(error.code.as_deref(), &error.message),
        CallError::Module(failure) => conformance_error(failure.code.as_deref(), &failure.message),
    });
    let dispatched = modules.map(|_| std::mem::take(&mut *dispatched.lock().unwrap()));
    Ok(Evaluation { compiled: Some((refs, compiled.volatile())), dispatched, outcome })
}

/// What a row answers, in the shape of its `expect`.
pub fn run_dialect_row(env: &CelEnvironment, row: &Value) -> Result<Value, String> {
    let mut check = analyze_dialect_row(env, row);
    let evaluation = evaluate_dialect_row(env, row)?;
    if let Some((refs, volatile)) = evaluation.compiled {
        check.insert("refs".into(), json!(refs));
        check.insert("volatile".into(), Value::Bool(volatile));
    }
    let mut answer = Map::new();
    answer.insert("check".into(), Value::Object(check));
    if let Some(dispatched) = evaluation.dispatched {
        answer.insert("dispatched".into(), Value::Array(dispatched));
    }
    match evaluation.outcome {
        Ok(value) => {
            answer.insert("value".into(), encode(&value)?);
        }
        Err(error) => {
            answer.insert("error".into(), error);
        }
    }
    Ok(Value::Object(answer))
}
