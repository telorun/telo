//! An environment: what names, functions, types and namespaces an expression is read
//! and checked against — `environment.ts`, its registration, declaration, listing and
//! checking half.
//!
//! Everything is registered the same way, the standard library included, so a host can
//! replace or remove a standard signature. `Clone` inherits everything and then
//! diverges: a registration on the clone leaves the original as it was.
//!
//! Node items with no twin in this file yet, arriving with evaluation: `compile`,
//! `evaluate`, the `compiledCacheCapacity` option, `DEFAULT_COMPILED_CACHE_CAPACITY` and
//! the standard constants' values.
//!
//! Node items with no twin: `emit`, `emittedModule`, `emitterRuntime`, `digest` — there
//! is no emitter here; the refusal "a declaration is a type expression, a field map or a
//! schema" — [`TypeDeclaration`] holds nothing else.
//!
//! Declared here and not in the Node file:
//! - [`CelRegistrationError`] — every refusal a registration answers, which Node throws
//!   as five classes.
//! - [`SignatureDeclaration`], [`NamespaceFunctionForm`], [`WithheldReturns`] — the
//!   shapes Node writes as a union of a string and an object.
//! - [`CelEnvironment::clone_with_options`] — Node's `clone(options)`.
//! - [`CelEnvironment::check_parsed`] — Node's `check` handed a tree; [`CelEnvironment::check`]
//!   is the same handed text, which is never refused.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::Arc;

use telorun_cel_value::{compare_code_units, json_quote, PropertyMap, CEL_VALUE_KEYS};

use crate::cel_expression::{parse_expression, resolved_under, CelExpression, ParseExpressionOptions};
use crate::cel_type::{format_type, is_dyn, CelType, DYN};
use crate::check_diagnostic::{CelEngineError, CelEngineErrorCode};
use crate::checker::{check_expression, CheckResult, CheckerContext, CheckerOptions, NamespaceFunction};
use crate::function_registry::FunctionRegistry;
use crate::json_schema_type::{
    field_map_type, schema_type, FieldDeclaration, JsonSchemaDocument, RecursiveSchemaReference, SchemaConversion,
    SchemaTypeResolver, UnjudgedSchemaNode,
};
use crate::namespace_resolution::{normalize_namespaces, CelNamespaceError};
use crate::nominal_type::{
    build_registered_type, nominal_operators, nominal_signatures, registration_error, with_arguments,
    CelTypeRegistrationError, NominalTypeDefinition, RegisteredType,
};
use crate::parse_limits::CelParseLimits;
use crate::parser::ParseOptions;
use crate::signature::{format_signature, parse_signature, CallForm, CelSignature, FunctionMetadata};
use crate::standard_library::{register_standard_library, standard_constants, StandardLibraryOptions};
use crate::type_expression::{
    parse_type_expression, CelTypeExpressionError, CelTypeTextError, CelUnknownTypeNameError, NominalResolver,
};

/// The options an environment is built under. Two options are equal when their schema
/// resolvers are the same function.
#[derive(Clone)]
pub struct CelEnvironmentOptions {
    /// Whether a name nothing declares reads as `dyn` instead of being reported.
    pub unlisted_variables_are_dyn: bool,
    /// Whether a list or map literal must hold one type.
    pub homogeneous_aggregate_literals: bool,
    /// Whether `.?`, `[?]` and the `optional` members exist.
    pub enable_optional_types: bool,
    /// Asked at every schema node, with the document it belongs to, before its structure
    /// is read: a registered type name, or the document to read in place of the node.
    pub resolve_schema_type: Option<SchemaTypeResolver>,
    pub limits: CelParseLimits,
    /// Whether the standard library is registered. On by default.
    pub standard_library: bool,
}

impl PartialEq for CelEnvironmentOptions {
    fn eq(&self, other: &Self) -> bool {
        self.unlisted_variables_are_dyn == other.unlisted_variables_are_dyn
            && self.homogeneous_aggregate_literals == other.homogeneous_aggregate_literals
            && self.enable_optional_types == other.enable_optional_types
            && match (&self.resolve_schema_type, &other.resolve_schema_type) {
                (None, None) => true,
                (Some(a), Some(b)) => Arc::ptr_eq(a, b),
                _ => false,
            }
            && self.limits == other.limits
            && self.standard_library == other.standard_library
    }
}

