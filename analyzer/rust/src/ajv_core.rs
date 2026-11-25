//! An AJV instance: a twin of ajv 8.20.0's `Ajv` class (`core.js`, `ajv.js`) and the
//! schema registry and reference resolution of `compile/index.js` and
//! `compile/resolve.js` — `addSchema`, `compile`, `getSchema`, the draft-07 meta-schema
//! check every schema is held to before it compiles (`validateSchema`, phrased by
//! `errorsText`), `SchemaEnv`, `resolveRef` / `resolveSchema` / `getJsonPointer`,
//! `getSchemaRefs`' discovery of `$id`s and anchors, and `inlineRef`.
//!
//! The draft-07 meta-schema is data, copied from the pinned package
//! (`ajv/dist/refs/json-schema-draft-07.json`) into `ajv_refs/`. As AJV compiles it, its
//! options leave defaults, member removal and formats out.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use telorun_cel::{read_json_text, JsonValue};

use crate::ajv_formats::ajv_format;
use crate::ajv_keywords::{function_code, get, js_of, schema_has_rules_but_ref, truthy, It};
use crate::ajv_runtime::{Body, Flags, Function, Node, Runner, SchemaError};
use crate::ajv_uri_resolver as uri;
use crate::schema_opaque_value::{inherited_member, JsValue};
use crate::schema_pattern::schema_regex_format;
use crate::telo_format::{format_failure, is_telo_format};

pub(crate) const DRAFT_07_ID: &str = "http://json-schema.org/draft-07/schema";
const DRAFT_07_TEXT: &str = include_str!("ajv_refs/json-schema-draft-07.json");

/// The draft-07 meta-schema, read once.
pub(crate) fn draft_07() -> Arc<JsonValue> {
    static META: OnceLock<Arc<JsonValue>> = OnceLock::new();
    META.get_or_init(|| read_json_text(DRAFT_07_TEXT).expect("the draft-07 meta-schema is JSON")).clone()
}

/// The options an instance compiles with.
#[derive(Clone, Debug)]
pub(crate) struct AjvOptions {
    pub all_errors: bool,
    pub verbose: bool,
    pub use_defaults: bool,
    pub remove_additional: bool,
    pub validate_formats: bool,
    /// Assert a `live` value type as an instance (static analysis).
    pub assert_live: bool,
    /// Telo's keywords and formats and `ajv-formats` are registered; without them the
    /// instance is the pattern meta-check's, knowing only its own formats.
    pub telo: bool,
}

/// A format the instance knows.
pub(crate) enum FormatDef {
    Any,
    Text(Box<dyn Fn(&str) -> bool + Send + Sync>),
    Number(fn(f64) -> bool),
}

/// What a root's reference cache holds: a schema to inline, or a compiled environment.
#[derive(Clone)]
pub(crate) enum RootRef {
    Schema(Arc<JsonValue>),
    Env(usize),
}

/// AJV's `this.refs` entry.
#[derive(Clone)]
enum Registered {
    Env(usize),
    Alias(String),
}

/// `SchemaEnv`.
struct Env {
    schema: Arc<JsonValue>,
    root: usize,
    base_id: String,
    local_refs: HashMap<String, Arc<JsonValue>>,
    refs: HashMap<String, RootRef>,
    meta: bool,
    validate: Option<usize>,
}

/// A compiled schema: its functions and the one it starts in.
#[derive(Clone)]
pub struct Validator {
    functions: Arc<Vec<Arc<Function>>>,
    root: usize,
    verbose: bool,
}

impl Validator {
    /// Validate `data` in place — defaults filled and members removed as the
    /// configuration says — answering the errors recorded, none when valid, or the
    /// `RangeError` message AJV's code throws when a schema nests without end.
    pub fn validate(&self, data: &mut JsValue) -> Result<Vec<SchemaError>, String> {
        let runner = Runner { functions: &self.functions, verbose: self.verbose };
        runner.call(self.root, data, "").map_err(str::to_string)
    }
}

