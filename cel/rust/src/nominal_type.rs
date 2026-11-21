//! Named types a host registers — `nominal-type.ts`.
//!
//! A named type is a name over a base, with its own operators, comparisons, conversions
//! and members, and invariant type parameters. It is not its base: only what its
//! definition declares applies to it. `Self` inside a definition names the type being
//! defined, with its own parameters applied.
//!
//! Node items with no twin in this file:
//! - `RegisteredType` as a public type — nothing public yields one; the environment's
//!   record of a registered type is crate-private here.
//! - `RegisteredType.fieldNames` — the member-read seam's lookup, arriving with
//!   evaluation.
//!
//! Declared differently from the Node file:
//! - `CelConstruct` is handed the written fields as a [`PropertyMap`], where Node's is
//!   handed a plain object.

use std::fmt;
use std::sync::Arc;

use telorun_cel_value::{json_quote, CelValue, PropertyMap};

use crate::cel_type::{parameter_of, CelType, NominalType, TypeFields, DYN};
use crate::runtime_library::CelCallContext;
use crate::type_expression::{is_parameter_name, parse_type_expression, CelTypeTextError, NominalResolver};

#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct NominalOperatorDeclaration {
    pub operator: String,
    /// Type expressions; `Self` names the type being defined.
    pub parameters: Vec<String>,
    pub returns: String,
}

/// What a host declares a named type with. Written with `..Default::default()`.
#[derive(Clone, PartialEq, Debug, Default)]
pub struct NominalTypeDefinition {
    pub name: String,
    /// The type expression a value of this type is, underneath.
    pub base: String,
    /// Invariant type parameter names, each a single capital letter.
    pub parameters: Vec<String>,
    /// Operators over the type, written with `Self`.
    pub operators: Vec<NominalOperatorDeclaration>,
    /// Operator symbols to register as `(Self, Self): bool`.
    pub comparisons: Vec<String>,
    /// Conversion signatures, e.g. `string(Self): string`.
    pub conversions: Vec<String>,
    /// Member signatures, e.g. `Self.scaled(int): Self`.
    pub members: Vec<String>,
    /// The fields a value of the type carries, each a type expression. Absent is not
    /// empty: a type with no `fields` holds no members at all.
    pub fields: Option<PropertyMap<String>>,
    /// Whether an expression may build a value of the type from its fields —
    /// `Name{field: v}`. The type must declare `fields` (an empty set is a type with none)
    /// and no `parameters`. Its values then compare field by field, and no `==` or `!=` a
    /// host registers may compare them instead.
    pub constructible: bool,
    /// The fields a construction must write; each one the type declares, on a
    /// constructible type only.
    pub required: Vec<String>,
    pub description: Option<String>,
}

/// Builds a value of a constructible type from the fields a construction wrote, unset ones
/// left out: a value of the type, or a CEL error value refusing them. The call context
/// comes first, as a registered implementation's does, so its range is the construction's.
pub type CelConstruct = Arc<dyn Fn(&CelCallContext, &PropertyMap<CelValue>) -> CelValue + Send + Sync>;

/// What a host supplies with a type beside its definition. Written with
/// `..Default::default()`.
#[derive(Clone, Default)]
pub struct RegisterTypeOptions {
    /// The builder of a constructible type's values; without one the engine builds them
    /// itself.
    pub construct: Option<CelConstruct>,
}

impl fmt::Debug for RegisterTypeOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RegisterTypeOptions").field("construct", &self.construct.as_ref().map(|_| "…")).finish()
    }
}

/// A named type's definition that cannot be registered.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct CelTypeRegistrationError {
    pub message: String,
}

impl fmt::Display for CelTypeRegistrationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CelTypeRegistrationError {}

pub(crate) fn registration_error(message: String) -> CelTypeRegistrationError {
    CelTypeRegistrationError { message }
}

const LANGUAGE_NAMES: [&str; 15] = [
    "dyn",
    "int",
    "uint",
    "double",
    "bool",
    "string",
    "bytes",
    "null",
    "null_type",
    "type",
    "list",
    "map",
    "optional",
    "timestamp",
    "duration",
];

fn starts_a_name(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || byte == b'_'
}

fn is_type_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && starts_a_name(bytes[0])
        && bytes[1..].iter().all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_' || *byte == b'.')
}

fn is_field_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty() && starts_a_name(bytes[0]) && bytes[1..].iter().all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
}

/// A registered named type: its definition, its base, and the type `Self` names.
#[derive(Clone)]
pub(crate) struct RegisteredType {
    pub(crate) definition: NominalTypeDefinition,
    pub(crate) base: CelType,
    /// The type with its own parameters applied — what `Self` resolves to.
    pub(crate) self_type: NominalType,
    /// Whether an expression may construct a value of it.
    pub(crate) constructible: bool,
    /// The fields a construction must write, in the order the definition lists them.
    pub(crate) required: Vec<String>,
    /// The host's builder, where it supplied one.
    pub(crate) construct: Option<CelConstruct>,
}

impl RegisteredType {
    pub(crate) fn parameters(&self) -> &[String] {
        &self.definition.parameters
    }
}

pub(crate) fn validate_type_name(name: &str) -> Result<(), CelTypeRegistrationError> {
    if !is_type_name(name) {
        return Err(registration_error(format!("{} is not spelled as a type name", json_quote(name))));
    }
    if LANGUAGE_NAMES.contains(&name) {
        return Err(registration_error(format!(
            "{} is a type of the language and cannot be redefined",
            json_quote(name)
        )));
    }
    if is_parameter_name(name) {
        return Err(registration_error(format!(
            "{} is a single capital letter, which a signature reads as a type parameter",
            json_quote(name)
        )));
    }
    Ok(())
}

