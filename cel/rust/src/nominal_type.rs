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

use std::fmt;
use std::sync::Arc;

use telorun_cel_value::{json_quote, PropertyMap};

use crate::cel_type::{parameter_of, CelType, NominalType, TypeFields, DYN};
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
    pub description: Option<String>,
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
#[derive(Clone, Debug)]
pub(crate) struct RegisteredType {
    pub(crate) definition: NominalTypeDefinition,
    pub(crate) base: CelType,
    /// The type with its own parameters applied — what `Self` resolves to.
    pub(crate) self_type: NominalType,
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
) -> Result<RegisteredType, CelTypeRegistrationError> {
    validate_type_name(&definition.name)?;
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
    Ok(RegisteredType { definition: definition.clone(), base, self_type })
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

/// The operator declarations a definition implies, its comparisons expanded.
pub(crate) fn nominal_operators(definition: &NominalTypeDefinition) -> Vec<NominalOperatorDeclaration> {
    let comparisons = definition.comparisons.iter().map(|operator| NominalOperatorDeclaration {
        operator: operator.clone(),
        parameters: vec!["Self".into(), "Self".into()],
        returns: "bool".into(),
    });
    definition.operators.iter().cloned().chain(comparisons).collect()
}