pub struct Ajv {
    opts: AjvOptions,
    meta_opts: AjvOptions,
    in_meta: bool,
    envs: Vec<Env>,
    schemas: HashMap<String, usize>,
    refs: HashMap<String, Registered>,
    cache: Vec<(Arc<JsonValue>, usize)>,
    compilations: Vec<usize>,
    functions: Vec<Arc<Function>>,
    /// The schema id the last compile could not resolve — a `MissingRefError`'s
    /// `missingSchema`.
    missing_schema: Option<String>,
}

/// `normalizeId`: a trailing `#` or `#/` dropped.
pub(crate) fn normalize_id(id: &str) -> String {
    id.strip_suffix("#/").or_else(|| id.strip_suffix('#')).unwrap_or(id).to_string()
}

/// `normalizeId` of a schema's `$id` value, as JavaScript calls `.replace` on it.
fn normalize_id_value(id: Option<&Arc<JsonValue>>, fallback: &str) -> Result<String, String> {
    match id.map(|id| &**id) {
        Some(JsonValue::String(text)) if !text.is_empty() => Ok(normalize_id(text)),
        Some(other) if truthy(other) => Err("id.replace is not a function".into()),
        _ => Ok(normalize_id(fallback)),
    }
}

/// `_getFullPath`: a parsed reference without its fragment, then `#`.
fn full_path_of(parsed: &uri::Components) -> Result<String, String> {
    let serialized = uri::serialize(parsed)?;
    Ok(format!("{}#", serialized.split('#').next().unwrap_or("")))
}

/// `getFullPath`.
fn full_path(id: &str, normalize: bool) -> Result<String, String> {
    let id = if normalize { normalize_id(id) } else { id.to_string() };
    full_path_of(&uri::parse(&id))
}

