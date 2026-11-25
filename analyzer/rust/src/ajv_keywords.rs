//! How ajv 8.20.0 compiles a schema into code, as the tree `ajv_runtime` walks: a twin of
//! `compile/validate/index.js` (`validateFunctionCode`, `subschemaCode`, the rule groups
//! and their type checks), `compile/validate/{dataType,defaults,subschema}.js` and the
//! `code` of every keyword the draft-07 vocabulary, `ajv-formats` 3.0.1 and Telo register.
//!
//! What this decides at compile time, AJV's codegen decides at compile time too: which
//! keywords exist (an always-valid subschema compiles to nothing), where a type error is
//! reported (first, or in its group's place when that group holds rules), which defaults a
//! group fills, and every refusal that fails the compile — a keyword value of the wrong
//! type, an `enum` with no entry, a pattern RE2 refuses, a reference that names nothing.

use std::sync::Arc;

use telorun_cel::JsonValue;

use crate::ajv_core::{Ajv, FormatDef, RootRef};
use crate::ajv_formats::ajv_format_compare;
use crate::ajv_runtime::{
    escape_fragment, AdditionalCode, AdditionalItemsCode, Body, Code, DefaultAt, Flags, FormatRun, Group, JsonType,
    Keyword, Limit, Node, RefCall, Rules, TypeCheck,
};
use crate::schema_opaque_value::{inherited_member, JsObject, JsValue};
use crate::schema_pattern::schema_pattern;
use crate::value_type_keyword::compile_telo_type;

/// One place a subschema is compiled: AJV's schema context `it`.
#[derive(Clone)]
pub(crate) struct It {
    pub schema: Arc<JsonValue>,
    pub err_path: String,
    pub base_id: String,
    pub env: usize,
    pub flags: Flags,
}

/// The rule groups, in AJV's order: `(group type, keywords)`.
fn rule_groups(ajv: &Ajv) -> Vec<(Option<JsonType>, Vec<&'static str>)> {
    let telo = ajv.current_options().telo;
    let mut untyped = vec!["$comment", "id", "$ref", "type", "nullable", "const", "enum", "not", "anyOf", "oneOf", "allOf", "if", "then", "else"];
    let mut string = vec!["maxLength", "minLength", "pattern", "format"];
    if telo {
        untyped.push("x-telo-type");
        string.extend(["formatMaximum", "formatMinimum", "formatExclusiveMaximum", "formatExclusiveMinimum"]);
    }
    vec![
        (None, untyped),
        (Some(JsonType::Number), vec!["maximum", "minimum", "exclusiveMaximum", "exclusiveMinimum", "multipleOf", "format"]),
        (Some(JsonType::String), string),
        (Some(JsonType::Array), vec!["maxItems", "minItems", "additionalItems", "items", "contains", "uniqueItems"]),
        (
            Some(JsonType::Object),
            vec!["maxProperties", "minProperties", "required", "propertyNames", "additionalProperties", "dependencies", "properties", "patternProperties"],
        ),
    ]
}

/// Whether `key` is in `RULES.all` — a plain object, so an inherited member's name is too.
pub(crate) fn is_rule(ajv: &Ajv, key: &str) -> bool {
    inherited_member(key).is_some() || rule_groups(ajv).iter().any(|(_, keywords)| keywords.contains(&key))
}

fn object(schema: &JsonValue) -> Option<&telorun_cel_value::PropertyMap<Arc<JsonValue>>> {
    match schema {
        JsonValue::Object(map) => Some(map),
        _ => None,
    }
}

pub(crate) fn get<'s>(schema: &'s JsonValue, key: &str) -> Option<&'s Arc<JsonValue>> {
    object(schema)?.get(key)
}

/// `schemaHasRules`.
pub(crate) fn schema_has_rules(ajv: &Ajv, schema: &JsonValue) -> bool {
    match schema {
        JsonValue::Bool(b) => !b,
        JsonValue::Object(map) => map.keys().any(|key| is_rule(ajv, key)),
        _ => false,
    }
}

/// `schemaHasRulesButRef`.
pub(crate) fn schema_has_rules_but_ref(ajv: &Ajv, schema: &JsonValue) -> bool {
    match schema {
        JsonValue::Bool(b) => !b,
        JsonValue::Object(map) => map.keys().any(|key| key != "$ref" && is_rule(ajv, key)),
        _ => false,
    }
}

