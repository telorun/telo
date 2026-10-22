//! Loading CEL's standard library into a registry — `standard-library.ts`.
//!
//! The library is data: `cel/nodejs/src/signatures/standard-library.json`, the file the
//! Node engine reads, read here in place at build time and parsed once per process. It
//! registers through the same [`FunctionRegistry::register`] a host uses, so a standard
//! signature can be replaced or removed. A file this engine cannot read is a defect of
//! the engine, not of any input, and panics naming the entry.

use std::sync::LazyLock;

use crate::cel_type::{CelType, TYPE};
use crate::function_registry::FunctionRegistry;
use crate::json_text_scan::read_json_text;
use crate::json_value::JsonValue;
use crate::signature::{parse_signature, CelSignature, FunctionMetadata};
use crate::type_expression::{parse_type_expression, NominalResolver};

const LIBRARY_TEXT: &str = include_str!("../../nodejs/src/signatures/standard-library.json");

/// The generation of the signature data, which the file itself declares.
pub const STANDARD_LIBRARY_GENERATION: u32 = 1;

const ORIGIN: &str = "standard-library";

/// A constant the standard library declares: its name and the type it reads as.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct StandardConstant {
    pub name: String,
    pub ty: CelType,
    pub description: Option<String>,
}

struct FunctionEntry {
    signature: String,
    deterministic: Option<bool>,
    description: Option<String>,
}

struct OperatorEntry {
    operator: String,
    parameters: Vec<String>,
    returns: String,
}

struct ConstantEntry {
    name: String,
    ty: String,
    description: Option<String>,
}

struct LibraryData {
    type_constants: Vec<String>,
    constants: Vec<ConstantEntry>,
    functions: Vec<FunctionEntry>,
    optional_type_constants: Vec<String>,
    optional_type_operators: Vec<OperatorEntry>,
    optional_type_functions: Vec<FunctionEntry>,
    operators: Vec<OperatorEntry>,
    /// Each symmetric group expanded: every operator over every type, as `(T, T)`.
    symmetric_operators: Vec<OperatorEntry>,
    /// Every cross-numeric operator over every pair.
    cross_numeric_operators: Vec<OperatorEntry>,
}

/// Reads one member of the data, naming where it stands when it is not there.
struct Field<'a> {
    value: &'a JsonValue,
    path: String,
}

impl<'a> Field<'a> {
    fn get(&self, key: &str) -> Field<'a> {
        self.find(key).unwrap_or_else(|| panic!("the standard library's {} has no {key:?}", self.path))
    }

    fn find(&self, key: &str) -> Option<Field<'a>> {
        match self.value {
            JsonValue::Object(entries) => {
                entries.get(key).map(|value| Field { value: &**value, path: format!("{}.{key}", self.path) })
            }
            _ => panic!("the standard library's {} is not an object", self.path),
        }
    }

    fn items(&self) -> Vec<Field<'a>> {
        match self.value {
            JsonValue::Array(items) => items
                .iter()
                .enumerate()
                .map(|(at, value)| Field { value: &**value, path: format!("{}[{at}]", self.path) })
                .collect(),
            _ => panic!("the standard library's {} is not an array", self.path),
        }
    }

    fn text(&self) -> String {
        match self.value {
            JsonValue::String(text) => text.clone(),
            _ => panic!("the standard library's {} is not a string", self.path),
        }
    }

    fn texts(&self) -> Vec<String> {
        self.items().iter().map(Field::text).collect()
    }

    fn flag(&self) -> bool {
        match self.value {
            JsonValue::Bool(flag) => *flag,
            _ => panic!("the standard library's {} is not a boolean", self.path),
        }
    }
}

fn function_entry(field: &Field<'_>) -> FunctionEntry {
    FunctionEntry {
        signature: field.get("signature").text(),
        deterministic: field.find("deterministic").map(|flag| flag.flag()),
        description: field.find("description").map(|text| text.text()),
    }
}

fn operator_entry(field: &Field<'_>) -> OperatorEntry {
    OperatorEntry {
        operator: field.get("operator").text(),
        parameters: field.get("parameters").texts(),
        returns: field.get("returns").text(),
    }
}