/// `unescapeFragment`: `decodeURIComponent`, then a JSON Pointer token unescaped.
fn unescape_fragment(text: &str) -> Result<String, String> {
    let mut bytes = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '%' {
            bytes.clear();
            while i < chars.len() && chars[i] == '%' {
                let hex: String = chars.get(i + 1..i + 3).map(|h| h.iter().collect()).unwrap_or_default();
                let byte = u8::from_str_radix(&hex, 16).map_err(|_| "URI malformed".to_string())?;
                if hex.len() != 2 {
                    return Err("URI malformed".into());
                }
                bytes.push(byte);
                i += 3;
                if bytes.iter().all(|b| b.is_ascii()) {
                    break;
                }
                if let Ok(text) = std::str::from_utf8(&bytes) {
                    out.push_str(text);
                    bytes.clear();
                    break;
                }
            }
            if !bytes.is_empty() {
                let text = std::str::from_utf8(&bytes).map_err(|_| "URI malformed".to_string())?;
                out.push_str(text);
            }
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    Ok(out.replace("~1", "/").replace("~0", "~"))
}

/// Whether `inlineRef` inlines a referenced schema: one holding no reference keyword.
fn inline_ref(schema: &JsonValue) -> bool {
    fn has_ref(schema: &JsonValue) -> bool {
        let JsonValue::Object(map) = schema else { return false };
        map.iter().any(|(key, child)| {
            matches!(key, "$ref" | "$recursiveRef" | "$recursiveAnchor" | "$dynamicRef" | "$dynamicAnchor")
                || match &**child {
                    JsonValue::Array(items) => items.iter().any(|item| has_ref(item)),
                    other => has_ref(other),
                }
        })
    }
    matches!(schema, JsonValue::Bool(_)) || !has_ref(schema)
}

/// `json-schema-traverse` 1.0.0's keyword sets, read with `in` as it reads them.
fn in_set(key: &str, set: &[&str]) -> bool {
    set.contains(&key) || inherited_member(key).is_some()
}

const TRAVERSE_KEYWORDS: [&str; 9] = ["additionalItems", "items", "contains", "additionalProperties", "propertyNames", "not", "if", "then", "else"];
const TRAVERSE_ARRAYS: [&str; 4] = ["items", "allOf", "anyOf", "oneOf"];
const TRAVERSE_PROPS: [&str; 5] = ["$defs", "definitions", "properties", "patternProperties", "dependencies"];
const TRAVERSE_SKIP: [&str; 18] = [
    "default", "enum", "const", "required", "maximum", "minimum", "exclusiveMaximum", "exclusiveMinimum", "multipleOf",
    "maxLength", "minLength", "pattern", "format", "maxItems", "minItems", "uniqueItems", "maxProperties", "minProperties",
];

fn escape_pointer(token: &str) -> String {
    token.replace('~', "~0").replace('/', "~1")
}

/// `traverse(schema, { allKeys: true }, pre)`: every schema object in visiting order,
/// with its JSON Pointer and its parent's.
fn traverse(schema: &Arc<JsonValue>, pointer: String, parent: Option<String>, out: &mut Vec<(Arc<JsonValue>, String, Option<String>)>) {
    let JsonValue::Object(map) = &**schema else { return };
    out.push((schema.clone(), pointer.clone(), parent));
    for (key, child) in map.iter() {
        match &**child {
            JsonValue::Array(items) => {
                if in_set(key, &TRAVERSE_ARRAYS) {
                    for (i, item) in items.iter().enumerate() {
                        traverse(item, format!("{pointer}/{key}/{i}"), Some(pointer.clone()), out);
                    }
                }
            }
            _ if in_set(key, &TRAVERSE_PROPS) => {
                if let JsonValue::Object(props) = &**child {
                    for (prop, item) in props.iter() {
                        traverse(item, format!("{pointer}/{key}/{}", escape_pointer(prop)), Some(pointer.clone()), out);
                    }
                }
            }
            _ if in_set(key, &TRAVERSE_KEYWORDS) || !in_set(key, &TRAVERSE_SKIP) => {
                traverse(child, format!("{pointer}/{key}"), Some(pointer.clone()), out);
            }
            _ => {}
        }
    }
}

fn is_anchor(anchor: &str) -> bool {
    let mut chars = anchor.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_'))
}

impl Ajv {
    pub(crate) fn new(opts: AjvOptions) -> Self {
        let meta_opts = AjvOptions { use_defaults: false, remove_additional: false, validate_formats: false, ..opts.clone() };
        let mut ajv = Ajv {
            opts,
            meta_opts,
            in_meta: false,
            envs: Vec::new(),
            schemas: HashMap::new(),
            refs: HashMap::new(),
            cache: Vec::new(),
            compilations: Vec::new(),
            functions: Vec::new(),
            missing_schema: None,
        };
        ajv.add_schema_with(draft_07(), Some(DRAFT_07_ID), true, false).expect("the draft-07 meta-schema registers");
        ajv.refs.insert("http://json-schema.org/schema".into(), Registered::Alias(DRAFT_07_ID.into()));
        ajv
    }

    pub(crate) fn current_options(&self) -> &AjvOptions {
        if self.in_meta {
            &self.meta_opts
        } else {
            &self.opts
        }
    }

    pub(crate) fn format(&self, name: &str) -> Option<FormatDef> {
        if !self.current_options().telo {
            return match name {
                "uri" | "uri-reference" | "iri" | "iri-reference" | "json-pointer" | "relative-json-pointer" => Some(FormatDef::Any),
                "regex" => Some(FormatDef::Text(Box::new(schema_regex_format))),
                _ => None,
            };
        }
        if is_telo_format(name) {
            let name = name.to_string();
            return Some(FormatDef::Text(Box::new(move |value| format_failure(&name, value).is_none())));
        }
        if name == "regex" {
            return Some(FormatDef::Text(Box::new(schema_regex_format)));
        }
        Some(match ajv_format(name)? {
            crate::ajv_formats::AjvFormat::Any => FormatDef::Any,
            crate::ajv_formats::AjvFormat::Text(check) => FormatDef::Text(Box::new(check)),
            crate::ajv_formats::AjvFormat::Number(check) => FormatDef::Number(check),
        })
    }

    pub(crate) fn env_root(&self, env: usize) -> usize {
        self.envs[env].root
    }

    pub(crate) fn env_base_id(&self, env: usize) -> String {
        self.envs[env].base_id.clone()
    }

    /// `resolveUrl`.
    pub(crate) fn resolve_url(&self, base: &str, id: &str) -> Result<String, String> {
        uri::resolve(base, &normalize_id(id))
    }

    fn check_unique(&self, id: &str) -> Result<(), String> {
        if self.schemas.contains_key(id) || self.refs.contains_key(id) {
            return Err(format!("schema with key or id \"{id}\" already exists"));
        }
        Ok(())
    }

    /// `addSchema(schema, key)`.
    pub(crate) fn add_schema(&mut self, schema: Arc<JsonValue>, key: Option<&str>, validate_schema: bool) -> Result<(), String> {
        self.add_schema_with(schema, key, false, validate_schema)
    }

    fn add_schema_with(&mut self, schema: Arc<JsonValue>, key: Option<&str>, meta: bool, validate_schema: bool) -> Result<(), String> {
        let id = get(&schema, "$id").cloned();
        if let Some(id) = &id {
            if !matches!(&**id, JsonValue::String(_)) {
                return Err("schema $id must be string".into());
            }
        }
        let key = match key.filter(|k| !k.is_empty()) {
            Some(key) => normalize_id(key),
            None => normalize_id_value(id.as_ref(), "")?,
        };
        self.check_unique(&key)?;
        let env = self.add_env(schema, meta, &key, validate_schema, true)?;
        self.schemas.insert(key, env);
        Ok(())
    }

    /// `_addSchema`.
    fn add_env(&mut self, schema: Arc<JsonValue>, meta: bool, base_id: &str, validate_schema: bool, add: bool) -> Result<usize, String> {
        if !matches!(&*schema, JsonValue::Object(_) | JsonValue::Bool(_)) {
            return Err("schema must be object or boolean".into());
        }
        if let Some((_, env)) = self.cache.iter().find(|(held, _)| Arc::ptr_eq(held, &schema)) {
            return Ok(*env);
        }
        let base_id = normalize_id_value(get(&schema, "$id"), base_id)?;
        let local_refs = self.schema_refs(&schema, &base_id)?;
        let env = self.envs.len();
        self.envs.push(Env { schema: schema.clone(), root: env, base_id: base_id.clone(), local_refs, refs: HashMap::new(), meta, validate: None });
        self.cache.push((schema.clone(), env));
        if add && !base_id.starts_with('#') {
            if !base_id.is_empty() {
                self.check_unique(&base_id)?;
            }
            self.refs.insert(base_id, Registered::Env(env));
        }
        if validate_schema {
            self.validate_schema(&schema)?;
        }
        Ok(env)
    }

    /// `getSchemaRefs`: the anchors and plain-name ids a schema declares, registering
    /// every absolute id it declares as an alias of where it sits.
    fn schema_refs(&mut self, schema: &Arc<JsonValue>, base_id: &str) -> Result<HashMap<String, Arc<JsonValue>>, String> {
        let mut local: HashMap<String, Arc<JsonValue>> = HashMap::new();
        if matches!(&**schema, JsonValue::Bool(_)) {
            return Ok(local);
        }
        let schema_id = normalize_id_value(get(schema, "$id"), base_id)?;
        let prefix = full_path(&schema_id, false)?;
        let mut base_ids: HashMap<String, String> = HashMap::from([(String::new(), schema_id)]);
        let mut seen: Vec<String> = Vec::new();
        let mut visited = Vec::new();
        traverse(schema, String::new(), None, &mut visited);
        for (node, pointer, parent) in visited {
            let Some(parent) = parent else { continue };
            let full = format!("{prefix}{pointer}");
            let mut inner = base_ids.get(&parent).cloned().unwrap_or_default();
            let mut add_ref = |this: &mut Ajv, reference: &str, inner: &str| -> Result<String, String> {
                let resolved = if inner.is_empty() { reference.to_string() } else { uri::resolve(inner, reference)? };
                let reference = normalize_id(&resolved);
                if seen.contains(&reference) {
                    return Err(format!("reference \"{reference}\" resolves to more than one schema"));
                }
                seen.push(reference.clone());
                let mut registered = this.refs.get(&reference).cloned();
                if let Some(Registered::Alias(alias)) = &registered {
                    registered = this.refs.get(alias).cloned();
                }
                if let Some(Registered::Env(env)) = registered {
                    if this.envs[env].schema != node {
                        return Err(format!("reference \"{reference}\" resolves to more than one schema"));
                    }
                } else if reference != normalize_id(&full) {
                    if reference.starts_with('#') {
                        if local.get(&reference).is_some_and(|held| **held != *node) {
                            return Err(format!("reference \"{reference}\" resolves to more than one schema"));
                        }
                        local.insert(reference.clone(), node.clone());
                    } else {
                        this.refs.insert(reference.clone(), Registered::Alias(full.clone()));
                    }
                }
                Ok(reference)
            };
            if let Some(JsonValue::String(id)) = get(&node, "$id").map(|id| &**id) {
                inner = add_ref(self, id, &inner)?;
            }
            for anchor_key in ["$anchor", "$dynamicAnchor"] {
                if let Some(JsonValue::String(anchor)) = get(&node, anchor_key).map(|a| &**a) {
                    if !is_anchor(anchor) {
                        return Err(format!("invalid anchor \"{anchor}\""));
                    }
                    add_ref(self, &format!("#{anchor}"), &inner)?;
                }
            }
            base_ids.insert(pointer, inner);
        }
        Ok(local)
    }

    /// `errorsText`.
    pub fn errors_text(errors: &[SchemaError]) -> String {
        if errors.is_empty() {
            return "No errors".into();
        }
        errors.iter().map(|e| format!("data{} {}", e.instance_path, e.message)).collect::<Vec<_>>().join(", ")
    }

    /// `validateSchema(schema, true)`: the schema held to its meta-schema.
    fn validate_schema(&mut self, schema: &Arc<JsonValue>) -> Result<(), String> {
        if matches!(&**schema, JsonValue::Bool(_)) {
            return Ok(());
        }
        let meta = match get(schema, "$schema").map(|m| &**m) {
            None => DRAFT_07_ID.to_string(),
            Some(JsonValue::String(meta)) if !meta.is_empty() => meta.clone(),
            Some(JsonValue::String(_)) => DRAFT_07_ID.to_string(),
            Some(_) => return Err("$schema must be a string".into()),
        };
        let Some(validator) = self.get_schema(&meta)? else {
            return Err(format!("no schema with key or ref \"{meta}\""));
        };
        let errors = validator.validate(&mut js_of(schema))?;
        if !errors.is_empty() {
            return Err(format!("schema is invalid: {}", Ajv::errors_text(&errors)));
        }
        Ok(())
    }

    /// Record the reference a compile cannot resolve, as `MissingRefError` names it:
    /// `normalizeId(getFullPath(resolveUrl(baseId, ref)))`.
    pub(crate) fn note_missing_ref(&mut self, base_id: &str, reference: &str) {
        self.missing_schema = self.resolve_url(base_id, reference).and_then(|absolute| full_path(&absolute, true)).ok().map(|path| normalize_id(&path));
    }

    /// The schema id the last failed compile could not resolve, taken.
    pub(crate) fn take_missing_schema(&mut self) -> Option<String> {
        self.missing_schema.take()
    }

    /// `schemas[id] ?? refs[id]`, aliases followed: the environment a key names.
    fn registered_env(&self, id: &str) -> Option<usize> {
        let mut key = id.to_string();
        for _ in 0..=self.refs.len() {
            if let Some(env) = self.schemas.get(&key) {
                return Some(*env);
            }
            match self.refs.get(&key)? {
                Registered::Env(env) => return Some(*env),
                Registered::Alias(next) => key = next.clone(),
            }
        }
        None
    }

    /// The document `id` is registered as, read and never compiled — `registeredDocument`.
    pub(crate) fn registered_document(&self, id: &str) -> Option<Arc<JsonValue>> {
        let env = self.registered_env(id)?;
        let schema = &self.envs[env].schema;
        matches!(&**schema, JsonValue::Object(_) | JsonValue::Array(_)).then(|| schema.clone())
    }

    /// The `baseId` of the environment a key names directly, `None` for an alias or none.
    pub(crate) fn registered_base_id(&self, key: &str) -> Option<String> {
        let env = match self.schemas.get(key) {
            Some(env) => *env,
            None => match self.refs.get(key)? {
                Registered::Env(env) => *env,
                Registered::Alias(_) => return None,
            },
        };
        Some(self.envs[env].base_id.clone())
    }

    /// Every document registered by key or id, in key order: the schemas table, then the
    /// refs table's environments.
    pub(crate) fn registered_documents(&self) -> Vec<(String, Arc<JsonValue>)> {
        let mut schemas: Vec<(String, Arc<JsonValue>)> = self.schemas.iter().map(|(k, e)| (k.clone(), self.envs[*e].schema.clone())).collect();
        schemas.sort_by(|a, b| a.0.cmp(&b.0));
        let mut refs: Vec<(String, Arc<JsonValue>)> = self
            .refs
            .iter()
            .filter_map(|(k, r)| match r {
                Registered::Env(e) => Some((k.clone(), self.envs[*e].schema.clone())),
                Registered::Alias(_) => None,
            })
            .collect();
        refs.sort_by(|a, b| a.0.cmp(&b.0));
        schemas.extend(refs);
        schemas
    }

    /// `getSchema(keyRef)`.
    pub(crate) fn get_schema(&mut self, key: &str) -> Result<Option<Validator>, String> {
        let mut key = key.to_string();
        let env = loop {
            let normalized = normalize_id(&key);
            let found = self.schemas.get(&normalized).map(|e| Registered::Env(*e)).or_else(|| self.refs.get(&normalized).cloned());
            match found {
                Some(Registered::Alias(next)) => key = next,
                Some(Registered::Env(env)) => break Some(env),
                None => break None,
            }
        };
        let env = match env {
            Some(env) => env,
            None => {
                let root = self.envs.len();
                self.envs.push(Env {
                    schema: Arc::new(JsonValue::Object(Default::default())),
                    root,
                    base_id: String::new(),
                    local_refs: HashMap::new(),
                    refs: HashMap::new(),
                    meta: false,
                    validate: None,
                });
                match self.resolve_schema(root, &key)? {
                    None => return Ok(None),
                    Some(env) => {
                        self.refs.insert(key.clone(), Registered::Env(env));
                        env
                    }
                }
            }
        };
        let root = self.compile_env(env)?;
        Ok(Some(self.validator(root)))
    }

    fn validator(&self, function: usize) -> Validator {
        Validator { functions: Arc::new(self.functions.clone()), root: function, verbose: self.opts.verbose }
    }

    /// `compile(schema)`.
    pub(crate) fn compile(&mut self, schema: Arc<JsonValue>) -> Result<Validator, String> {
        let env = self.add_env(schema, false, "", true, true)?;
        let function = self.compile_env(env)?;
        Ok(self.validator(function))
    }

    /// `_compileSchemaEnv`: a meta-schema compiled with the meta options.
    fn compile_env(&mut self, env: usize) -> Result<usize, String> {
        if let Some(function) = self.envs[env].validate {
            return Ok(function);
        }
        let was = self.in_meta;
        if self.envs[env].meta {
            self.in_meta = true;
        }
        let result = self.compile_schema(env);
        self.in_meta = was;
        result
    }

    /// The function an environment compiles to, compiling it first where it has none.
    pub(crate) fn function_of(&mut self, env: usize) -> Result<usize, String> {
        match self.envs[env].validate {
            Some(function) => Ok(function),
            None => self.compile_schema(env),
        }
    }

    /// `compileSchema`.
    fn compile_schema(&mut self, env: usize) -> Result<usize, String> {
        if let Some(compiling) = self.compilations.iter().copied().find(|c| {
            Arc::ptr_eq(&self.envs[*c].schema, &self.envs[env].schema)
                && self.envs[*c].root == self.envs[env].root
                && self.envs[*c].base_id == self.envs[env].base_id
        }) {
            return Ok(self.envs[compiling].validate.expect("a compiling schema holds its function"));
        }
        let root_id = full_path(&self.envs[self.envs[env].root].base_id, true)?;
        let function = self.functions.len();
        self.functions.push(Arc::new(Function { root: Node { schema: self.envs[env].schema.clone(), body: Body::Valid }, slots: 0 }));
        self.envs[env].validate = Some(function);
        self.compilations.push(env);
        let base_id = if self.envs[env].base_id.is_empty() { root_id } else { self.envs[env].base_id.clone() };
        let it = It {
            schema: self.envs[env].schema.clone(),
            err_path: "#".into(),
            base_id,
            env,
            flags: Flags { all_errors: self.current_options().all_errors, composite: false, create_errors: true },
        };
        let mut slots = 0;
        let compiled = function_code(self, it, &mut slots);
        self.compilations.retain(|c| *c != env);
        match compiled {
            Ok(root) => {
                self.functions[function] = Arc::new(Function { root, slots });
                Ok(function)
            }
            Err(error) => {
                self.envs[env].validate = None;
                Err(error)
            }
        }
    }

    /// `resolveRef(root, baseId, ref)`.
    pub(crate) fn resolve_ref(&mut self, root: usize, base_id: &str, reference: &str) -> Result<Option<RootRef>, String> {
        let reference = self.resolve_url(base_id, reference)?;
        if let Some(held) = self.envs[root].refs.get(&reference) {
            return Ok(Some(held.clone()));
        }
        let mut found = self.resolve(root, &reference)?;
        if found.is_none() {
            if let Some(schema) = self.envs[root].local_refs.get(&reference).cloned() {
                found = Some(self.new_env(schema, root, base_id.to_string()));
            }
        }
        let Some(env) = found else { return Ok(None) };
        let resolved = if inline_ref(&self.envs[env].schema) {
            RootRef::Schema(self.envs[env].schema.clone())
        } else {
            self.function_of(env)?;
            RootRef::Env(env)
        };
        self.envs[root].refs.insert(reference, resolved.clone());
        Ok(Some(resolved))
    }

    fn new_env(&mut self, schema: Arc<JsonValue>, root: usize, base_id: String) -> usize {
        let env = self.envs.len();
        self.envs.push(Env { schema, root, base_id, local_refs: HashMap::new(), refs: HashMap::new(), meta: false, validate: None });
        env
    }

    /// `resolve(root, ref)`.
    fn resolve(&mut self, root: usize, reference: &str) -> Result<Option<usize>, String> {
        let mut reference = reference.to_string();
        loop {
            match self.refs.get(&reference).cloned() {
                Some(Registered::Alias(next)) => reference = next,
                Some(Registered::Env(env)) => return Ok(Some(env)),
                None => break,
            }
        }
        if let Some(env) = self.schemas.get(&reference) {
            return Ok(Some(*env));
        }
        self.resolve_schema(root, &reference)
    }

    /// `resolveSchema(root, ref)`.
    fn resolve_schema(&mut self, root: usize, reference: &str) -> Result<Option<usize>, String> {
        let parsed = uri::parse(reference);
        let ref_path = full_path_of(&parsed)?;
        let mut base_id = full_path(&self.envs[root].base_id, true)?;
        let root_has_keys = matches!(&*self.envs[root].schema, JsonValue::Object(map) if !map.is_empty());
        if root_has_keys && ref_path == base_id {
            return self.json_pointer(&parsed, root);
        }
        let id = normalize_id(&ref_path);
        let registered = self.refs.get(&id).cloned().or_else(|| self.schemas.get(&id).map(|e| Registered::Env(*e)));
        match registered {
            Some(Registered::Alias(alias)) => {
                let Some(env) = self.resolve_schema(root, &alias)? else { return Ok(None) };
                if !matches!(&*self.envs[env].schema, JsonValue::Object(_)) {
                    return Ok(None);
                }
                self.json_pointer(&parsed, env)
            }
            Some(Registered::Env(env)) => {
                if !matches!(&*self.envs[env].schema, JsonValue::Object(_)) {
                    return Ok(None);
                }
                if self.envs[env].validate.is_none() {
                    self.compile_schema(env)?;
                }
                if id == normalize_id(reference) {
                    let schema = self.envs[env].schema.clone();
                    if let Some(JsonValue::String(schema_id)) = get(&schema, "$id").map(|i| &**i) {
                        if !schema_id.is_empty() {
                            base_id = self.resolve_url(&base_id, schema_id)?;
                        }
                    }
                    return Ok(Some(self.new_env(schema, root, base_id)));
                }
                self.json_pointer(&parsed, env)
            }
            None => Ok(None),
        }
    }

    /// `getJsonPointer(parsedRef, env)`.
    fn json_pointer(&mut self, parsed: &uri::Components, env: usize) -> Result<Option<usize>, String> {
        let Some(fragment) = parsed.fragment.as_deref().filter(|f| f.starts_with('/')) else { return Ok(None) };
        let mut base_id = self.envs[env].base_id.clone();
        let mut schema = self.envs[env].schema.clone();
        let root = self.envs[env].root;
        for part in fragment[1..].split('/') {
            if matches!(&*schema, JsonValue::Bool(_)) {
                return Ok(None);
            }
            let key = unescape_fragment(part)?;
            let next = match &*schema {
                JsonValue::Object(map) => map.get(&key).cloned(),
                JsonValue::Array(items) => key.parse::<usize>().ok().filter(|i| i.to_string() == key).and_then(|i| items.get(i).cloned()),
                _ => None,
            };
            let Some(next) = next else { return Ok(None) };
            schema = next;
            if let Some(JsonValue::String(id)) = get(&schema, "$id").map(|i| &**i) {
                if !id.is_empty() && !["properties", "patternProperties", "enum", "dependencies", "definitions"].contains(&part) {
                    base_id = self.resolve_url(&base_id, id)?;
                }
            }
        }
        let mut found = None;
        if let Some(JsonValue::String(reference)) = get(&schema, "$ref").map(|r| &**r) {
            if !reference.is_empty() && !schema_has_rules_but_ref(self, &schema) {
                let resolved = self.resolve_url(&base_id, reference)?;
                found = self.resolve_schema(root, &resolved)?;
            }
        }
        let env = match found {
            Some(env) => env,
            None => self.new_env(schema, root, base_id),
        };
        if Arc::ptr_eq(&self.envs[env].schema, &self.envs[self.envs[env].root].schema) {
            return Ok(None);
        }
        Ok(Some(env))
    }
}