impl Eq for CelEnvironmentOptions {}

impl fmt::Debug for CelEnvironmentOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CelEnvironmentOptions")
            .field("unlisted_variables_are_dyn", &self.unlisted_variables_are_dyn)
            .field("homogeneous_aggregate_literals", &self.homogeneous_aggregate_literals)
            .field("enable_optional_types", &self.enable_optional_types)
            .field("resolve_schema_type", &self.resolve_schema_type.as_ref().map(|_| "<resolver>"))
            .field("limits", &self.limits)
            .field("standard_library", &self.standard_library)
            .finish()
    }
}

impl Default for CelEnvironmentOptions {
    fn default() -> Self {
        Self {
            unlisted_variables_are_dyn: false,
            homogeneous_aggregate_literals: false,
            enable_optional_types: false,
            resolve_schema_type: None,
            limits: CelParseLimits::default(),
            standard_library: true,
        }
    }
}

/// The type a variable or a constant is declared with.
#[derive(Clone, PartialEq, Debug)]
pub enum TypeDeclaration {
    /// A type expression.
    Text(String),
    Type(CelType),
    /// A closed record, each field a type expression or a nested field map.
    Fields(PropertyMap<FieldDeclaration>),
    /// A schema with the document it belongs to, read to full depth.
    Schema(JsonSchemaDocument),
}

impl From<&str> for TypeDeclaration {
    fn from(text: &str) -> Self {
        TypeDeclaration::Text(text.into())
    }
}

impl From<String> for TypeDeclaration {
    fn from(text: String) -> Self {
        TypeDeclaration::Text(text)
    }
}

impl From<CelType> for TypeDeclaration {
    fn from(ty: CelType) -> Self {
        TypeDeclaration::Type(ty)
    }
}

impl From<PropertyMap<FieldDeclaration>> for TypeDeclaration {
    fn from(fields: PropertyMap<FieldDeclaration>) -> Self {
        TypeDeclaration::Fields(fields)
    }
}

impl From<JsonSchemaDocument> for TypeDeclaration {
    fn from(document: JsonSchemaDocument) -> Self {
        TypeDeclaration::Schema(document)
    }
}

/// A function's signature, as text or already read.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum SignatureDeclaration {
    Text(String),
    Signature(CelSignature),
}

impl From<&str> for SignatureDeclaration {
    fn from(text: &str) -> Self {
        SignatureDeclaration::Text(text.into())
    }
}

impl From<String> for SignatureDeclaration {
    fn from(text: String) -> Self {
        SignatureDeclaration::Text(text)
    }
}

impl From<CelSignature> for SignatureDeclaration {
    fn from(signature: CelSignature) -> Self {
        SignatureDeclaration::Signature(signature)
    }
}

/// The result a declaration that withholds its parameters names.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum WithheldReturns {
    /// A type expression.
    Text(String),
    Type(CelType),
}

impl From<&str> for WithheldReturns {
    fn from(text: &str) -> Self {
        WithheldReturns::Text(text.into())
    }
}

impl From<CelType> for WithheldReturns {
    fn from(ty: CelType) -> Self {
        WithheldReturns::Type(ty)
    }
}

/// How a namespaced function is declared: whole, as a global signature that arity and
/// arguments are judged against; or by its name and result alone.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum NamespaceFunctionForm {
    Signature(String),
    Withheld { name: String, returns: WithheldReturns },
}

/// A namespaced function a host declares. A type name nothing is registered under is
/// accepted, reads `dyn` and is recorded on the declaration.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct NamespaceFunctionDeclaration {
    pub form: NamespaceFunctionForm,
    pub deterministic: bool,
    pub host_backed: bool,
    pub throws: Option<Vec<String>>,
}