/// A named type with these arguments, or with its own parameters where none are given.
pub(crate) fn with_arguments(self_type: &NominalType, args: &[CelType]) -> CelType {
    CelType::Nominal(NominalType {
        args: if args.is_empty() { Arc::clone(&self_type.args) } else { args.to_vec().into() },
        ..self_type.clone()
    })
}

/// Builds the registered form of a definition. `resolver` resolves the names its base
/// and fields mention other than its own.
pub(crate) fn build_registered_type(
    definition: &NominalTypeDefinition,
    resolver: &NominalResolver<'_>,
    options: &RegisterTypeOptions,
) -> Result<RegisteredType, CelTypeRegistrationError> {
    validate_type_name(&definition.name)?;
    validate_construction(definition, options)?;
    for parameter in &definition.parameters {
        if !is_parameter_name(parameter) {
            return Err(registration_error(format!(
                "type parameter {} of {} must be a single capital letter",
                json_quote(parameter),
                definition.name
            )));
        }
    }
    let unresolved = NominalType {
        name: definition.name.as_str().into(),
        base: Arc::new(DYN),
        args: definition.parameters.iter().map(|parameter| parameter_of(parameter)).collect::<Vec<_>>().into(),
        fields: None,
    };
    let with_self = |name: &str, args: &[CelType]| {
        if name == "Self" || name == definition.name {
            Ok(Some(with_arguments(&unresolved, args)))
        } else {
            resolver(name, args)
        }
    };
    let base = parse_type_expression(&definition.base, Some(&with_self)).map_err(|cause| {
        registration_error(format!("the base of {} does not read as a type: {cause}", definition.name))
    })?;
    let fields = match &definition.fields {
        None => None,
        Some(declared) => Some(read_fields(definition, declared, &with_self)?),
    };
    let self_type = NominalType { base: Arc::new(base.clone()), fields, ..unresolved.clone() };
    let mut required: Vec<String> = Vec::new();
    for field in &definition.required {
        if !required.contains(field) {
            required.push(field.clone());
        }
    }
    Ok(RegisteredType {
        definition: definition.clone(),
        base,
        self_type,
        constructible: definition.constructible,
        required,
        construct: options.construct.clone(),
    })
}

/// What a constructible type must be: one with fields to write and no type parameters, the
/// syntax having no place for a type argument. A required field must be a declared one of a
/// type that can be constructed, and so must a builder.
fn validate_construction(
    definition: &NominalTypeDefinition,
    options: &RegisterTypeOptions,
) -> Result<(), CelTypeRegistrationError> {
    let name = &definition.name;
    if definition.constructible {
        if definition.fields.is_none() {
            return Err(registration_error(format!(
                "{name} is constructible and declares no fields; declare `fields`, an empty set for a type with none"
            )));
        }
        if !definition.parameters.is_empty() {
            return Err(registration_error(format!(
                "{name} is constructible and takes type parameters, which a construction has no place to write"
            )));
        }
    } else if !definition.required.is_empty() {
        return Err(registration_error(format!("{name} lists required fields and is not constructible")));
    }
    for field in &definition.required {
        if !definition.fields.as_ref().is_some_and(|fields| fields.contains_key(field)) {
            return Err(registration_error(format!(
                "required field {} of {name} is not one of its fields",
                json_quote(field)
            )));
        }
    }
    if options.construct.is_some() && !definition.constructible {
        return Err(registration_error(format!("{name} is given a builder and is not constructible")));
    }
    Ok(())
}

fn read_fields(
    definition: &NominalTypeDefinition,
    declared: &PropertyMap<String>,
    resolver: &NominalResolver<'_>,
) -> Result<TypeFields, CelTypeRegistrationError> {
    let mut fields = TypeFields::new();
    for (name, text) in declared.iter() {
        if !is_field_name(name) {
            return Err(registration_error(format!(
                "field {} of {} is not spelled as a name",
                json_quote(name),
                definition.name
            )));
        }
        let ty = parse_type_expression(text, Some(resolver)).map_err(|cause: CelTypeTextError| {
            registration_error(format!(
                "field {} of {} does not read as a type: {cause}",
                json_quote(name),
                definition.name
            ))
        })?;
        fields.insert(name, ty);
    }
    Ok(fields)
}

/// The signatures a definition declares, as text, in registration order.
pub(crate) fn nominal_signatures(definition: &NominalTypeDefinition) -> impl Iterator<Item = &String> {
    definition.conversions.iter().chain(definition.members.iter())
}

/// The operator declarations a definition implies, its comparisons expanded. A
/// constructible type is compared by `==` and `!=` whether or not it lists them: its values
/// are its fields, which the engine's equality compares.
pub(crate) fn nominal_operators(definition: &NominalTypeDefinition) -> Vec<NominalOperatorDeclaration> {
    let implied: &[&str] = if definition.constructible { &["==", "!="] } else { &[] };
    let mut listed: Vec<&str> = Vec::new();
    for operator in implied.iter().copied().chain(definition.comparisons.iter().map(String::as_str)) {
        if !listed.contains(&operator) {
            listed.push(operator);
        }
    }
    let comparisons = listed.into_iter().map(|operator| NominalOperatorDeclaration {
        operator: operator.into(),
        parameters: vec!["Self".into(), "Self".into()],
        returns: "bool".into(),
    });
    definition.operators.iter().cloned().chain(comparisons).collect()
}
