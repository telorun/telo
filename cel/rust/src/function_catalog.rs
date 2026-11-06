//! Loading the function catalog into an environment — `function-catalog.ts`.
//!
//! The catalog is the dialect: the functions a manifest may call beside CEL's own library.
//! It is data — `cel/nodejs/src/signatures/function-catalog.json`, the file the Node engine
//! reads, read here in place at build time and parsed once per process — registered
//! through the public [`CelEnvironment::register_function`], so a host may leave it out,
//! replace a signature or remove a name, and nothing in the engine behaves differently for
//! it. What each function does is `catalog_runtime.rs`, keyed by the same dispatch key.
//!
//! A declared signature with no implementation, a guard the data claims and the runtime
//! lacks, a signature the environment refuses and a file this engine cannot read are
//! defects of the engine, never of an input, and panic naming the entry, as the standard
//! library's do. Recorded against `@telorun/cel` 0.129.0 at `2ee5ef49` under Node v24.21.0
//! (V8 13.6.233.17-node.53, ICU 78.3, tz 2026c), with d3-format 3.1.2, `uuid` 14.0.1 and
//! re2js 2.8.3.
//!
//! Node items with no twin: none.

use std::sync::LazyLock;

use crate::catalog_runtime::{catalog_implementation, catalog_literal_check, CelCatalogHandlers};
use crate::environment::CelEnvironment;
use crate::json_text_scan::read_json_text;
use crate::json_value::JsonValue;
use crate::signature::{parse_signature, signature_key, FunctionMetadata};

const CATALOG_TEXT: &str = include_str!("../../nodejs/src/signatures/function-catalog.json");

/// The generation of the catalog's data, which the file itself declares.
pub const FUNCTION_CATALOG_GENERATION: u32 = 1;

const ORIGIN: &str = "function-catalog";

/// One function of the catalog, as a listing prints it.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct CatalogFunction {
    pub name: String,
    /// The signature a human reads: an optional parameter is written `fn(string?)` and
    /// registers one signature per arity.
    pub signature: String,
    /// Every signature the function registers, in registration order.
    pub signatures: Vec<String>,
    pub category: String,
    pub summary: String,
    /// False where two calls with the same arguments may answer differently.
    pub deterministic: bool,
    /// Whether the implementation is the host's rather than the engine's.
    pub host_backed: bool,
    /// Whether the function refuses an argument written as a literal, at check.
    pub checks_literal_arguments: bool,
}

struct CatalogData {
    categories: Vec<String>,
    functions: Vec<CatalogFunction>,
}

/// Reads one member of the data, naming where it stands when it is not there.
struct Field<'a> {
    value: &'a JsonValue,
    path: String,
}

impl<'a> Field<'a> {
    fn get(&self, key: &str) -> Field<'a> {
        self.find(key).unwrap_or_else(|| panic!("the function catalog's {} has no {key:?}", self.path))
    }

    fn find(&self, key: &str) -> Option<Field<'a>> {
        match self.value {
            JsonValue::Object(entries) => {
                entries.get(key).map(|value| Field { value: &**value, path: format!("{}.{key}", self.path) })
            }
            _ => panic!("the function catalog's {} is not an object", self.path),
        }
    }

    fn items(&self) -> Vec<Field<'a>> {
        match self.value {
            JsonValue::Array(items) => items
                .iter()
                .enumerate()
                .map(|(at, value)| Field { value: &**value, path: format!("{}[{at}]", self.path) })
                .collect(),
            _ => panic!("the function catalog's {} is not an array", self.path),
        }
    }

    fn text(&self) -> String {
        match self.value {
            JsonValue::String(text) => text.clone(),
            _ => panic!("the function catalog's {} is not a string", self.path),
        }
    }

    fn flag(&self) -> bool {
        match self.value {
            JsonValue::Bool(flag) => *flag,
            _ => panic!("the function catalog's {} is not a boolean", self.path),
        }
    }
}

