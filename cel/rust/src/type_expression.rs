//! Types as text: `list<int>`, `map<string, int>`, `optional<T>`, `Money<string>` —
//! `type-expression.ts`.
//!
//! One grammar reads a variable's declared type and every type in a signature, and it
//! is the spelling [`format_type`](crate::format_type) writes. A bare capital letter is
//! a type parameter; a name the host registered resolves through its resolver; any
//! other name is refused as a [`CelUnknownTypeNameError`].
//!
//! The reader keeps its open `<` lists on the heap, so nesting costs no stack. It skips
//! only the space character between tokens, as Node's does.
//!
//! Declared here and not in the Node file:
//! - [`CelTypeTextError`] — the three errors reading type text can answer, which Node
//!   throws as three classes.

use std::fmt;

use telorun_cel_value::json_quote;

use crate::cel_type::{
    list_of, map_of, optional_of, parameter_of, CelType, BOOL, BYTES, DOUBLE, DURATION, DYN, INT,
    NULL, STRING, TIMESTAMP, TYPE, UINT, WELL_KNOWN_TYPE_NAMES,
};
use crate::nominal_type::CelTypeRegistrationError;

/// Text this grammar cannot read.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct CelTypeExpressionError {
    pub message: String,
}

impl fmt::Display for CelTypeExpressionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CelTypeExpressionError {}

/// A well-formed type expression naming a type nothing is registered under.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct CelUnknownTypeNameError {
    /// The name nothing is registered under.
    pub type_name: String,
}

impl fmt::Display for CelUnknownTypeNameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "no type is registered under the name {}", json_quote(&self.type_name))
    }
}

impl std::error::Error for CelUnknownTypeNameError {}

/// Why type text did not read as a type.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum CelTypeTextError {
    Expression(CelTypeExpressionError),
    UnknownName(CelUnknownTypeNameError),
    /// The host's resolver refused the name — a named type given the wrong number of
    /// type arguments.
    Registration(CelTypeRegistrationError),
}

impl fmt::Display for CelTypeTextError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CelTypeTextError::Expression(error) => error.fmt(f),
            CelTypeTextError::UnknownName(error) => error.fmt(f),
            CelTypeTextError::Registration(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for CelTypeTextError {}

impl From<CelTypeExpressionError> for CelTypeTextError {
    fn from(error: CelTypeExpressionError) -> Self {
        CelTypeTextError::Expression(error)
    }
}

impl From<CelUnknownTypeNameError> for CelTypeTextError {
    fn from(error: CelUnknownTypeNameError) -> Self {
        CelTypeTextError::UnknownName(error)
    }
}

impl From<CelTypeRegistrationError> for CelTypeTextError {
    fn from(error: CelTypeRegistrationError) -> Self {
        CelTypeTextError::Registration(error)
    }
}

/// What a name that is neither a primitive nor a parameter resolves to: a type, nothing
/// (the name is unknown), or a refusal.
pub type NominalResolver<'a> = dyn Fn(&str, &[CelType]) -> Result<Option<CelType>, CelTypeRegistrationError> + 'a;

fn expression_error(message: String) -> CelTypeTextError {
    CelTypeExpressionError { message }.into()
}

fn primitive(name: &str) -> Option<CelType> {
    Some(match name {
        "dyn" => DYN,
        "int" => INT,
        "uint" => UINT,
        "double" => DOUBLE,
        "bool" => BOOL,
        "string" => STRING,
        "bytes" => BYTES,
        "null" | "null_type" => NULL,
        "type" => TYPE,
        "timestamp" => TIMESTAMP,
        "duration" => DURATION,
        _ => return None,
    })
}

pub(crate) fn is_parameter_name(name: &str) -> bool {
    name.len() == 1 && name.as_bytes()[0].is_ascii_uppercase()
}

fn no_arguments(name: &str, args: &[CelType], ty: CelType) -> Result<CelType, CelTypeTextError> {
    if !args.is_empty() {
        return Err(expression_error(format!("{name} takes no type arguments")));
    }
    Ok(ty)
}

fn resolve(name: &str, args: Vec<CelType>, resolver: Option<&NominalResolver<'_>>) -> Result<CelType, CelTypeTextError> {
    if let Some((_, well_known)) = WELL_KNOWN_TYPE_NAMES.iter().find(|(known, _)| *known == name) {
        return no_arguments(name, &args, CelType::Primitive(*well_known));
    }
    let mut args = args;
    match name {
        "list" => {
            return Ok(if args.len() == 1 { list_of(args.pop().expect("one argument")) } else { list_of(DYN) });
        }
        "map" => {
            return Ok(if args.len() == 2 {
                let value = args.pop().expect("two arguments");
                map_of(args.pop().expect("two arguments"), value)
            } else {
                map_of(DYN, DYN)
            });
        }
        "optional" => {
            if args.len() != 1 {
                return Err(expression_error("optional takes exactly one type argument".into()));
            }
            return Ok(optional_of(args.pop().expect("one argument")));
        }
        _ => {}
    }
    if let Some(primitive) = primitive(name) {
        return no_arguments(name, &args, primitive);
    }
    if is_parameter_name(name) {
        return no_arguments(name, &args, parameter_of(name));
    }
    if let Some(resolver) = resolver {
        if let Some(nominal) = resolver(name, &args)? {
            return Ok(nominal);
        }
    }
    Err(CelUnknownTypeNameError { type_name: name.into() }.into())
}

fn is_name_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'.'
}

/// Reads one type expression. `resolver` is asked for every name the language itself
/// does not define, once the name's own arguments are read.
pub fn parse_type_expression(text: &str, resolver: Option<&NominalResolver<'_>>) -> Result<CelType, CelTypeTextError> {
    let bytes = text.as_bytes();
    let mut at = 0;
    let skip_space = |at: &mut usize| {
        while bytes.get(*at) == Some(&b' ') {
            *at += 1;
        }
    };
    // The names whose `<` lists are open, each with the arguments read so far. Every
    // byte the reader moves past is ASCII, so a byte offset is a UTF-16 offset.
    let mut open: Vec<(&str, Vec<CelType>)> = Vec::new();
    let read = 'read: loop {
        skip_space(&mut at);
        let from = at;
        while bytes.get(at).copied().is_some_and(is_name_byte) {
            at += 1;
        }
        if at == from {
            return Err(expression_error(format!("{} names no type at offset {from}", json_quote(text))));
        }
        let name = &text[from..at];
        skip_space(&mut at);
        if bytes.get(at) == Some(&b'<') {
            at += 1;
            open.push((name, Vec::new()));
            continue;
        }
        let mut ty = resolve(name, Vec::new(), resolver)?;
        loop {
            let Some((_, args)) = open.last_mut() else { break 'read ty };
            args.push(ty);
            skip_space(&mut at);
            match bytes.get(at) {
                Some(b',') => {
                    at += 1;
                    continue 'read;
                }
                Some(b'>') => {
                    at += 1;
                    let (name, args) = open.pop().expect("a list is open");
                    ty = resolve(name, args, resolver)?;
                }
                _ => {
                    return Err(expression_error(format!(
                        "{} has no closing '>' for its type arguments",
                        json_quote(text)
                    )))
                }
            }
        }
    };
    skip_space(&mut at);
    if at != bytes.len() {
        return Err(expression_error(format!("{} is not one type expression", json_quote(text))));
    }
    Ok(read)
}
