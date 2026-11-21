//! What a construction `Name{field: value, …}` names, and every refusal of one — decided
//! once, for the checker and the evaluator — `construction.ts`.
//!
//! A construction's name is resolved against the **registered types alone**, by its whole
//! dotted text: no variable, binding or container takes part, so `.Name{…}` names exactly
//! what `Name{…}` does. Only a type that opted in with `constructible` is built; a language
//! type, a well-known type and a registered type without the opt-in are refused, each in
//! its own words, and a name nothing registers is unknown whatever the environment says
//! about undeclared variables — nothing can be constructed from `dyn`.
//!
//! The checker reports a refusal as a diagnostic and the evaluator answers it as an error
//! value, with the same sentence, because both read it here.
//!
//! Declared differently from the Node file:
//! - `ConstructionTypes` is a struct of what the environment holds rather than four
//!   functions, and `ConstructionTarget` is a `Result`.

use std::collections::HashSet;
use std::sync::Arc;

use telorun_cel_value::{compare_code_units, json_quote};

use crate::cel_type::{format_type, CelType, NominalType, WELL_KNOWN_TYPE_NAMES};
use crate::check_diagnostic::CelCheckCode;
use crate::function_registry::{nearest_candidates, FunctionRegistry, RegisteredFunction};
use crate::nominal_type::RegisteredType;
use crate::signature::{signature_key, CelSignature, FunctionMetadata};
use crate::standard_library::language_type_names;

/// The protobuf well-known messages under `google.protobuf.`, which a protobuf type provider
/// would build and this engine has none of. `NullValue` is an enum, not a message.
const PROTOBUF_MESSAGES: [&str; 17] = [
    "Any",
    "BoolValue",
    "BytesValue",
    "DoubleValue",
    "Duration",
    "Empty",
    "FieldMask",
    "FloatValue",
    "Int32Value",
    "Int64Value",
    "ListValue",
    "StringValue",
    "Struct",
    "Timestamp",
    "UInt32Value",
    "UInt64Value",
    "Value",
];

/// What resolving a construction reads of an environment.
pub(crate) struct ConstructionTypes<'e> {
    /// Every registered type, in registration order.
    pub(crate) types: &'e [RegisteredType],
    /// The type registered under a name, if any.
    pub(crate) registered_type: Box<dyn Fn(&str) -> Option<&'e RegisteredType> + 'e>,
    /// Whether the optional library's type names are the language's.
    pub(crate) optional_types: bool,
    /// Every registered function, for naming where a value of a type comes from.
    pub(crate) registry: &'e FunctionRegistry,
}

/// Why a construction builds no value.
#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) struct ConstructionRefusal {
    pub(crate) code: CelCheckCode,
    pub(crate) message: String,
}

/// The type a construction builds, or why it builds none.
pub(crate) fn construction_target<'e>(
    name: &str,
    types: &ConstructionTypes<'e>,
) -> Result<&'e RegisteredType, ConstructionRefusal> {
    let not_constructible = |message: String| ConstructionRefusal { code: CelCheckCode::TypeNotConstructible, message };
    if let Some(registered) = (types.registered_type)(name) {
        if registered.constructible {
            return Ok(registered);
        }
        return Err(not_constructible(format!(
            "{} is a registered type that does not allow construction{}",
            json_quote(name),
            producers(name, types)
        )));
    }
    if language_type_names(types.optional_types).any(|language| language == name) {
        return Err(not_constructible(format!(
            "{} is a language type and has no fields; write a literal or a conversion",
            json_quote(name)
        )));
    }
    if name.strip_prefix("google.protobuf.").is_some_and(|message| PROTOBUF_MESSAGES.contains(&message)) {
        let instead = WELL_KNOWN_TYPE_NAMES
            .iter()
            .find(|(well_known, _)| *well_known == name)
            .map(|(_, primitive)| format!("; write {}(…) instead", primitive.as_str()))
            .unwrap_or_default();
        return Err(not_constructible(format!(
            "{} is a protobuf message and no protobuf type provider is present{instead}",
            json_quote(name)
        )));
    }
    let constructible: Vec<&str> =
        types.types.iter().filter(|held| held.constructible).map(|held| held.definition.name.as_str()).collect();
    let nearest = nearest_candidates(name, constructible, |candidate: &&str| *candidate, |candidate: &&str| *candidate);
    let closest = if nearest.is_empty() { String::new() } else { format!(" — the closest constructible: {}", nearest.join(", ")) };
    Err(ConstructionRefusal {
        code: CelCheckCode::UnknownType,
        message: format!("no type named {} is registered{closest}", json_quote(name)),
    })
}

/// Where a value of a type that cannot be constructed comes from: the functions answering one.
fn producers(name: &str, types: &ConstructionTypes<'_>) -> String {
    let listed = types.registry.list();
    let returning: Vec<(&str, String)> = listed
        .iter()
        .filter(|entry| matches!(&entry.signature.returns, CelType::Nominal(nominal) if &*nominal.name == name))
        .map(|entry| (entry.signature.name.as_str(), signature_key(&entry.signature)))
        .collect();
    let nearest = nearest_candidates(
        name,
        returning,
        |candidate: &(&str, String)| candidate.0,
        |candidate: &(&str, String)| candidate.1.as_str(),
    );
    if nearest.is_empty() {
        return String::new();
    }
    let keys: Vec<String> = nearest.into_iter().map(|(_, key)| key).collect();
    format!(" — the closest functions returning it: {}", keys.join(", "))
}