/// `alwaysValidSchema`.
pub(crate) fn always_valid(ajv: &Ajv, schema: &JsonValue) -> bool {
    match schema {
        JsonValue::Bool(b) => *b,
        JsonValue::Object(map) => map.is_empty() || !schema_has_rules(ajv, schema),
        _ => !schema_has_rules(ajv, schema),
    }
}

/// JavaScript's truthiness of a schema value.
pub(crate) fn truthy(value: &JsonValue) -> bool {
    match value {
        JsonValue::Null => false,
        JsonValue::Bool(b) => *b,
        JsonValue::Number(n) => *n != 0.0 && !n.is_nan(),
        JsonValue::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// A schema value as the validator's data — what a `default`, `const` or `enum` entry
/// is compared or written as.
pub(crate) fn js_of(value: &JsonValue) -> JsValue {
    match value {
        JsonValue::Null => JsValue::Null,
        JsonValue::Bool(b) => JsValue::Bool(*b),
        JsonValue::Number(n) => JsValue::number(*n),
        JsonValue::String(s) => JsValue::string(s),
        JsonValue::Array(items) => JsValue::Array(items.iter().map(|item| js_of(item)).collect()),
        JsonValue::Object(map) => {
            let mut out = JsObject::new();
            for (key, item) in map.iter() {
                out.insert(key, js_of(item));
            }
            JsValue::Object(out)
        }
    }
}

/// `getSchemaTypes`.
pub(crate) fn schema_types(schema: &JsonValue) -> Result<Vec<JsonType>, String> {
    let mut types: Vec<JsonType> = Vec::new();
    if let Some(written) = get(schema, "type") {
        let names: Vec<&Arc<JsonValue>> = match &**written {
            JsonValue::Array(items) => items.iter().collect(),
            other if truthy(other) => vec![written],
            _ => Vec::new(),
        };
        for name in &names {
            match &***name {
                JsonValue::String(s) if JsonType::read(s).is_some() => types.push(JsonType::read(s).unwrap()),
                _ => {
                    let listed: Vec<String> = names.iter().map(|n| crate::ajv_runtime::template_text(n)).collect();
                    return Err(format!("type must be JSONType or JSONType[]: {}", listed.join(",")));
                }
            }
        }
    }
    let nullable = get(schema, "nullable").map(|n| &**n);
    if types.contains(&JsonType::Null) {
        if matches!(nullable, Some(JsonValue::Bool(false))) {
            return Err("type: null contradicts nullable: false".into());
        }
    } else {
        if types.is_empty() && nullable.is_some() {
            return Err("\"nullable\" cannot be used without \"type\"".into());
        }
        if matches!(nullable, Some(JsonValue::Bool(true))) {
            types.push(JsonType::Null);
        }
    }
    Ok(types)
}

fn schema_type_holds(value: &JsonValue, types: &[&str]) -> bool {
    types.is_empty()
        || types.iter().any(|ty| match *ty {
            "array" => matches!(value, JsonValue::Array(_)),
            "object" => matches!(value, JsonValue::Object(_)),
            "string" => matches!(value, JsonValue::String(_)),
            "number" => matches!(value, JsonValue::Number(_)),
            "boolean" => matches!(value, JsonValue::Bool(_)),
            _ => false,
        })
}

/// A keyword's `schemaType`, as its definition declares it.
fn keyword_schema_type(keyword: &str) -> &'static [&'static str] {
    match keyword {
        "$ref" | "pattern" | "format" | "formatMaximum" | "formatMinimum" | "formatExclusiveMaximum" | "formatExclusiveMinimum" => &["string"],
        "type" => &["string", "array"],
        "nullable" | "uniqueItems" => &["boolean"],
        "enum" | "anyOf" | "oneOf" | "allOf" | "required" => &["array"],
        "not" | "if" | "then" | "else" | "contains" | "propertyNames" => &["object", "boolean"],
        "additionalItems" | "additionalProperties" => &["boolean", "object"],
        "items" => &["object", "array", "boolean"],
        "x-telo-type" => &["string", "object"],
        "maximum" | "minimum" | "exclusiveMaximum" | "exclusiveMinimum" | "multipleOf" | "maxLength" | "minLength"
        | "maxItems" | "minItems" | "maxProperties" | "minProperties" => &["number"],
        "dependencies" | "properties" | "patternProperties" => &["object"],
        _ => &[],
    }
}

fn json_array_text(types: &[&str]) -> String {
    format!("[{}]", types.iter().map(|t| format!("\"{t}\"")).collect::<Vec<_>>().join(","))
}

/// The keyword's value, held to its `schemaType` — `KeywordCxt`'s constructor.
fn keyword_value(it: &It, keyword: &str) -> Result<Arc<JsonValue>, String> {
    let value = get(&it.schema, keyword).cloned().expect("a keyword the schema holds");
    let types = keyword_schema_type(keyword);
    if keyword.starts_with("format") && keyword != "format" && get(&it.schema, "format").is_none() {
        return Err(format!("parent schema must have dependencies of {keyword}: format"));
    }
    if !schema_type_holds(&value, types) {
        return Err(format!("{keyword} value must be {}", json_array_text(types)));
    }
    Ok(value)
}

/// What a subschema place changes about its context: AJV's `getSubschema` plus
/// `extendSubschemaMode`.
pub(crate) struct Place<'a> {
    pub keyword: &'a str,
    pub prop: Option<&'a str>,
    pub composite: Option<bool>,
    pub create_errors: Option<bool>,
    pub all_errors: Option<bool>,
}