fn read_catalog() -> CatalogData {
    let root_value = read_json_text(CATALOG_TEXT).unwrap_or_else(|cause| panic!("the function catalog is not JSON: {cause}"));
    let root = Field { value: &root_value, path: "file".into() };
    match root.get("generation").value {
        JsonValue::Number(generation) if *generation == f64::from(FUNCTION_CATALOG_GENERATION) => {}
        _ => panic!("the function catalog's generation is not {FUNCTION_CATALOG_GENERATION}"),
    }
    // Nothing in the file is cel-spec's, declared once for the whole file, with its reason.
    assert!(!root.get("spec").flag(), "the function catalog declares itself cel-spec's");
    assert!(!root.get("reason").text().is_empty(), "the function catalog gives no reason for its spec flag");
    let functions = root
        .get("functions")
        .items()
        .iter()
        .map(|entry| CatalogFunction {
            name: entry.get("name").text(),
            signature: entry.get("signature").text(),
            signatures: entry.get("signatures").items().iter().map(Field::text).collect(),
            category: entry.get("category").text(),
            summary: entry.get("summary").text(),
            deterministic: entry.get("deterministic").flag(),
            host_backed: entry.get("hostBacked").flag(),
            checks_literal_arguments: entry.find("checksLiteralArguments").is_some_and(|flag| flag.flag()),
        })
        .collect();
    CatalogData { categories: root.get("categories").items().iter().map(Field::text).collect(), functions }
}

static CATALOG: LazyLock<CatalogData> = LazyLock::new(read_catalog);

/// The categories the catalog groups its functions under, for a grouped listing.
pub fn catalog_categories() -> &'static [String] {
    &CATALOG.categories
}

/// The catalog, as the one surface a listing reads.
pub fn function_catalog() -> &'static [CatalogFunction] {
    &CATALOG.functions
}

/// Every signature the catalog registers, in registration order.
pub fn catalog_signatures() -> Vec<String> {
    CATALOG.functions.iter().flat_map(|entry| entry.signatures.iter().cloned()).collect()
}

/// What [`register_function_catalog`] registers with.
#[derive(Clone, Default, Debug)]
pub struct RegisterCatalogOptions {
    /// The host's implementations of its nine functions. One left out still registers, so
    /// a call to it type-checks, and evaluating it answers `unbound_function` naming it.
    pub handlers: CelCatalogHandlers,
}

/// Registers the catalog onto an environment through its public registration surface,
/// each signature with its determinism, whether the host backs it, its summary as its
/// description, the origin `function-catalog`, and its literal guard where it declares one.
pub fn register_function_catalog(environment: &mut CelEnvironment, options: RegisterCatalogOptions) {
    for entry in &CATALOG.functions {
        let check = if entry.checks_literal_arguments {
            Some(catalog_literal_check(&entry.name).unwrap_or_else(|| {
                panic!("the catalog declares that {} checks its literal arguments, and no guard answers for it", entry.name)
            }))
        } else {
            None
        };
        for signature in &entry.signatures {
            let parsed = parse_signature(signature, None)
                .unwrap_or_else(|cause| panic!("the catalog's {signature:?} does not read: {cause}"));
            let key = signature_key(&parsed);
            let implementation = catalog_implementation(&key, &options.handlers)
                .unwrap_or_else(|| panic!("the catalog declares {signature} and nothing implements {key}"));
            let metadata = FunctionMetadata {
                implementation: Some(implementation),
                check_arguments: check.clone(),
                deterministic: entry.deterministic,
                host_backed: entry.host_backed,
                description: Some(entry.summary.clone()),
                origin: Some(ORIGIN.into()),
                ..FunctionMetadata::default()
            };
            environment
                .register_function(signature.as_str(), metadata)
                .unwrap_or_else(|cause| panic!("the catalog's {signature:?} is refused: {cause}"));
        }
    }
}