impl NamespaceFunctionDeclaration {
    /// A whole signature, deterministic and engine-backed.
    pub fn signature(text: impl Into<String>) -> Self {
        Self::of(NamespaceFunctionForm::Signature(text.into()))
    }

    /// A name and its result, the parameters withheld, deterministic and engine-backed.
    pub fn withheld(name: impl Into<String>, returns: impl Into<WithheldReturns>) -> Self {
        Self::of(NamespaceFunctionForm::Withheld { name: name.into(), returns: returns.into() })
    }

    fn of(form: NamespaceFunctionForm) -> Self {
        Self { form, deterministic: true, host_backed: false, throws: None }
    }
}

impl From<&str> for NamespaceFunctionDeclaration {
    fn from(text: &str) -> Self {
        Self::signature(text)
    }
}

/// What a host says about a namespace as a whole.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct NamespaceOptions {
    /// Whether names beyond the declared ones are reachable through it: one it did not
    /// declare types `dyn` and is reported by nobody. Closed by default.
    pub open: bool,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct VariableDefinition {
    pub name: String,
    pub ty: CelType,
    pub type_name: String,
    pub description: Option<String>,
    pub constant: bool,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct FunctionDefinition {
    pub name: String,
    pub signature: String,
    /// The receiver type a call is written on, or nothing for a global call.
    pub receiver_type: Option<String>,
    pub parameters: Vec<String>,
    pub returns: String,
    pub deterministic: bool,
    pub host_backed: bool,
    pub throws: Option<Vec<String>>,
    pub description: Option<String>,
    pub origin: Option<String>,
}

#[derive(Clone, PartialEq, Debug)]
pub struct TypeDefinitionListing {
    pub name: String,
    pub base: String,
    pub parameters: Vec<String>,
    /// Each declared field with its type, as printed; absent when it declares none.
    pub fields: Option<PropertyMap<String>>,
    pub description: Option<String>,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct NamespaceListing {
    pub name: String,
    pub functions: Vec<String>,
    pub open: bool,
}

/// Every registration, for a listing a host prints or compares.
#[derive(Clone, PartialEq, Debug)]
pub struct Definitions {
    /// By name, in UTF-16 code-unit order.
    pub variables: Vec<VariableDefinition>,
    /// By name, then in registration order.
    pub functions: Vec<FunctionDefinition>,
    /// In registration order, a re-registered type keeping its first place.
    pub types: Vec<TypeDefinitionListing>,
    /// By name.
    pub namespaces: Vec<NamespaceListing>,
}

/// What converting one registration's schema could not judge.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct SchemaRegistrationReport {
    /// The name registered under.
    pub name: String,
    pub unjudged: Vec<UnjudgedSchemaNode>,
    /// Every reference re-entered on the descent: a recursive schema, deliberately `dyn`.
    pub recursive: Vec<RecursiveSchemaReference>,
}

/// Why a registration was refused.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum CelRegistrationError {
    /// Type text this grammar cannot read.
    Expression(CelTypeExpressionError),
    /// Type text naming a type nothing is registered under.
    UnknownName(CelUnknownTypeNameError),
    /// A named type's definition, or its use, that cannot be registered.
    Registration(CelTypeRegistrationError),
    /// A signature taking more values than an implementation receives.
    Engine(CelEngineError),
    /// A namespace name no host can have.
    Namespace(CelNamespaceError),
}