impl<'a> Place<'a> {
    pub fn at(keyword: &'a str) -> Self {
        Place { keyword, prop: None, composite: None, create_errors: None, all_errors: None }
    }

    pub fn prop(mut self, prop: &'a str) -> Self {
        self.prop = Some(prop);
        self
    }

    pub fn composite(mut self) -> Self {
        self.composite = Some(true);
        self
    }

    pub fn quiet(mut self) -> Self {
        self.composite = Some(true);
        self.create_errors = Some(false);
        self.all_errors = Some(false);
        self
    }
}

/// A subschema of `it` at `place`, compiled.
pub(crate) fn subschema(ajv: &mut Ajv, it: &It, place: Place, slots: &mut usize) -> Result<Node, String> {
    let at = get(&it.schema, place.keyword).cloned().expect("the keyword the subschema sits at");
    let (schema, err_path) = match place.prop {
        None => (at, format!("{}/{}", it.err_path, place.keyword)),
        Some(prop) => {
            let child = match &*at {
                JsonValue::Object(map) => map.get(prop).cloned(),
                JsonValue::Array(items) => prop.parse::<usize>().ok().and_then(|i| items.get(i).cloned()),
                _ => None,
            }
            .expect("the member the subschema sits at");
            (child, format!("{}/{}/{}", it.err_path, place.keyword, escape_fragment(prop)))
        }
    };
    let flags = Flags {
        composite: place.composite.unwrap_or(it.flags.composite),
        create_errors: place.create_errors.unwrap_or(it.flags.create_errors),
        all_errors: place.all_errors.unwrap_or(it.flags.all_errors),
    };
    let next = It { schema, err_path, base_id: it.base_id.clone(), env: it.env, flags };
    subschema_code(ajv, next, slots)
}

/// `subschemaCode`.
pub(crate) fn subschema_code(ajv: &mut Ajv, mut it: It, slots: &mut usize) -> Result<Node, String> {
    if let JsonValue::Object(_) = &*it.schema {
        if schema_has_rules(ajv, &it.schema) {
            match get(&it.schema, "$id").map(|id| &**id) {
                Some(JsonValue::String(id)) if !id.is_empty() => it.base_id = ajv.resolve_url(&it.base_id, id)?,
                Some(id) if truthy(id) && !matches!(id, JsonValue::String(_)) => return Err("id.replace is not a function".into()),
                _ => {}
            }
            return rules_node(ajv, it, slots);
        }
    }
    Ok(bool_node(&it, false))
}

/// `validateFunctionCode`: a compiled function's root.
pub(crate) fn function_code(ajv: &mut Ajv, it: It, slots: &mut usize) -> Result<Node, String> {
    if let JsonValue::Object(_) = &*it.schema {
        if schema_has_rules(ajv, &it.schema) {
            return rules_node(ajv, it, slots);
        }
    }
    Ok(bool_node(&it, true))
}

fn bool_node(it: &It, top: bool) -> Node {
    let body = match &*it.schema {
        JsonValue::Bool(false) => Body::False { err_path: Arc::from(it.err_path.as_str()), top, flags: it.flags },
        _ => Body::Valid,
    };
    Node { schema: it.schema.clone(), body }
}