fn read_library() -> LibraryData {
    let root_value = read_json_text(LIBRARY_TEXT).unwrap_or_else(|cause| panic!("the standard library is not JSON: {cause}"));
    let root = Field { value: &root_value, path: "file".into() };
    match root.get("generation").value {
        JsonValue::Number(generation) if *generation == f64::from(STANDARD_LIBRARY_GENERATION) => {}
        _ => panic!("the standard library's generation is not {STANDARD_LIBRARY_GENERATION}"),
    }
    let mut symmetric_operators = Vec::new();
    for group in root.get("symmetricOperators").items() {
        let returns = group.get("returns").text();
        let types = group.get("types").texts();
        for operator in group.get("operators").texts() {
            for ty in &types {
                symmetric_operators.push(OperatorEntry {
                    operator: operator.clone(),
                    parameters: vec![ty.clone(), ty.clone()],
                    returns: returns.clone(),
                });
            }
        }
    }
    let cross = root.get("crossNumericOperators");
    let returns = cross.get("returns").text();
    let pairs: Vec<Vec<String>> = cross.get("pairs").items().iter().map(Field::texts).collect();
    let mut cross_numeric_operators = Vec::new();
    for operator in cross.get("operators").texts() {
        for pair in &pairs {
            cross_numeric_operators.push(OperatorEntry {
                operator: operator.clone(),
                parameters: pair.clone(),
                returns: returns.clone(),
            });
        }
    }
    LibraryData {
        type_constants: root.get("typeConstants").texts(),
        constants: root
            .get("constants")
            .items()
            .iter()
            .map(|entry| ConstantEntry {
                name: entry.get("name").text(),
                ty: entry.get("type").text(),
                description: entry.find("description").map(|text| text.text()),
            })
            .collect(),
        functions: root.get("functions").items().iter().map(function_entry).collect(),
        optional_type_constants: root.get("optionalTypeConstants").texts(),
        optional_type_operators: root.get("optionalTypeOperators").items().iter().map(operator_entry).collect(),
        optional_type_functions: root.get("optionalTypeFunctions").items().iter().map(function_entry).collect(),
        operators: root.get("operators").items().iter().map(operator_entry).collect(),
        symmetric_operators,
        cross_numeric_operators,
    }
}

static LIBRARY: LazyLock<LibraryData> = LazyLock::new(read_library);

/// Every name the library declares as a constant: the type names (`int`, `list`, …),
/// each of type `type`, and `google`, through which the well-known type names are read.
pub fn standard_constants(optional_types: bool) -> Vec<StandardConstant> {
    let data = &*LIBRARY;
    let optional: &[String] = if optional_types { &data.optional_type_constants } else { &[] };
    let types = data.type_constants.iter().chain(optional).map(|name| StandardConstant {
        name: name.clone(),
        ty: TYPE,
        description: None,
    });
    let named = data.constants.iter().map(|entry| StandardConstant {
        name: entry.name.clone(),
        ty: parse_type_expression(&entry.ty, None)
            .unwrap_or_else(|cause| panic!("the standard library's constant {:?} has no type: {cause}", entry.name)),
        description: entry.description.clone(),
    });
    types.chain(named).collect()
}

/// The value `google` reads as: the two well-known type names, by the namespace under
/// `google` that holds them.
pub fn google_type_names() -> &'static [(&'static str, &'static [&'static str])] {
    &[("protobuf", &["Duration", "Timestamp"])]
}

/// What [`register_standard_library`] registers.
#[derive(Clone, Copy, Default)]
pub struct StandardLibraryOptions<'a> {
    /// Whether the optional-type members are registered.
    pub optional_types: bool,
    /// Resolves a name the data mentions that the language does not define.
    pub resolve_nominal: Option<&'a NominalResolver<'a>>,
}

fn metadata_of(entry: &FunctionEntry) -> FunctionMetadata {
    FunctionMetadata {
        deterministic: entry.deterministic.unwrap_or(true),
        origin: Some(ORIGIN.into()),
        description: entry.description.clone(),
        ..FunctionMetadata::default()
    }
}

fn register_function_data(registry: &mut FunctionRegistry, entry: &FunctionEntry, resolver: Option<&NominalResolver<'_>>) {
    let signature = parse_signature(&entry.signature, resolver)
        .unwrap_or_else(|cause| panic!("the standard library's {:?} does not read: {cause}", entry.signature));
    registry
        .register(signature, metadata_of(entry))
        .unwrap_or_else(|cause| panic!("the standard library's {:?} is refused: {cause}", entry.signature));
}

fn register_operator_data(registry: &mut FunctionRegistry, entry: &OperatorEntry) {
    let read = |text: &str| {
        parse_type_expression(text, None)
            .unwrap_or_else(|cause| panic!("the standard library's operator {:?} does not read: {cause}", entry.operator))
    };
    let signature = CelSignature {
        name: entry.operator.clone(),
        receiver: None,
        parameters: entry.parameters.iter().map(|text| read(text)).collect(),
        returns: read(&entry.returns),
    };
    let metadata = FunctionMetadata { deterministic: true, origin: Some(ORIGIN.into()), ..FunctionMetadata::default() };
    registry
        .register(signature, metadata)
        .unwrap_or_else(|cause| panic!("the standard library's operator {:?} is refused: {cause}", entry.operator));
}

/// Registers the library onto a registry: its functions, the optional-type members
/// where asked, its operators, the symmetric groups and the cross-numeric ones.
pub fn register_standard_library(registry: &mut FunctionRegistry, options: StandardLibraryOptions<'_>) {
    let data = &*LIBRARY;
    for entry in &data.functions {
        register_function_data(registry, entry, options.resolve_nominal);
    }
    if options.optional_types {
        for entry in &data.optional_type_functions {
            register_function_data(registry, entry, options.resolve_nominal);
        }
        for entry in &data.optional_type_operators {
            register_operator_data(registry, entry);
        }
    }
    for entry in data.operators.iter().chain(&data.symmetric_operators).chain(&data.cross_numeric_operators) {
        register_operator_data(registry, entry);
    }
}

/// Every signature of the library as text.
pub fn standard_library_signatures() -> Vec<String> {
    let data = &*LIBRARY;
    data.functions.iter().chain(&data.optional_type_functions).map(|entry| entry.signature.clone()).collect()
}