fn declared_fields(ty: &NominalType) -> Vec<&str> {
    ty.fields.as_ref().expect("a type read by field declares its fields").keys().collect()
}

/// A field the type does not declare — the same sentence a read of one is refused with.
pub(crate) fn unknown_field_message(ty: &NominalType, field: &str) -> String {
    format!(
        "{} is not a field of {} (fields: {})",
        json_quote(field),
        format_type(&CelType::Nominal(ty.clone()), false),
        declared_fields(ty).join(", ")
    )
}

pub(crate) fn duplicate_field_message(ty: &NominalType, field: &str) -> String {
    format!("field {} of {} is written more than once", json_quote(field), format_type(&CelType::Nominal(ty.clone()), false))
}

/// The first field a construction writes that its type refuses, in source order: where it
/// stands among the fields written, and why.
pub(crate) fn written_field_refusal(ty: &NominalType, fields: &[&str]) -> Option<(usize, String)> {
    let declared = ty.fields.as_ref().expect("a constructible type declares its fields");
    let mut seen: HashSet<&str> = HashSet::new();
    for (at, field) in fields.iter().enumerate() {
        if !seen.insert(field) {
            return Some((at, duplicate_field_message(ty, field)));
        }
        if declared.get(field).is_none() {
            return Some((at, unknown_field_message(ty, field)));
        }
    }
    None
}

/// A written field value whose runtime type the field's declared type does not admit;
/// `held` is the value's type name, nothing for a value of no CEL type.
pub(crate) fn field_value_refusal_message(ty: &NominalType, field: &str, declared: &CelType, held: Option<&str>) -> String {
    let value = match held {
        Some(name) => format!("is {name}"),
        None => "is of no CEL type".into(),
    };
    format!(
        "field {} of {} is {}, and this value {value}",
        json_quote(field),
        format_type(&CelType::Nominal(ty.clone()), false),
        format_type(declared, false)
    )
}

// --- equality over a constructible type ----------------------------------------------

/// The constructible type an `==` or `!=` registration would compare values of, first by
/// name in code-unit order: a type either parameter accepts at top level — the type itself,
/// `dyn`, a bare type parameter, or a union with a member that does. A container parameter
/// is not read inside. Such a registration is refused, because a constructible type's
/// equality is its fields' and nothing a host registers may answer it instead.
pub(crate) fn compared_constructible<'n>(signature: &CelSignature, constructible: &[&'n str]) -> Option<&'n str> {
    if signature.receiver.is_some() || (signature.name != "==" && signature.name != "!=") || signature.parameters.len() != 2 {
        return None;
    }
    let mut names: Vec<&'n str> = constructible.to_vec();
    names.sort_by(|left, right| compare_code_units(left, right));
    names.into_iter().find(|name| signature.parameters.iter().any(|parameter| accepts_at_top(parameter, name)))
}

fn accepts_at_top(parameter: &CelType, name: &str) -> bool {
    match parameter {
        CelType::Dyn | CelType::Parameter(_) => true,
        CelType::Nominal(nominal) => &*nominal.name == name,
        CelType::Union(union) => union.members().iter().any(|member| accepts_at_top(member, name)),
        _ => false,
    }
}

/// Whether a registration is one of the `(Self, Self)` comparisons a type declares of itself.
pub(crate) fn is_own_comparison(signature: &CelSignature, metadata: &FunctionMetadata, name: &str) -> bool {
    metadata.origin.as_deref() == Some(format!("type:{name}").as_str())
        && signature.parameters.len() == 2
        && signature.parameters.iter().all(|parameter| matches!(parameter, CelType::Nominal(nominal) if &*nominal.name == name))
}

/// The registration, first by signature key in code-unit order, that would compare values
/// of `name` — every `==` and `!=` but the comparisons the type declares of itself.
pub(crate) fn equality_comparing(registrations: &[Arc<RegisteredFunction>], name: &str) -> Option<CelSignature> {
    let mut comparing: Vec<(String, &CelSignature)> = registrations
        .iter()
        .filter(|entry| !is_own_comparison(&entry.signature, &entry.metadata, name))
        .filter(|entry| compared_constructible(&entry.signature, &[name]).is_some())
        .map(|entry| (signature_key(&entry.signature), &entry.signature))
        .collect();
    comparing.sort_by(|left, right| compare_code_units(&left.0, &right.0));
    comparing.into_iter().next().map(|(_, signature)| signature.clone())
}

pub(crate) fn equality_registration_refusal(signature: &CelSignature, ty: &str) -> String {
    format!(
        "{} cannot be registered: it would compare values of {ty}, which is constructible, and a constructible type's values are equal exactly when their fields are; normalise the fields in its builder, or register {ty} without constructible",
        signature_key(signature)
    )
}

pub(crate) fn constructible_equality_refusal(ty: &str, signature: &CelSignature) -> String {
    format!(
        "{ty} cannot be constructible: {} is registered and would compare its values, and a constructible type's values are equal exactly when their fields are",
        signature_key(signature)
    )
}