fn uses_group(it: &It, keywords: &[&str]) -> bool {
    keywords.iter().any(|keyword| get(&it.schema, keyword).is_some())
}

/// `typeAndKeywords` and `schemaKeywords`.
fn rules_node(ajv: &mut Ajv, it: It, slots: &mut usize) -> Result<Node, String> {
    let types = schema_types(&it.schema)?;
    let groups = rule_groups(ajv);
    let has_rules_for = |ty: JsonType| groups.iter().any(|(group, keywords)| *group == Some(ty) && uses_group(&it, keywords));
    let check_types = !types.is_empty() && !(types.len() == 1 && has_rules_for(types[0]));
    let type_value = get(&it.schema, "type").cloned();
    let check = || TypeCheck { types: types.clone(), value: type_value.clone().unwrap_or_else(|| Arc::new(JsonValue::Null)) };
    let mut rules = Rules {
        flags: it.flags,
        err_path: Arc::from(it.err_path.as_str()),
        top_type: check_types.then(check),
        ref_only: None,
        groups: Vec::new(),
    };
    if get(&it.schema, "$ref").is_some() && !schema_has_rules_but_ref(ajv, &it.schema) {
        rules.ref_only = Some(keyword_code(ajv, &it, "$ref", None, slots)?.expect("a reference compiles to code"));
        return Ok(Node { schema: it.schema.clone(), body: Body::Rules(Box::new(rules)) });
    }
    let use_defaults = ajv.current_options().use_defaults;
    for (ty, keywords) in groups {
        if !uses_group(&it, &keywords) {
            continue;
        }
        let mut group = Group { ty, defaults: Vec::new(), keywords: Vec::new(), else_type: None };
        if use_defaults && !it.flags.composite {
            group.defaults = defaults_of(&it, ty);
        }
        for keyword in keywords {
            if get(&it.schema, keyword).is_none() {
                continue;
            }
            if let Some(code) = keyword_code(ajv, &it, keyword, ty, slots)? {
                group.keywords.push(code);
            }
        }
        if ty.is_some() && types.len() == 1 && Some(types[0]) == ty && !check_types {
            group.else_type = Some(check());
        }
        rules.groups.push(group);
    }
    Ok(Node { schema: it.schema.clone(), body: Body::Rules(Box::new(rules)) })
}

/// `assignDefaults`.
fn defaults_of(it: &It, ty: Option<JsonType>) -> Vec<(DefaultAt, JsValue)> {
    let mut out = Vec::new();
    match ty {
        Some(JsonType::Object) => {
            if let Some(properties) = get(&it.schema, "properties").filter(|p| truthy(p)).and_then(|p| object(p).cloned()) {
                for (key, child) in properties.iter() {
                    if let Some(value) = get(child, "default") {
                        out.push((DefaultAt::Key(key.to_string()), js_of(value)));
                    }
                }
            }
        }
        Some(JsonType::Array) => {
            if let Some(JsonValue::Array(items)) = get(&it.schema, "items").map(|i| &**i) {
                for (i, child) in items.iter().enumerate() {
                    if let Some(value) = get(child, "default") {
                        out.push((DefaultAt::Index(i), js_of(value)));
                    }
                }
            }
        }
        _ => {}
    }
    out
}

/// `allSchemaProperties`: the keys of a map, `__proto__` left out.
fn schema_properties(map: Option<&Arc<JsonValue>>) -> Vec<String> {
    map.and_then(|m| object(m)).map(|m| m.keys().filter(|k| *k != "__proto__").map(str::to_string).collect()).unwrap_or_default()
}

fn number_of(value: &JsonValue) -> f64 {
    match value {
        JsonValue::Number(n) => *n,
        _ => f64::NAN,
    }
}

fn pattern(source: &str) -> Result<Arc<telorun_cel::Re2Program>, String> {
    schema_pattern(source, "u")
}

fn format_run(ajv: &Ajv, name: &str, rule_type: Option<JsonType>) -> Option<FormatRun> {
    let def = ajv.format(name)?;
    match (def, rule_type) {
        (FormatDef::Any, _) => None,
        (FormatDef::Text(check), Some(JsonType::String)) => Some(FormatRun::Text(check)),
        (FormatDef::Number(check), Some(JsonType::Number)) => Some(FormatRun::Number(check)),
        _ => None,
    }
}

