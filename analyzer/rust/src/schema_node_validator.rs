//! Validates a value against ONE NODE of a schema, inside the document that declares the
//! node. Mirrors `../../nodejs/src/schema-node-validator.ts` (`findingsFor`, `reference`);
//! `unionsAt`, which only a value judged in parts reads, ships with that carve path.
//!
//! A union branch is not a document: its `#/…` references resolve against the schema it
//! was written in. So the node is found, by identity, in a document this validator holds —
//! a schema it was handed whole, or one registered on its instance — and compiled as a
//! reference into that document. Findings come back LOCATED: the instance is verbose, so
//! each names the schema node that raised it.
//!
//! 1. Asked about the WHOLE schema: every finding, located, as the host validates — a host
//!    whose validation fills defaults runs that fill to completion first.
//! 2. Asked about a NODE inside it: every finding the node raises inside its own document,
//!    with no default applied and nothing written.
//! 3. `None` only for a node that lies in no document it holds.
//! 4. A reference the instance cannot resolve is asked of the host.
//! 5. Anything else is a defect and panics with its sentence: a located node that cannot
//!    be registered or compiled where it stands.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use telorun_cel::JsonValue;
use telorun_cel_value::CelValue;

use crate::ajv_core::Validator;
use crate::ajv_keywords::is_rule;
use crate::ajv_runtime::SchemaError;
use crate::ajv_uri_resolver as uri;
use crate::schema_opaque_value::schema_view;
use crate::schema_validation::SchemaValidation;

/// What a host hands the validator.
pub struct NodeValidatorOptions<'h> {
    /// The document the host's own validator resolves a schema id to.
    pub resolve_reference: Box<dyn Fn(&str) -> Option<Arc<JsonValue>> + 'h>,
    /// A whole schema as the host compiles it.
    pub canonical: Option<Box<dyn Fn(&Arc<JsonValue>) -> Arc<JsonValue> + 'h>>,
    /// The host's own whole-schema validation where it fills defaults: the value with
    /// every default the host would have filled, or why that validation could not finish.
    pub fill_defaults: Option<Box<dyn Fn(&Arc<JsonValue>, &CelValue) -> Result<CelValue, String> + 'h>>,
}

#[derive(Clone, Debug)]
struct NodePlace {
    /// The key its document is registered under.
    key: String,
    /// The node's JSON Pointer inside that document, as a URI fragment.
    pointer: String,
}

pub struct SchemaNodeValidator<'h> {
    validation: SchemaValidation,
    options: NodeValidatorOptions<'h>,
    places: HashMap<usize, NodePlace>,
    indexed: HashSet<usize>,
    validators: HashMap<usize, Validator>,
    /// Every node keyed by its address, kept alive so no address is reused.
    held: Vec<Arc<JsonValue>>,
    documents: usize,
}

fn id(node: &Arc<JsonValue>) -> usize {
    Arc::as_ptr(node) as usize
}