impl fmt::Display for CelRegistrationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CelRegistrationError::Expression(error) => error.fmt(f),
            CelRegistrationError::UnknownName(error) => error.fmt(f),
            CelRegistrationError::Registration(error) => error.fmt(f),
            CelRegistrationError::Engine(error) => error.fmt(f),
            CelRegistrationError::Namespace(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for CelRegistrationError {}

impl From<CelTypeExpressionError> for CelRegistrationError {
    fn from(error: CelTypeExpressionError) -> Self {
        CelRegistrationError::Expression(error)
    }
}

impl From<CelUnknownTypeNameError> for CelRegistrationError {
    fn from(error: CelUnknownTypeNameError) -> Self {
        CelRegistrationError::UnknownName(error)
    }
}

impl From<CelTypeRegistrationError> for CelRegistrationError {
    fn from(error: CelTypeRegistrationError) -> Self {
        CelRegistrationError::Registration(error)
    }
}

impl From<CelEngineError> for CelRegistrationError {
    fn from(error: CelEngineError) -> Self {
        CelRegistrationError::Engine(error)
    }
}

impl From<CelNamespaceError> for CelRegistrationError {
    fn from(error: CelNamespaceError) -> Self {
        CelRegistrationError::Namespace(error)
    }
}

impl From<CelTypeTextError> for CelRegistrationError {
    fn from(error: CelTypeTextError) -> Self {
        match error {
            CelTypeTextError::Expression(error) => error.into(),
            CelTypeTextError::UnknownName(error) => error.into(),
            CelTypeTextError::Registration(error) => error.into(),
        }
    }
}

#[derive(Clone)]
struct VariableRecord {
    ty: CelType,
    description: Option<String>,
    constant: bool,
    /// What the schema it was typed from could not judge.
    unjudged: Vec<UnjudgedSchemaNode>,
    recursive: Vec<RecursiveSchemaReference>,
}

/// A type a declaration named, beside what converting it could not judge.
struct DeclaredType {
    ty: CelType,
    unjudged: Vec<UnjudgedSchemaNode>,
    recursive: Vec<RecursiveSchemaReference>,
}

impl From<CelType> for DeclaredType {
    fn from(ty: CelType) -> Self {
        Self { ty, unjudged: Vec::new(), recursive: Vec::new() }
    }
}

/// Values by name with JavaScript `Map` semantics: a name set again keeps its place.
#[derive(Clone)]
struct InsertionOrdered<V> {
    order: Vec<V>,
    positions: HashMap<String, usize>,
}

impl<V> Default for InsertionOrdered<V> {
    fn default() -> Self {
        Self { order: Vec::new(), positions: HashMap::new() }
    }
}

impl<V> InsertionOrdered<V> {
    fn set(&mut self, name: &str, value: V) {
        match self.positions.get(name) {
            Some(at) => self.order[*at] = value,
            None => {
                self.positions.insert(name.into(), self.order.len());
                self.order.push(value);
            }
        }
    }

    fn get(&self, name: &str) -> Option<&V> {
        self.positions.get(name).map(|at| &self.order[*at])
    }
}

/// A named type the environment registered resolves with no arguments to its own
/// parameters applied, and with arguments only to as many as it declares.
fn resolve_nominal(
    types: &InsertionOrdered<RegisteredType>,
    name: &str,
    args: &[CelType],
) -> Result<Option<CelType>, CelTypeRegistrationError> {
    let Some(registered) = types.get(name) else { return Ok(None) };
    if args.is_empty() {
        return Ok(Some(CelType::Nominal(registered.self_type.clone())));
    }
    let declared = registered.parameters().len();
    if args.len() != declared {
        return Err(registration_error(format!(
            "{name} takes {declared} type argument{}",
            if declared == 1 { "" } else { "s" }
        )));
    }
    Ok(Some(with_arguments(&registered.self_type, args)))
}

#[derive(Clone)]
pub struct CelEnvironment {
    options: CelEnvironmentOptions,
    registry: FunctionRegistry,
    variables: HashMap<String, VariableRecord>,
    types: InsertionOrdered<RegisteredType>,
    namespace_functions: HashMap<String, InsertionOrdered<NamespaceFunction>>,
    open_namespaces: HashSet<String>,
}

impl Default for CelEnvironment {
    fn default() -> Self {
        Self::new(CelEnvironmentOptions::default())
    }
}

impl CelEnvironment {
    /// An environment holding the standard library unless the options leave it out.
    pub fn new(options: CelEnvironmentOptions) -> Self {
        let standard_library = options.standard_library;
        let optional_types = options.enable_optional_types;
        let mut environment = Self {
            options,
            registry: FunctionRegistry::new(),
            variables: HashMap::new(),
            types: InsertionOrdered::default(),
            namespace_functions: HashMap::new(),
            open_namespaces: HashSet::new(),
        };
        if standard_library {
            let types = &environment.types;
            let resolver = |name: &str, args: &[CelType]| resolve_nominal(types, name, args);
            register_standard_library(
                &mut environment.registry,
                StandardLibraryOptions { optional_types, resolve_nominal: Some(&resolver) },
            );
            for constant in standard_constants(optional_types) {
                environment.variables.insert(
                    constant.name,
                    VariableRecord {
                        ty: constant.ty,
                        description: constant.description,
                        constant: true,
                        unjudged: Vec::new(),
                        recursive: Vec::new(),
                    },
                );
            }
        }
        environment
    }

    /// A clone under other options. Nothing more is registered: on a clone,
    /// `standard_library` and `enable_optional_types` register nothing.
    pub fn clone_with_options(&self, options: CelEnvironmentOptions) -> Self {
        Self { options, ..self.clone() }
    }

    pub fn options(&self) -> &CelEnvironmentOptions {
        &self.options
    }

    // --- registration -----------------------------------------------------------

    fn read_type(&self, text: &str) -> Result<CelType, CelTypeTextError> {
        let types = &self.types;
        let resolver = |name: &str, args: &[CelType]| resolve_nominal(types, name, args);
        parse_type_expression(text, Some(&resolver))
    }

    fn signature_of(&self, signature: SignatureDeclaration) -> Result<CelSignature, CelTypeTextError> {
        match signature {
            SignatureDeclaration::Signature(signature) => Ok(signature),
            SignatureDeclaration::Text(text) => {
                let types = &self.types;
                let resolver = |name: &str, args: &[CelType]| resolve_nominal(types, name, args);
                parse_signature(&text, Some(&resolver))
            }
        }
    }

    /// Registers a function, replacing any registration answering the same call.
    pub fn register_function(
        &mut self,
        signature: impl Into<SignatureDeclaration>,
        metadata: FunctionMetadata,
    ) -> Result<(), CelRegistrationError> {
        let signature = self.signature_of(signature.into())?;
        Ok(self.registry.register(signature, metadata)?)
    }

    /// Removes the one registration answering that call. Answers whether it was there.
    pub fn remove_function(&mut self, signature: impl Into<SignatureDeclaration>) -> Result<bool, CelRegistrationError> {
        let signature = self.signature_of(signature.into())?;
        Ok(self.registry.remove(&signature))
    }

    /// Removes every registration of a name, so a call to it is unknown. Answers how
    /// many went.
    pub fn remove_functions_named(&mut self, name: &str) -> usize {
        self.registry.remove_name(name)
    }

    /// Registers an operator over the types given, replacing one over the same types.
    pub fn register_operator<S: AsRef<str>>(
        &mut self,
        operator: &str,
        parameters: &[S],
        returns: &str,
        metadata: FunctionMetadata,
    ) -> Result<(), CelRegistrationError> {
        let parameters = parameters.iter().map(|text| self.read_type(text.as_ref())).collect::<Result<Vec<_>, _>>()?;
        let returns = self.read_type(returns)?;
        let signature = CelSignature { name: operator.into(), receiver: None, parameters, returns };
        Ok(self.registry.register(signature, metadata)?)
    }

    /// The type a declaration names: a type expression, a type, a field map, or a schema.
    fn declared_type(&self, declaration: TypeDeclaration) -> Result<DeclaredType, CelTypeTextError> {
        match declaration {
            TypeDeclaration::Text(text) => Ok(self.read_type(&text)?.into()),
            TypeDeclaration::Type(ty) => Ok(ty.into()),
            TypeDeclaration::Fields(fields) => Ok(field_map_type(&fields, &|text| self.read_type(text))?.into()),
            TypeDeclaration::Schema(document) => {
                let lookup = |name: &str, args: &[String]| -> Result<Option<CelType>, CelTypeTextError> {
                    let args = args.iter().map(|text| self.read_type(text)).collect::<Result<Vec<_>, _>>()?;
                    Ok(resolve_nominal(&self.types, name, &args)?)
                };
                let converted = schema_type(
                    &document,
                    &SchemaConversion {
                        resolve_schema_type: self.options.resolve_schema_type.clone(),
                        lookup_named_type: Some(&lookup),
                    },
                )?;
                Ok(DeclaredType { ty: converted.ty, unjudged: converted.unjudged, recursive: converted.recursive })
            }
        }
    }

    fn declare(&mut self, name: &str, declared: DeclaredType, description: Option<String>, constant: bool) {
        let DeclaredType { ty, unjudged, recursive } = declared;
        self.variables.insert(name.into(), VariableRecord { ty, description, constant, unjudged, recursive });
    }

    pub fn register_variable(
        &mut self,
        name: &str,
        declaration: impl Into<TypeDeclaration>,
        description: Option<String>,
    ) -> Result<(), CelRegistrationError> {
        let declared = self.declared_type(declaration.into())?;
        self.declare(name, declared, description, false);
        Ok(())
    }

    /// A name whose value never changes; it reads exactly as a variable does.
    pub fn register_constant(
        &mut self,
        name: &str,
        declaration: impl Into<TypeDeclaration>,
        description: Option<String>,
    ) -> Result<(), CelRegistrationError> {
        let declared = self.declared_type(declaration.into())?;
        self.declare(name, declared, description, true);
        Ok(())
    }

    pub fn has_variable(&self, name: &str) -> bool {
        self.variables.contains_key(name)
    }

    /// Every schema-typed registration whose schema could not be judged whole, by name in
    /// UTF-16 code-unit order. Empty is every node judged.
    pub fn schema_reports(&self) -> Vec<SchemaRegistrationReport> {
        let mut held: Vec<(&String, &VariableRecord)> = self
            .variables
            .iter()
            .filter(|(_, record)| !record.unjudged.is_empty() || !record.recursive.is_empty())
            .collect();
        held.sort_by(|left, right| compare_code_units(left.0, right.0));
        held.into_iter()
            .map(|(name, record)| SchemaRegistrationReport {
                name: name.clone(),
                unjudged: record.unjudged.clone(),
                recursive: record.recursive.clone(),
            })
            .collect()
    }

    /// Registers a named type, with every operator, conversion and member it declares.
    ///
    /// The type is held before its signatures are registered, one by one, and a type
    /// registered again keeps the signatures its earlier registration made — so a
    /// signature refused part way leaves the type and the signatures before it, as on
    /// Node.
    pub fn register_type(&mut self, definition: NominalTypeDefinition) -> Result<(), CelRegistrationError> {
        // A value of a named type carries its name under the engine's own value key.
        if CEL_VALUE_KEYS.contains(&definition.name.as_str()) {
            return Err(registration_error(format!(
                "{} is the type key of a value this engine builds",
                json_quote(&definition.name)
            ))
            .into());
        }
        let registered = {
            let types = &self.types;
            let resolver = |name: &str, args: &[CelType]| resolve_nominal(types, name, args);
            build_registered_type(&definition, &resolver)?
        };
        let self_type = registered.self_type.clone();
        self.types.set(&definition.name, registered);
        let origin = format!("type:{}", definition.name);
        let metadata = || FunctionMetadata { deterministic: true, origin: Some(origin.clone()), ..FunctionMetadata::default() };
        for text in nominal_signatures(&definition) {
            let signature = {
                let types = &self.types;
                let resolver = |name: &str, args: &[CelType]| {
                    if name == "Self" {
                        Ok(Some(with_arguments(&self_type, args)))
                    } else {
                        resolve_nominal(types, name, args)
                    }
                };
                parse_signature(text, Some(&resolver))?
            };
            self.registry.register(signature, metadata())?;
        }
        for operator in nominal_operators(&definition) {
            let signature = {
                let types = &self.types;
                let resolver = |name: &str, args: &[CelType]| {
                    if name == "Self" {
                        Ok(Some(with_arguments(&self_type, args)))
                    } else {
                        resolve_nominal(types, name, args)
                    }
                };
                let resolver: &NominalResolver<'_> = &resolver;
                let parameters = operator
                    .parameters
                    .iter()
                    .map(|text| parse_type_expression(text, Some(resolver)))
                    .collect::<Result<Vec<_>, _>>()?;
                let returns = parse_type_expression(&operator.returns, Some(resolver))?;
                CelSignature { name: operator.operator.clone(), receiver: None, parameters, returns }
            };
            self.registry.register(signature, metadata())?;
        }
        Ok(())
    }

    /// Registers a namespace and the functions it declares, replacing what an earlier
    /// registration of the name declared. A namespace is a name that denotes a module
    /// rather than a value, which is what makes `Alias.fn(x)` a qualified call.
    pub fn register_namespace(
        &mut self,
        name: &str,
        functions: Vec<NamespaceFunctionDeclaration>,
        options: NamespaceOptions,
    ) -> Result<(), CelRegistrationError> {
        normalize_namespaces([name])?;
        let mut declared: InsertionOrdered<NamespaceFunction> = InsertionOrdered::default();
        for declaration in functions {
            // A name nothing is registered under is recorded and read as `dyn`.
            let unregistered = std::cell::RefCell::new(Vec::<String>::new());
            let types = &self.types;
            let resolver = |named: &str, args: &[CelType]| {
                if let Some(resolved) = resolve_nominal(types, named, args)? {
                    return Ok(Some(resolved));
                }
                let mut held = unregistered.borrow_mut();
                if !held.iter().any(|recorded| recorded == named) {
                    held.push(named.into());
                }
                Ok(Some(DYN))
            };
            let record = match &declaration.form {
                NamespaceFunctionForm::Signature(text) => {
                    let signature = parse_signature(text, Some(&resolver))?;
                    if signature.form() != CallForm::Global {
                        return Err(registration_error(format!(
                            "a namespaced function is declared without a receiver: {}",
                            json_quote(text)
                        ))
                        .into());
                    }
                    NamespaceFunction {
                        signature: Some(format_signature(&signature)),
                        name: signature.name,
                        returns: signature.returns,
                        parameters: Some(signature.parameters),
                        unregistered_types: unregistered.take(),
                        deterministic: declaration.deterministic,
                        host_backed: declaration.host_backed,
                        throws: declaration.throws.clone(),
                    }
                }
                NamespaceFunctionForm::Withheld { name, returns } => NamespaceFunction {
                    name: name.clone(),
                    returns: match returns {
                        WithheldReturns::Text(text) => parse_type_expression(text, Some(&resolver))?,
                        WithheldReturns::Type(ty) => ty.clone(),
                    },
                    parameters: None,
                    signature: None,
                    unregistered_types: unregistered.take(),
                    deterministic: declaration.deterministic,
                    host_backed: declaration.host_backed,
                    throws: declaration.throws.clone(),
                },
            };
            declared.set(&record.name.clone(), record);
        }
        self.namespace_functions.insert(name.into(), declared);
        if options.open {
            self.open_namespaces.insert(name.into());
        } else {
            self.open_namespaces.remove(name);
        }
        Ok(())
    }

    /// Every namespace registered, in canonical order.
    pub fn namespaces(&self) -> Vec<String> {
        let mut names: Vec<String> = self.namespace_functions.keys().cloned().collect();
        names.sort_by(|left, right| compare_code_units(left, right));
        names
    }

    // --- reading ----------------------------------------------------------------

    /// Reads an expression against this environment's namespaces, with the optional
    /// syntax where optional types are enabled.
    pub fn parse(&self, source: &str) -> CelExpression {
        let options = ParseExpressionOptions {
            parse: ParseOptions { limits: self.options.limits, optional_syntax: self.options.enable_optional_types },
            namespaces: self.namespaces(),
        };
        parse_expression(source, &options).expect("every registered namespace was validated when it was registered")
    }

    /// Checks an expression read against this environment.
    pub fn check(&self, source: &str) -> CheckResult {
        check_expression(&self.parse(source), &self.checker_context())
    }

    /// Checks a tree. A tree resolved under a different namespace set is refused rather
    /// than checked: its qualified calls are not the ones this environment would have
    /// found, so every answer about it would be about a different expression.
    pub fn check_parsed(&self, expression: &CelExpression) -> Result<CheckResult, CelEngineError> {
        let namespaces = self.namespaces();
        let same = resolved_under(expression, &namespaces).expect("every registered namespace was validated when it was registered");
        if !same {
            return Err(CelEngineError {
                code: CelEngineErrorCode::NamespacesMismatch,
                message: format!(
                    "the expression was resolved under [{}] and this environment has [{}]",
                    expression.namespaces.join(", "),
                    namespaces.join(", ")
                ),
            });
        }
        Ok(check_expression(expression, &self.checker_context()))
    }

    fn checker_context(&self) -> CheckerContext<'_> {
        let variables = &self.variables;
        let namespace_functions = &self.namespace_functions;
        let open_namespaces = &self.open_namespaces;
        CheckerContext {
            registry: &self.registry,
            variable: Box::new(move |name| variables.get(name).map(|record| &record.ty)),
            declared_variable_names: Box::new(move || variables.keys().map(String::as_str).collect()),
            namespace_function: Box::new(move |namespace, name| namespace_functions.get(namespace)?.get(name)),
            namespace_is_open: Box::new(move |namespace| open_namespaces.contains(namespace)),
            options: CheckerOptions {
                unlisted_variables_are_dyn: self.options.unlisted_variables_are_dyn,
                homogeneous_aggregate_literals: self.options.homogeneous_aggregate_literals,
                enable_optional_types: self.options.enable_optional_types,
            },
        }
    }

    /// Whether a value of this type converts to text by the environment's own
    /// `string()`. `dyn` passes, because only the runtime knows what it holds.
    pub fn converts_to_string(&self, ty: &CelType) -> bool {
        is_dyn(ty) || self.registry.resolve("string", CallForm::Global, std::slice::from_ref(ty), None).is_ok()
    }

    /// Every registration, for a listing a host prints or compares.
    pub fn definitions(&self) -> Definitions {
        let mut variables: Vec<(&String, &VariableRecord)> = self.variables.iter().collect();
        variables.sort_by(|left, right| compare_code_units(left.0, right.0));
        Definitions {
            variables: variables
                .into_iter()
                .map(|(name, held)| VariableDefinition {
                    name: name.clone(),
                    ty: held.ty.clone(),
                    type_name: format_type(&held.ty, true),
                    description: held.description.clone(),
                    constant: held.constant,
                })
                .collect(),
            functions: self
                .registry
                .list()
                .iter()
                .map(|entry| FunctionDefinition {
                    name: entry.signature.name.clone(),
                    signature: format_signature(&entry.signature),
                    receiver_type: entry.signature.receiver.as_ref().map(|receiver| format_type(receiver, false)),
                    parameters: entry.signature.parameters.iter().map(|ty| format_type(ty, false)).collect(),
                    returns: format_type(&entry.signature.returns, false),
                    deterministic: entry.metadata.deterministic,
                    host_backed: entry.metadata.host_backed,
                    throws: entry.metadata.throws.clone(),
                    description: entry.metadata.description.clone(),
                    origin: entry.metadata.origin.clone(),
                })
                .collect(),
            types: self
                .types
                .order
                .iter()
                .map(|registered| TypeDefinitionListing {
                    name: registered.definition.name.clone(),
                    base: format_type(&registered.base, false),
                    parameters: registered.parameters().to_vec(),
                    fields: registered
                        .self_type
                        .fields
                        .as_ref()
                        .map(|fields| fields.iter().map(|(name, ty)| (name, format_type(ty, false))).collect()),
                    description: registered.definition.description.clone(),
                })
                .collect(),
            namespaces: self
                .namespaces()
                .into_iter()
                .map(|name| NamespaceListing {
                    open: self.open_namespaces.contains(&name),
                    functions: self.namespace_functions[&name]
                        .order
                        .iter()
                        .map(|held| {
                            held.signature
                                .clone()
                                .unwrap_or_else(|| format!("{}(…): {}", held.name, format_type(&held.returns, false)))
                        })
                        .collect(),
                    name,
                })
                .collect(),
        }
    }
}