/// One keyword's code, or `None` where AJV emits none.
fn keyword_code(ajv: &mut Ajv, it: &It, keyword: &'static str, rule_type: Option<JsonType>, slots: &mut usize) -> Result<Option<Keyword>, String> {
    let value = keyword_value(it, keyword)?;
    let keyword_of = |code: Code, value: Arc<JsonValue>| Ok(Some(Keyword { name: keyword, value, code }));
    let opts = ajv.current_options().clone();
    match keyword {
        "$comment" | "type" | "nullable" | "then" | "else" => Ok(None),
        "id" => Err("NOT SUPPORTED: keyword \"id\", use \"$id\" for schema ID".into()),
        "$ref" => {
            let JsonValue::String(reference) = &*value else { unreachable!("held to its schemaType") };
            let root = ajv.env_root(it.env);
            if (reference == "#" || reference == "#/") && it.base_id == ajv.env_base_id(root) {
                let id = ajv.function_of(root)?;
                return keyword_of(Code::Ref(RefCall::Function(id)), value.clone());
            }
            match ajv.resolve_ref(root, &it.base_id, reference)? {
                None => {
                    ajv.note_missing_ref(&it.base_id, reference);
                    Err(format!("can't resolve reference {reference} from id {}", it.base_id))
                }
                Some(RootRef::Env(env)) => {
                    let id = ajv.function_of(env)?;
                    keyword_of(Code::Ref(RefCall::Function(id)), value.clone())
                }
                Some(RootRef::Schema(schema)) => {
                    let next = It { schema, err_path: reference.clone(), base_id: it.base_id.clone(), env: it.env, flags: it.flags };
                    let node = subschema_code(ajv, next, slots)?;
                    keyword_of(Code::Ref(RefCall::Inline(Box::new(node))), value.clone())
                }
            }
        }
        "const" => {
            let deep = matches!(&*value, JsonValue::Object(_) | JsonValue::Array(_));
            keyword_of(Code::Const { value: js_of(&value), deep }, value.clone())
        }
        "enum" => {
            let JsonValue::Array(entries) = &*value else { unreachable!() };
            if entries.is_empty() {
                return Err("enum must have non-empty array".into());
            }
            let compiled = entries.iter().map(|e| (js_of(e), matches!(&**e, JsonValue::Object(_) | JsonValue::Array(_)))).collect();
            keyword_of(Code::Enum(compiled), value.clone())
        }
        "not" => {
            if always_valid(ajv, &value) {
                return keyword_of(Code::NotAlways, value.clone());
            }
            let child = subschema(ajv, it, Place::at("not").quiet(), slots)?;
            keyword_of(Code::Not(Box::new(child)), value.clone())
        }
        "anyOf" | "oneOf" | "allOf" => {
            let JsonValue::Array(branches) = &*value else { unreachable!() };
            if keyword == "anyOf" && branches.iter().any(|b| always_valid(ajv, b)) {
                return Ok(None);
            }
            let mut compiled = Vec::new();
            for (i, branch) in branches.iter().enumerate() {
                let index = i.to_string();
                if keyword != "anyOf" && always_valid(ajv, branch) {
                    compiled.push(None);
                    continue;
                }
                let place = Place::at(keyword).prop(&index);
                let place = if keyword == "allOf" { place } else { place.composite() };
                compiled.push(Some(subschema(ajv, it, place, slots)?));
            }
            let code = match keyword {
                "anyOf" => Code::AnyOf(compiled.into_iter().flatten().collect()),
                "oneOf" => Code::OneOf(compiled),
                _ => Code::AllOf(compiled.into_iter().flatten().collect()),
            };
            keyword_of(code, value.clone())
        }
        "if" => {
            let has = |name: &str| get(&it.schema, name).is_some_and(|s| !always_valid(ajv, s));
            let (has_then, has_else) = (has("then"), has("else"));
            if !has_then && !has_else {
                return Ok(None);
            }
            let condition = subschema(ajv, it, Place::at("if").quiet(), slots)?;
            let then = if has_then { Some(Box::new(subschema(ajv, it, Place::at("then"), slots)?)) } else { None };
            let otherwise = if has_else { Some(Box::new(subschema(ajv, it, Place::at("else"), slots)?)) } else { None };
            keyword_of(Code::If { condition: Box::new(condition), then, otherwise }, value.clone())
        }
        "x-telo-type" => match compile_telo_type(ajv, it, &value, slots)? {
            Some(code) => keyword_of(code, value.clone()),
            None => Ok(None),
        },
        "maximum" | "minimum" | "exclusiveMaximum" | "exclusiveMinimum" => {
            let limit = match keyword {
                "maximum" => Limit::Maximum,
                "minimum" => Limit::Minimum,
                "exclusiveMaximum" => Limit::ExclusiveMaximum,
                _ => Limit::ExclusiveMinimum,
            };
            keyword_of(Code::LimitNumber { limit, bound: number_of(&value) }, value.clone())
        }
        "multipleOf" => keyword_of(Code::MultipleOf(number_of(&value)), value.clone()),
        "format" => {
            if !opts.validate_formats {
                return Ok(None);
            }
            let JsonValue::String(name) = &*value else { unreachable!() };
            match format_run(ajv, name, rule_type) {
                Some(run) => keyword_of(Code::Format { name: name.clone(), run }, value.clone()),
                None => Ok(None),
            }
        }
        "formatMaximum" | "formatMinimum" | "formatExclusiveMaximum" | "formatExclusiveMinimum" => {
            if !opts.validate_formats {
                return Ok(None);
            }
            let format = keyword_value(it, "format")?;
            let JsonValue::String(format) = &*format else { unreachable!() };
            let limit = match keyword {
                "formatMaximum" => Limit::Maximum,
                "formatMinimum" => Limit::Minimum,
                "formatExclusiveMaximum" => Limit::ExclusiveMaximum,
                _ => Limit::ExclusiveMinimum,
            };
            match ajv.format(format) {
                None | Some(FormatDef::Any) => Ok(None),
                Some(_) => match ajv_format_compare(format) {
                    Some(compare) => {
                        let JsonValue::String(bound) = &*value else { unreachable!() };
                        keyword_of(Code::FormatLimit { limit, bound: bound.clone(), compare }, value.clone())
                    }
                    None => Err(format!("\"{keyword}\": format \"{format}\" does not define \"compare\" function")),
                },
            }
        }
        "maxLength" | "minLength" => keyword_of(Code::Length { max: keyword == "maxLength", limit: number_of(&value) }, value.clone()),
        "pattern" => {
            let JsonValue::String(source) = &*value else { unreachable!() };
            keyword_of(Code::Pattern { source: source.clone(), program: pattern(source)? }, value.clone())
        }
        "maxItems" | "minItems" => keyword_of(Code::Items { max: keyword == "maxItems", limit: number_of(&value) }, value.clone()),
        "additionalItems" => {
            let Some(JsonValue::Array(items)) = get(&it.schema, "items").map(|i| &**i) else { return Ok(None) };
            let length = items.len();
            match &*value {
                JsonValue::Bool(false) => keyword_of(Code::AdditionalItems { length, code: AdditionalItemsCode::False }, value.clone()),
                JsonValue::Object(_) if !always_valid(ajv, &value) => {
                    let child = subschema(ajv, it, Place::at("additionalItems"), slots)?;
                    keyword_of(Code::AdditionalItems { length, code: AdditionalItemsCode::Schema(Box::new(child)) }, value.clone())
                }
                _ => Ok(None),
            }
        }
        "items" => {
            if let JsonValue::Array(elements) = &*value {
                let mut compiled = Vec::new();
                for (i, element) in elements.iter().enumerate() {
                    if always_valid(ajv, element) {
                        compiled.push(None);
                    } else {
                        let index = i.to_string();
                        compiled.push(Some(subschema(ajv, it, Place::at("items").prop(&index), slots)?));
                    }
                }
                let slot = *slots;
                *slots += 1;
                return keyword_of(Code::Tuple { elements: compiled, slot }, value.clone());
            }
            if always_valid(ajv, &value) {
                return Ok(None);
            }
            let child = subschema(ajv, it, Place::at("items"), slots)?;
            keyword_of(Code::ItemsAll(Box::new(child)), value.clone())
        }
        "contains" => {
            if always_valid(ajv, &value) {
                return keyword_of(Code::ContainsAny, value.clone());
            }
            let child = subschema(ajv, it, Place::at("contains").composite(), slots)?;
            keyword_of(Code::Contains(Box::new(child)), value.clone())
        }
        "uniqueItems" => {
            if matches!(&*value, JsonValue::Bool(false)) {
                return Ok(None);
            }
            let item_types = match get(&it.schema, "items").filter(|i| truthy(i)) {
                Some(items) => schema_types(items)?,
                None => Vec::new(),
            };
            let optimize = !item_types.is_empty() && !item_types.iter().any(|t| matches!(t, JsonType::Object | JsonType::Array));
            keyword_of(Code::UniqueItems { item_types, optimize }, value.clone())
        }
        "maxProperties" | "minProperties" => {
            keyword_of(Code::LimitProperties { max: keyword == "maxProperties", limit: number_of(&value) }, value.clone())
        }
        "required" => {
            let JsonValue::Array(names) = &*value else { unreachable!() };
            if names.is_empty() {
                return Ok(None);
            }
            let names = names.iter().map(|n| crate::ajv_runtime::template_text(n)).collect();
            keyword_of(Code::Required(names), value.clone())
        }
        "propertyNames" => {
            if always_valid(ajv, &value) {
                return Ok(None);
            }
            let child = subschema(ajv, it, Place::at("propertyNames").composite(), slots)?;
            keyword_of(Code::PropertyNames(Box::new(child)), value.clone())
        }
        "additionalProperties" => {
            if always_valid(ajv, &value) {
                return Ok(None);
            }
            let properties = get(&it.schema, "properties");
            let names = schema_properties(properties);
            let own_proto = properties.and_then(|p| object(p)).is_some_and(|p| p.contains_key("__proto__"));
            let mut patterns = Vec::new();
            for source in schema_properties(get(&it.schema, "patternProperties")) {
                patterns.push(pattern(&source)?);
            }
            let code = if opts.remove_additional && matches!(&*value, JsonValue::Bool(false)) {
                AdditionalCode::Remove
            } else if matches!(&*value, JsonValue::Bool(false)) {
                AdditionalCode::False
            } else if matches!(&*value, JsonValue::Object(_)) {
                AdditionalCode::Schema(Box::new(subschema(ajv, it, Place::at("additionalProperties"), slots)?))
            } else {
                return Ok(None);
            };
            let many = names.len() > 8;
            keyword_of(Code::Additional { names, own_proto, many, patterns, code }, value.clone())
        }
        "dependencies" => {
            let map = object(&value).cloned().unwrap_or_default();
            let mut property = Vec::new();
            let mut schema = Vec::new();
            for (name, dep) in map.iter() {
                if name == "__proto__" {
                    continue;
                }
                if let JsonValue::Array(deps) = &**dep {
                    if !deps.is_empty() {
                        property.push((name.to_string(), deps.iter().map(|d| crate::ajv_runtime::template_text(d)).collect()));
                    }
                }
            }
            for (name, dep) in map.iter() {
                if name == "__proto__" || matches!(&**dep, JsonValue::Array(_)) || always_valid(ajv, dep) {
                    continue;
                }
                schema.push((name.to_string(), subschema(ajv, it, Place::at("dependencies").prop(name), slots)?));
            }
            keyword_of(Code::Dependencies { property, schema }, value.clone())
        }
        "properties" => {
            let mut entries = Vec::new();
            for name in schema_properties(Some(&value)) {
                let child = get(&value, &name).cloned().expect("a property schema");
                if always_valid(ajv, &child) {
                    continue;
                }
                let has_default = opts.use_defaults && !it.flags.composite && get(&child, "default").is_some();
                entries.push((name.clone(), subschema(ajv, it, Place::at("properties").prop(&name), slots)?, has_default));
            }
            if entries.is_empty() {
                return Ok(None);
            }
            keyword_of(Code::Properties(entries), value.clone())
        }
        "patternProperties" => {
            let sources = schema_properties(Some(&value));
            let always: Vec<bool> = sources.iter().map(|s| always_valid(ajv, get(&value, s).unwrap())).collect();
            if sources.is_empty() || always.iter().all(|a| *a) {
                return Ok(None);
            }
            let mut entries = Vec::new();
            for (source, always) in sources.iter().zip(always) {
                let program = pattern(source)?;
                let child = if always { None } else { Some(subschema(ajv, it, Place::at("patternProperties").prop(source), slots)?) };
                entries.push((program, child));
            }
            keyword_of(Code::PatternProperties { entries }, value.clone())
        }
        other => unreachable!("no code for keyword {other}"),
    }
}