/// `encodeURIComponent`.
fn encode_uri_component(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// `decodeURIComponent`, or `None` for a malformed escape.
fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = text.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The node a URI-fragment JSON Pointer names inside `document`.
fn node_at(document: &Arc<JsonValue>, pointer: &str) -> Option<Arc<JsonValue>> {
    if pointer.is_empty() {
        return Some(document.clone());
    }
    let rest = pointer.strip_prefix('/')?;
    let mut current = document.clone();
    for segment in rest.split('/') {
        let key = decode_uri_component(segment)?.replace("~1", "/").replace("~0", "~");
        let next = match &*current {
            JsonValue::Object(map) => map.get(&key).cloned(),
            JsonValue::Array(items) => key.parse::<usize>().ok().filter(|i| i.to_string() == key).and_then(|i| items.get(i).cloned()),
            _ => None,
        }?;
        current = next;
    }
    Some(current)
}

fn is_schema_object(node: &JsonValue) -> bool {
    matches!(node, JsonValue::Object(_))
}

fn describe_place(place: &NodePlace) -> String {
    if place.pointer.is_empty() {
        format!("The schema held as document '{}', validated to judge a stand-in,", place.key)
    } else {
        format!("Schema node '#{}' of document '{}', asked about on its own to judge a stand-in,", place.pointer, place.key)
    }
}

impl<'h> SchemaNodeValidator<'h> {
    /// A validator over `validation`, which must report every error and the node behind
    /// each, and apply no default.
    pub fn new(validation: SchemaValidation, options: NodeValidatorOptions<'h>) -> Self {
        assert!(
            !validation.fills_defaults(),
            "A schema node validator needs an instance that applies no default: a union branch validated alone would write its defaults into the value it is asked about."
        );
        Self {
            validation,
            options,
            places: HashMap::new(),
            indexed: HashSet::new(),
            validators: HashMap::new(),
            held: Vec::new(),
            documents: 0,
        }
    }

    /// `findingsFor(schema)(node, value)`: every finding `node` raises against `value` —
    /// `schema` itself as a document of its own, its defaults filled into `value` first
    /// where the host fills them — or `None` when the node lies in no held document. An
    /// error is a validation that could not finish, as AJV's code throws.
    pub fn findings(&mut self, schema: &Arc<JsonValue>, node: &Arc<JsonValue>, value: &mut CelValue) -> Result<Option<Vec<SchemaError>>, String> {
        let whole = Arc::ptr_eq(node, schema);
        if whole {
            if let Some(fill) = &self.options.fill_defaults {
                *value = fill(schema, value)?;
            }
        }
        self.validate(node, value, whole)
    }

    /// What a `$ref` written in `node` names, read as this validator compiles it.
    pub fn reference(&mut self, node: &Arc<JsonValue>, reference: &str) -> Option<Arc<JsonValue>> {
        let place = self.place_of(node)?;
        self.reference_target(reference, &place.key).map(|(node, _)| node)
    }

    fn base_of(&self, key: &str) -> String {
        self.validation.ajv().registered_base_id(key).unwrap_or_else(|| key.to_string())
    }

    fn reference_target(&mut self, reference: &str, key: &str) -> Option<(Arc<JsonValue>, String)> {
        let absolute = if reference.starts_with('#') {
            format!("{key}{reference}")
        } else {
            uri::resolve(&self.base_of(key), reference).ok()?
        };
        let (target, pointer) = match absolute.find('#') {
            Some(hash) => (absolute[..hash].to_string(), absolute[hash + 1..].to_string()),
            None => (absolute.clone(), String::new()),
        };
        let document = if target == key { self.validation.registered_document(key) } else { self.held_document(&target) }?;
        let node = node_at(&document, &pointer)?;
        is_schema_object(&node).then_some((node, target))
    }

    fn validate(&mut self, node: &Arc<JsonValue>, value: &CelValue, whole: bool) -> Result<Option<Vec<SchemaError>>, String> {
        if !self.validators.contains_key(&id(node)) {
            let place = if whole {
                match self.places.get(&id(node)).cloned() {
                    Some(place) => place,
                    None => self.hold(node),
                }
            } else {
                let Some(place) = self.place_of(node) else { return Ok(None) };
                self.through_bare_references(node, place)
            };
            let validator = self.compile(&place);
            self.held.push(node.clone());
            self.validators.insert(id(node), validator);
        }
        let validator = &self.validators[&id(node)];
        validator.validate(&mut schema_view(value)).map(Some)
    }

    fn compile(&mut self, place: &NodePlace) -> Validator {
        let key = if place.pointer.is_empty() { place.key.clone() } else { format!("{}#{}", place.key, place.pointer) };
        let mut adopted: HashSet<String> = HashSet::new();
        loop {
            match self.validation.ajv_mut().get_schema(&key) {
                Ok(Some(validator)) => return validator,
                Ok(None) => panic!("{} resolves to no schema the validator can compile.", describe_place(place)),
                Err(cause) => {
                    let missing = self.validation.ajv_mut().take_missing_schema().filter(|m| !m.is_empty() && !adopted.contains(m));
                    let Some(missing) = missing else {
                        panic!("{} does not compile where it stands: {cause}", describe_place(place));
                    };
                    let Some(document) = (self.options.resolve_reference)(&missing) else {
                        panic!("{} does not compile where it stands: {cause}", describe_place(place));
                    };
                    adopted.insert(missing.clone());
                    if let Err(reason) = self.validation.add_document(document, &missing) {
                        panic!("{} references '{missing}', which cannot be registered: {reason}", describe_place(place));
                    }
                }
            }
        }
    }

    /// Where a node that is nothing but a `$ref` is compiled: at what it names.
    fn through_bare_references(&mut self, node: &Arc<JsonValue>, place: NodePlace) -> NodePlace {
        let mut seen = HashSet::new();
        let mut current = node.clone();
        let mut at = place;
        while !at.pointer.is_empty() && self.is_bare_reference(&current) && seen.insert(id(&current)) {
            let JsonValue::Object(map) = &*current else { break };
            let Some(JsonValue::String(reference)) = map.get("$ref").map(|r| &**r) else { break };
            let Ok(absolute) = uri::resolve(&self.base_of(&at.key), reference) else { break };
            let (key, pointer) = match absolute.find('#') {
                Some(hash) => (absolute[..hash].to_string(), absolute[hash + 1..].to_string()),
                None => (absolute.clone(), String::new()),
            };
            let Some(document) = self.held_document(&key) else { break };
            let Some(target) = node_at(&document, &pointer) else { break };
            if !matches!(&*target, JsonValue::Object(_) | JsonValue::Array(_)) {
                break;
            }
            current = target;
            at = NodePlace { key, pointer };
        }
        at
    }

    fn is_bare_reference(&self, node: &Arc<JsonValue>) -> bool {
        let JsonValue::Object(map) = &**node else { return false };
        if !matches!(map.get("$ref").map(|r| &**r), Some(JsonValue::String(_))) {
            return false;
        }
        map.iter().all(|(key, _)| key == "$ref" || !is_rule(self.validation.ajv(), key))
    }

    /// The document held under `key`, adopted from the host when this instance holds none.
    fn held_document(&mut self, key: &str) -> Option<Arc<JsonValue>> {
        if let Some(held) = self.validation.registered_document(key) {
            return Some(held);
        }
        let adopted = (self.options.resolve_reference)(key)?;
        if let Err(cause) = self.validation.add_document(adopted, key) {
            panic!("The schema '{key}', referenced by a node asked about on its own, cannot be registered: {cause}");
        }
        self.validation.registered_document(key)
    }

    fn place_of(&mut self, node: &Arc<JsonValue>) -> Option<NodePlace> {
        if let Some(known) = self.places.get(&id(node)) {
            return Some(known.clone());
        }
        for (key, document) in self.validation.ajv().registered_documents() {
            self.index(&document, &key);
        }
        self.places.get(&id(node)).cloned()
    }

    /// Registers a whole schema as a document of its own.
    fn hold(&mut self, schema: &Arc<JsonValue>) -> NodePlace {
        let document = match &self.options.canonical {
            Some(canonical) => canonical(schema),
            None => schema.clone(),
        };
        let place = NodePlace { key: format!("telo://stand-in/{}", self.documents), pointer: String::new() };
        self.documents += 1;
        if let Err(cause) = self.validation.add_document(document.clone(), &place.key) {
            panic!("{} cannot be registered: {cause}", describe_place(&place));
        }
        self.index(&document, &place.key);
        self.held.push(schema.clone());
        self.places.insert(id(schema), place.clone());
        place
    }

    fn index(&mut self, document: &Arc<JsonValue>, key: &str) {
        if !self.indexed.insert(id(document)) {
            return;
        }
        self.held.push(document.clone());
        let mut stack: Vec<(Arc<JsonValue>, String)> = vec![(document.clone(), String::new())];
        while let Some((node, pointer)) = stack.pop() {
            let root = pointer.is_empty();
            if self.places.contains_key(&id(&node)) && !root {
                continue;
            }
            let children: Vec<(String, Arc<JsonValue>)> = match &*node {
                JsonValue::Object(map) => map.iter().map(|(k, v)| (k.to_string(), v.clone())).collect(),
                JsonValue::Array(items) => items.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect(),
                _ => continue,
            };
            self.places.entry(id(&node)).or_insert_with(|| NodePlace { key: key.to_string(), pointer: pointer.clone() });
            for (segment, child) in children.into_iter().rev() {
                let escaped = encode_uri_component(&segment.replace('~', "~0").replace('/', "~1"));
                stack.push((child, format!("{pointer}/{escaped}")));
            }
        }
    }
}
