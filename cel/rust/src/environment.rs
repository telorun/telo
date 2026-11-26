//! An environment: what names, functions, types and namespaces an expression is read,
//! checked, compiled and evaluated against — `environment.ts`.
//!
//! Everything is registered the same way, the standard library included, so a host can
//! replace or remove a standard signature. `Clone` inherits everything and then
//! diverges: a registration on the clone leaves the original as it was.
//!
//! **A program compiles against a snapshot.** The registry, the standard constants'
//! values and each named type's arity and fields are shared with every program compiled
//! from them and copied before a registration changes them, so a registration never
//! reaches a program already compiled. A compile from text is memoized in a bounded,
//! least-recently-used cache keyed by the exact text; every registration that changed
//! anything forgets it, so a compile after a registration reads the registration. The
//! cache's lock is held only to look up and to insert.
//!
//! Node items with no twin: `emit`, `emittedModule`, `emitterRuntime`, `digest` — there
//! is no emitter here; the refusal "a declaration is a type expression, a field map or a
//! schema" — [`TypeDeclaration`] holds nothing else; the `RangeError` of a cache capacity
//! below one — the capacity is a `NonZeroUsize`.
//!
//! Declared here and not in the Node file:
//! - [`CelRegistrationError`] — every refusal a registration answers, which Node throws
//!   as five classes.
//! - [`SignatureDeclaration`], [`NamespaceFunctionForm`], [`WithheldReturns`] — the
//!   shapes Node writes as a union of a string and an object.
//! - [`CelEnvironment::clone_with_options`] — Node's `clone(options)`.
//! - [`CelEnvironment::check_parsed`], [`CelEnvironment::compile_parsed`],
//!   [`CelEnvironment::evaluate_parsed`] — Node's `check`, `compile` and `evaluate` handed
//!   a tree; the methods handed text never refuse a namespace set.
//! - [`CelProgramError`] and [`CelEvaluateError`] — what Node throws from `compile` and
//!   `evaluate`, as a variant per class; a namespaced function's host failure is
//!   `CelEvaluateError::Host`, where Node throws the host's own error.
//! - [`CelEnvironment::functions_named`] — Node's `definitions().functions` read for one
//!   name, without listing the rest.
//! - [`CelEnvironment::register_type_with`] — Node's `registerType(definition, options)`;
//!   `register_type` is that with no options.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::num::NonZeroUsize;
use std::sync::{Arc, Mutex};

use telorun_cel_value::{compare_code_units, json_quote, CelError, CelValue, PropertyMap, CEL_VALUE_KEYS};

use crate::activation::CelActivation;
use crate::backend_runtime::{CelCompileError, CompileTarget, EnvironmentSnapshot, NominalRuntime};
use crate::bounded_cache::BoundedCache;
use crate::cel_expression::{parse_expression, resolved_under, CelExpression, ParseExpressionOptions};
use crate::cel_type::{exact_type_text, format_type, is_dyn, optional_of, CelType, NominalType, DYN};
use crate::cel_program::{CelEvaluationError, CelProgram, EvaluateOptions};
use crate::check_diagnostic::{CelEngineError, CelEngineErrorCode};
use crate::checker::{check_expression, CheckResult, CheckerAssumption, CheckerContext, CheckerOptions, NamespaceFunction};
use crate::closure_backend::compile_tree;
use crate::construction::{
    compared_constructible, constructible_equality_refusal, equality_comparing, equality_registration_refusal,
    is_own_comparison, ConstructionTypes,
};
use crate::function_registry::{Expansion, FunctionRegistry, RegisteredFunction};
use crate::schema_dependencies::SchemaProvenance;
use crate::json_schema_type::{
    field_map_type, read_schema_type, FieldDeclaration, JsonSchemaDocument, RecursiveSchemaReference, SchemaConversion, SchemaTypeReading,
    SchemaTypeResolver, UnjudgedSchemaNode,
};
use crate::namespace_resolution::{normalize_namespaces, CelNamespaceError};
use crate::nominal_type::{
    build_registered_type, nominal_operators, nominal_signatures, registration_error, with_arguments,
    CelTypeRegistrationError, NominalTypeDefinition, RegisterTypeOptions, RegisteredType,
};
use crate::parse_limits::CelParseLimits;
use crate::parser::ParseOptions;
use crate::backend_runtime::HostFailure;
use crate::runtime_library::standard_constant_values;
use crate::signature::{format_signature, parse_signature, CallForm, CelSignature, FunctionMetadata};
use crate::standard_library::{register_standard_library, standard_constants, StandardLibraryOptions};
use crate::type_expression::{
    parse_type_expression, resolve_type_name, CelTypeExpressionError, CelTypeTextError, CelUnknownTypeNameError, NominalResolver,
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
    /// How many compiled expressions the environment keeps. A clone keeps the option and
    /// starts with none.
    pub compiled_cache_capacity: NonZeroUsize,
}

/// How many compiled expressions an environment keeps when nothing says otherwise.
pub const DEFAULT_COMPILED_CACHE_CAPACITY: usize = 256;

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
            && self.compiled_cache_capacity == other.compiled_cache_capacity
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
            .field("compiled_cache_capacity", &self.compiled_cache_capacity)
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
            compiled_cache_capacity: NonZeroUsize::new(DEFAULT_COMPILED_CACHE_CAPACITY)
                .expect("the default capacity holds at least one program"),
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
#[derive(Clone, PartialEq, Debug)]
pub enum WithheldReturns {
    /// A type expression.
    Text(String),
    Type(CelType),
    /// A JSON Schema document, read through the environment's resolver as a schema-typed
    /// variable is: a check reading through the call's result lists what it read with that
    /// document, and what the conversion could not judge is reported under
    /// `<namespace>.<name>` by [`CelEnvironment::schema_reports`].
    Schema(JsonSchemaDocument),
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

impl From<JsonSchemaDocument> for WithheldReturns {
    fn from(document: JsonSchemaDocument) -> Self {
        WithheldReturns::Schema(document)
    }
}

/// How a namespaced function is declared: whole, as a global signature that arity and
/// arguments are judged against; or by its name and result alone.
#[derive(Clone, PartialEq, Debug)]
pub enum NamespaceFunctionForm {
    Signature(String),
    Withheld { name: String, returns: WithheldReturns },
}

/// A namespaced function a host declares. A type name nothing is registered under is
/// accepted, reads `dyn` and is recorded on the declaration.
#[derive(Clone, PartialEq, Debug)]
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
    /// Present exactly when an expression may construct a value of it.
    pub constructible: Option<ConstructibleListing>,
    pub description: Option<String>,
}

/// How a constructible type is constructed.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ConstructibleListing {
    /// The fields a construction must write, each once, in the order the definition lists them.
    pub required: Vec<String>,
    /// Whether the host supplied the builder.
    pub builder: bool,
}

/// One function a namespace declares, as its listing holds it.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct NamespaceFunctionListing {
    /// The signature, or `name(…): <result>` where the parameters are withheld — a result
    /// declared as a schema printed cut past its bound.
    pub declaration: String,
    /// The CEL type of a result declared as a JSON Schema, present exactly then: what
    /// identifies it, since its printed text does not.
    pub result_type: Option<CelType>,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct NamespaceListing {
    pub name: String,
    pub functions: Vec<NamespaceFunctionListing>,
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

/// Why an expression could not be compiled.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum CelProgramError {
    /// A source that did not read whole (`unreadable_expression`), or a tree resolved
    /// under another namespace set (`namespaces_mismatch`).
    Engine(CelEngineError),
    /// A tree no evaluation can be compiled from.
    Compile(CelCompileError),
}

impl fmt::Display for CelProgramError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CelProgramError::Engine(error) => error.fmt(f),
            CelProgramError::Compile(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for CelProgramError {}

impl From<CelEngineError> for CelProgramError {
    fn from(error: CelEngineError) -> Self {
        CelProgramError::Engine(error)
    }
}

impl From<CelCompileError> for CelProgramError {
    fn from(error: CelCompileError) -> Self {
        CelProgramError::Compile(error)
    }
}

/// Why an expression answered no value: it could not be compiled, an error survived to
/// the top of its evaluation, or a namespaced function failed with the host's own failure.
#[derive(PartialEq, Eq, Debug)]
pub enum CelEvaluateError {
    Engine(CelEngineError),
    Compile(CelCompileError),
    Evaluation(CelError),
    Host(HostFailure),
}

impl fmt::Display for CelEvaluateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CelEvaluateError::Engine(error) => error.fmt(f),
            CelEvaluateError::Compile(error) => error.fmt(f),
            CelEvaluateError::Evaluation(error) => error.fmt(f),
            CelEvaluateError::Host(_) => f.write_str("a namespaced function failed with the host's own failure"),
        }
    }
}

impl std::error::Error for CelEvaluateError {}

impl From<CelProgramError> for CelEvaluateError {
    fn from(error: CelProgramError) -> Self {
        match error {
            CelProgramError::Engine(error) => CelEvaluateError::Engine(error),
            CelProgramError::Compile(error) => CelEvaluateError::Compile(error),
        }
    }
}

impl From<CelError> for CelEvaluateError {
    fn from(error: CelError) -> Self {
        CelEvaluateError::Evaluation(error)
    }
}

impl From<CelEvaluationError> for CelEvaluateError {
    fn from(error: CelEvaluationError) -> Self {
        match error {
            CelEvaluationError::Error(error) => CelEvaluateError::Evaluation(error),
            CelEvaluationError::Host(failure) => CelEvaluateError::Host(failure),
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
    /// Where each type of it came from, where it was typed from a schema.
    provenance: Option<Arc<SchemaProvenance>>,
}

/// A namespaced function's result declared as a schema: where its types came from and
/// what was not judged.
#[derive(Clone)]
struct SchemaResult {
    provenance: Arc<SchemaProvenance>,
    unjudged: Vec<UnjudgedSchemaNode>,
    recursive: Vec<RecursiveSchemaReference>,
}

/// A type a declaration named, beside what converting it could not judge.
struct DeclaredType {
    ty: CelType,
    unjudged: Vec<UnjudgedSchemaNode>,
    recursive: Vec<RecursiveSchemaReference>,
    provenance: Option<Arc<SchemaProvenance>>,
}

impl From<CelType> for DeclaredType {
    fn from(ty: CelType) -> Self {
        Self { ty, unjudged: Vec::new(), recursive: Vec::new(), provenance: None }
    }
}

/// What a host asks of one check beyond its verdicts.
#[derive(Clone, Default, PartialEq, Debug)]
pub struct CheckOptions {
    /// Whether to list the schema nodes the verdicts and the result type read
    /// (`CheckResult::schema_dependencies`). Off, nothing is collected.
    pub schema_dependencies: bool,
    /// Whether to name the schema node each refused member, operand or nullable read was
    /// judged at (`CelCheckDiagnostic::schema_node`) and every place the result may have
    /// come from (`CheckResult::result_origins`). Off, nothing is located.
    pub schema_nodes: bool,
    /// Conditions known at the expression's site — each held (`holds: true`) or failed on
    /// the way to it — read as if a conditional enclosed the expression: what each proves
    /// narrows what the expression reads, as a guard written inside it would, except a proof
    /// rooted at one of its `rebound` chains, which may denote another value at the site.
    /// Read in order, each under the ones before it; what a condition itself says is never
    /// reported.
    pub assumptions: Vec<CheckAssumption>,
}

/// One condition known at a checked expression's site: a source this environment parses, or
/// a tree its `parse` produced; `rebound` names the chains (`a`, `a.b`) that may
/// denote another value at the site than they did where it was tested.
#[derive(Clone, PartialEq, Debug)]
pub struct CheckAssumption {
    pub condition: AssumedCondition,
    pub holds: bool,
    pub rebound: Vec<String>,
}

/// An assumption's condition, as source or as a tree.
#[derive(Clone, PartialEq, Debug)]
pub enum AssumedCondition {
    Source(String),
    Parsed(CelExpression),
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

/// The type a name denotes as a type value, as `type()` compares it: the type-expression
/// grammar's reading of the name, `optional_type` the optional — which that grammar spells
/// `optional` and gives an argument.
fn type_named(types: &InsertionOrdered<RegisteredType>, name: &str) -> Option<CelType> {
    match name {
        "optional_type" => Some(optional_of(DYN)),
        "optional" => None,
        _ => {
            let resolver = |name: &str, args: &[CelType]| resolve_nominal(types, name, args);
            resolve_type_name(name, Vec::new(), Some(&resolver))
                .expect("a name read with no type arguments, `optional` aside, always reads")
        }
    }
}

const COMPILED_LOCK: &str = "the compiled cache's lock is held only to read or write an entry";

/// The programs compiled from text. A clone of it holds none.
struct CompiledCache(Mutex<BoundedCache<Arc<str>, Arc<CelProgram>>>);

impl CompiledCache {
    fn new(capacity: NonZeroUsize) -> Self {
        Self(Mutex::new(BoundedCache::new(capacity)))
    }

    fn get(&self, source: &str) -> Option<Arc<CelProgram>> {
        self.0.lock().expect(COMPILED_LOCK).get(source).cloned()
    }

    fn set(&self, source: &str, program: Arc<CelProgram>) {
        self.0.lock().expect(COMPILED_LOCK).set(Arc::from(source), program);
    }

    fn clear(&mut self) {
        self.0.get_mut().expect(COMPILED_LOCK).clear();
    }
}

impl Clone for CompiledCache {
    fn clone(&self) -> Self {
        Self::new(self.0.lock().expect(COMPILED_LOCK).capacity())
    }
}

#[derive(Clone)]
pub struct CelEnvironment {
    options: CelEnvironmentOptions,
    /// Shared with every program compiled from it; copied before it changes.
    registry: Arc<FunctionRegistry>,
    variables: HashMap<String, VariableRecord>,
    types: InsertionOrdered<RegisteredType>,
    /// Each named type as evaluation reads it, shared and copied as the registry is.
    runtime_types: Arc<HashMap<String, NominalRuntime>>,
    /// The values the standard library's constants read as.
    constants: Arc<PropertyMap<CelValue>>,
    namespace_functions: HashMap<String, InsertionOrdered<NamespaceFunction>>,
    /// Per namespace, each function whose result was declared as a schema.
    namespace_results: HashMap<String, HashMap<String, SchemaResult>>,
    open_namespaces: HashSet<String>,
    compiled: CompiledCache,
}

const _: () = {
    const fn shared_across_threads<T: Send + Sync>() {}
    shared_across_threads::<CelEnvironment>();
};

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
        let compiled = CompiledCache::new(options.compiled_cache_capacity);
        let mut environment = Self {
            options,
            registry: Arc::new(FunctionRegistry::new()),
            variables: HashMap::new(),
            types: InsertionOrdered::default(),
            runtime_types: Arc::new(HashMap::new()),
            constants: Arc::new(PropertyMap::new()),
            namespace_functions: HashMap::new(),
            namespace_results: HashMap::new(),
            open_namespaces: HashSet::new(),
            compiled,
        };
        if standard_library {
            environment.constants = Arc::new(standard_constant_values(optional_types));
            let types = &environment.types;
            let resolver = |name: &str, args: &[CelType]| resolve_nominal(types, name, args);
            register_standard_library(
                Arc::make_mut(&mut environment.registry),
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
                        provenance: None,
                    },
                );
            }
        }
        environment
    }

    /// A clone under other options. Nothing more is registered: on a clone,
    /// `standard_library` and `enable_optional_types` register nothing.
    pub fn clone_with_options(&self, options: CelEnvironmentOptions) -> Self {
        let compiled = CompiledCache::new(options.compiled_cache_capacity);
        Self { options, compiled, ..self.clone() }
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
        self.refuse_constructible_equality(&signature)?;
        self.compiled.clear();
        Arc::make_mut(&mut self.registry).register(signature, metadata)?;
        Ok(())
    }

    /// A constructible type's equality is its fields', with no host override: an `==` or
    /// `!=` registration that would compare its values is refused, implemented or not.
    fn refuse_constructible_equality(&self, signature: &CelSignature) -> Result<(), CelTypeRegistrationError> {
        let constructible: Vec<&str> =
            self.types.order.iter().filter(|held| held.constructible).map(|held| held.definition.name.as_str()).collect();
        match compared_constructible(signature, &constructible) {
            Some(ty) => Err(registration_error(equality_registration_refusal(signature, ty))),
            None => Ok(()),
        }
    }

    /// Removes the one registration answering that call. Answers whether it was there.
    pub fn remove_function(&mut self, signature: impl Into<SignatureDeclaration>) -> Result<bool, CelRegistrationError> {
        let signature = self.signature_of(signature.into())?;
        self.compiled.clear();
        let removed = Arc::make_mut(&mut self.registry).remove(&signature);
        Ok(removed)
    }

    /// Removes every registration of a name, so a call to it is unknown. Answers how
    /// many went.
    pub fn remove_functions_named(&mut self, name: &str) -> usize {
        self.compiled.clear();
        let removed = Arc::make_mut(&mut self.registry).remove_name(name);
        removed
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
        self.refuse_constructible_equality(&signature)?;
        self.compiled.clear();
        Arc::make_mut(&mut self.registry).register(signature, metadata)?;
        Ok(())
    }

    /// The type a declaration names: a type expression, a type, a field map, or a schema.
    fn declared_type(&self, declaration: TypeDeclaration) -> Result<DeclaredType, CelTypeTextError> {
        match declaration {
            TypeDeclaration::Text(text) => Ok(self.read_type(&text)?.into()),
            TypeDeclaration::Type(ty) => Ok(ty.into()),
            TypeDeclaration::Fields(fields) => Ok(field_map_type(&fields, &|text| self.read_type(text))?.into()),
            TypeDeclaration::Schema(document) => self.schema_declared_type(&document),
        }
    }

    /// A schema read to full depth through this environment's resolver, with its provenance.
    fn schema_declared_type(&self, document: &JsonSchemaDocument) -> Result<DeclaredType, CelTypeTextError> {
        let lookup = |name: &str, args: &[String]| -> Result<Option<CelType>, CelTypeTextError> {
            let args = args.iter().map(|text| self.read_type(text)).collect::<Result<Vec<_>, _>>()?;
            let types = &self.types;
            let resolver = |name: &str, args: &[CelType]| resolve_nominal(types, name, args);
            resolve_type_name(name, args, Some(&resolver))
        };
        let SchemaTypeReading { result: converted, provenance, .. } = read_schema_type(
            document,
            &SchemaConversion {
                resolve_schema_type: self.options.resolve_schema_type.clone(),
                lookup_named_type: Some(&lookup),
            },
        )?;
        Ok(DeclaredType {
            ty: converted.ty,
            unjudged: converted.unjudged,
            recursive: converted.recursive,
            provenance: Some(Arc::new(provenance)),
        })
    }

    /// A declared name changes which name a dotted chain reads, which a program decides
    /// when it is compiled — so a declaration forgets what was compiled.
    fn declare(&mut self, name: &str, declared: DeclaredType, description: Option<String>, constant: bool) {
        let DeclaredType { ty, unjudged, recursive, provenance } = declared;
        self.variables.insert(name.into(), VariableRecord { ty, description, constant, unjudged, recursive, provenance });
        self.compiled.clear();
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
    /// UTF-16 code-unit order — a variable's, or `<namespace>.<name>` for a namespaced
    /// function's result. Empty is every node judged.
    pub fn schema_reports(&self) -> Vec<SchemaRegistrationReport> {
        let mut held: Vec<SchemaRegistrationReport> = self
            .variables
            .iter()
            .map(|(name, record)| SchemaRegistrationReport {
                name: name.clone(),
                unjudged: record.unjudged.clone(),
                recursive: record.recursive.clone(),
            })
            .collect();
        for (namespace, results) in &self.namespace_results {
            held.extend(results.iter().map(|(name, result)| SchemaRegistrationReport {
                name: format!("{namespace}.{name}"),
                unjudged: result.unjudged.clone(),
                recursive: result.recursive.clone(),
            }));
        }
        held.retain(|report| !report.unjudged.is_empty() || !report.recursive.is_empty());
        held.sort_by(|left, right| compare_code_units(&left.name, &right.name));
        held
    }

    /// Registers a named type, with every operator, conversion and member it declares:
    /// [`CelEnvironment::register_type_with`] with no builder.
    pub fn register_type(&mut self, definition: NominalTypeDefinition) -> Result<(), CelRegistrationError> {
        self.register_type_with(definition, RegisterTypeOptions::default())
    }

    /// Registers a named type, with every operator, conversion and member it declares. A
    /// `constructible` type may be built by an expression — by `options.construct` where
    /// the host supplies a builder, and by the engine where it does not.
    ///
    /// The type is held before its signatures are registered, one by one, and a type
    /// registered again keeps the signatures its earlier registration made — so a
    /// signature refused part way leaves the type and the signatures before it, as on
    /// Node. Once the type is held, what was compiled is forgotten, a refusal part way
    /// included.
    pub fn register_type_with(
        &mut self,
        definition: NominalTypeDefinition,
        options: RegisterTypeOptions,
    ) -> Result<(), CelRegistrationError> {
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
            build_registered_type(&definition, &resolver, &options)?
        };
        if registered.constructible {
            let mut registrations = self.registry.named("==");
            registrations.extend(self.registry.named("!="));
            if let Some(comparing) = equality_comparing(&registrations, &definition.name) {
                return Err(registration_error(constructible_equality_refusal(&definition.name, &comparing)).into());
            }
        }
        let self_type = registered.self_type.clone();
        self.compiled.clear();
        Arc::make_mut(&mut self.runtime_types).insert(
            definition.name.clone(),
            NominalRuntime {
                arity: registered.parameters().len(),
                fields: self_type.fields.as_ref().map(|fields| fields.keys().map(str::to_owned).collect()),
                constructible: registered.constructible,
            },
        );
        self.types.set(&definition.name, registered);
        self.register_type_signatures(&definition, &self_type)
    }

    fn register_type_signatures(
        &mut self,
        definition: &NominalTypeDefinition,
        self_type: &NominalType,
    ) -> Result<(), CelRegistrationError> {
        let origin = format!("type:{}", definition.name);
        let metadata = || FunctionMetadata { deterministic: true, origin: Some(origin.clone()), ..FunctionMetadata::default() };
        for text in nominal_signatures(definition) {
            let signature = {
                let types = &self.types;
                let resolver = |name: &str, args: &[CelType]| {
                    if name == "Self" {
                        Ok(Some(with_arguments(self_type, args)))
                    } else {
                        resolve_nominal(types, name, args)
                    }
                };
                parse_signature(text, Some(&resolver))?
            };
            Arc::make_mut(&mut self.registry).register(signature, metadata())?;
        }
        for operator in nominal_operators(definition) {
            let signature = {
                let types = &self.types;
                let resolver = |name: &str, args: &[CelType]| {
                    if name == "Self" {
                        Ok(Some(with_arguments(self_type, args)))
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
            let metadata = metadata();
            // The comparisons a constructible type implies of itself are its field-wise
            // equality; any other `==` or `!=` it declares passes the door a host's does.
            if !(definition.constructible && is_own_comparison(&signature, &metadata, &definition.name)) {
                self.refuse_constructible_equality(&signature)?;
            }
            Arc::make_mut(&mut self.registry).register(signature, metadata)?;
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
        let mut results: HashMap<String, SchemaResult> = HashMap::new();
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
            // A name declared again replaces what it declared, its result schema included.
            let declared_name = match &declaration.form {
                NamespaceFunctionForm::Signature(_) => None,
                NamespaceFunctionForm::Withheld { name, .. } => Some(name.clone()),
            };
            if let Some(name) = &declared_name {
                results.remove(name);
            }
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
                NamespaceFunctionForm::Withheld { name, returns } => {
                    let declared = match returns {
                        WithheldReturns::Text(text) => parse_type_expression(text, Some(&resolver))?.into(),
                        WithheldReturns::Type(ty) => ty.clone().into(),
                        WithheldReturns::Schema(document) => self.schema_declared_type(document)?,
                    };
                    if let Some(provenance) = declared.provenance {
                        results.insert(
                            name.clone(),
                            SchemaResult { provenance, unjudged: declared.unjudged, recursive: declared.recursive },
                        );
                    }
                    NamespaceFunction {
                        name: name.clone(),
                        returns: declared.ty,
                        parameters: None,
                        signature: None,
                        unregistered_types: unregistered.take(),
                        deterministic: declaration.deterministic,
                        host_backed: declaration.host_backed,
                        throws: declaration.throws.clone(),
                    }
                }
            };
            if declared_name.is_none() {
                results.remove(&record.name);
            }
            declared.set(&record.name.clone(), record);
        }
        self.namespace_functions.insert(name.into(), declared);
        self.namespace_results.insert(name.into(), results);
        if options.open {
            self.open_namespaces.insert(name.into());
        } else {
            self.open_namespaces.remove(name);
        }
        self.compiled.clear();
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
        check_expression(&self.parse(source), &self.checker_context(CheckOptions::default()))
    }

    /// [`check`](Self::check), answering what `options` asks for beside the verdicts. An
    /// assumption's tree resolved under a different namespace set is refused, as
    /// [`check_parsed`](Self::check_parsed) refuses an expression.
    pub fn check_with(&self, source: &str, options: CheckOptions) -> Result<CheckResult, CelEngineError> {
        self.check_parsed_with(&self.parse(source), options)
    }

    /// Checks a tree. A tree resolved under a different namespace set is refused rather
    /// than checked: its qualified calls are not the ones this environment would have
    /// found, so every answer about it would be about a different expression.
    pub fn check_parsed(&self, expression: &CelExpression) -> Result<CheckResult, CelEngineError> {
        self.check_parsed_with(expression, CheckOptions::default())
    }

    /// [`check_parsed`](Self::check_parsed), answering what `options` asks for beside the
    /// verdicts.
    pub fn check_parsed_with(
        &self,
        expression: &CelExpression,
        options: CheckOptions,
    ) -> Result<CheckResult, CelEngineError> {
        self.resolved_here(expression)?;
        let mut assumptions = Vec::with_capacity(options.assumptions.len());
        for assumption in &options.assumptions {
            let condition = match &assumption.condition {
                AssumedCondition::Source(source) => self.parse(source).root,
                AssumedCondition::Parsed(tree) => {
                    self.resolved_here(tree)?;
                    Arc::clone(&tree.root)
                }
            };
            assumptions.push(CheckerAssumption { condition, holds: assumption.holds, rebound: assumption.rebound.clone() });
        }
        let mut context = self.checker_context(options);
        context.assumptions = assumptions;
        Ok(check_expression(expression, &context))
    }

    /// Refuses a tree resolved under a different namespace set than this environment's.
    fn resolved_here(&self, expression: &CelExpression) -> Result<(), CelEngineError> {
        let namespaces = self.namespaces();
        let same = resolved_under(expression, &namespaces).expect("every registered namespace was validated when it was registered");
        if same {
            return Ok(());
        }
        Err(CelEngineError {
            code: CelEngineErrorCode::NamespacesMismatch,
            message: format!(
                "the expression was resolved under [{}] and this environment has [{}]",
                expression.namespaces.join(", "),
                namespaces.join(", ")
            ),
        })
    }

    /// Compiles an expression read against this environment into a program. Nothing is
    /// type-checked here — the checker decides every verdict — so a compile refuses only
    /// what cannot be compiled at all. A compile from text is memoized.
    pub fn compile(&self, source: &str) -> Result<Arc<CelProgram>, CelProgramError> {
        if let Some(held) = self.compiled.get(source) {
            return Ok(held);
        }
        let program = self.compile_ready(&self.parse(source))?;
        self.compiled.set(source, Arc::clone(&program));
        Ok(program)
    }

    /// Compiles a tree, each time: a tree has no identity to key a cache on.
    pub fn compile_parsed(&self, expression: &CelExpression) -> Result<Arc<CelProgram>, CelProgramError> {
        self.compile_ready(expression)
    }

    /// Compiles an expression and evaluates it against an activation.
    pub fn evaluate(
        &self,
        source: &str,
        activation: &dyn CelActivation,
        options: &EvaluateOptions<'_>,
    ) -> Result<CelValue, CelEvaluateError> {
        Ok(self.compile(source)?.evaluate(activation, options)?)
    }

    /// Compiles a tree and evaluates it against an activation.
    pub fn evaluate_parsed(
        &self,
        expression: &CelExpression,
        activation: &dyn CelActivation,
        options: &EvaluateOptions<'_>,
    ) -> Result<CelValue, CelEvaluateError> {
        Ok(self.compile_parsed(expression)?.evaluate(activation, options)?)
    }

    /// A program from an expression a backend may compile: read whole, and resolved under
    /// this environment's own namespaces.
    fn compile_ready(&self, expression: &CelExpression) -> Result<Arc<CelProgram>, CelProgramError> {
        if let Some(diagnostic) = &expression.diagnostic {
            return Err(CelEngineError {
                code: CelEngineErrorCode::UnreadableExpression,
                message: format!("{} could not be read: {}", json_quote(&expression.source), diagnostic.message),
            }
            .into());
        }
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
            }
            .into());
        }
        // A chain splits over the same declarations the checker splits it on; a prefix
        // longer than every declared name is no declared name.
        let longest = self.variables.keys().map(String::len).max().unwrap_or(0);
        let declares = |name: &str| name.len() <= longest && self.variables.contains_key(name);
        let target =
            CompileTarget { declares: &declares, types: Arc::clone(&self.runtime_types), construction: self.construction_types() };
        let tree = compile_tree(&expression.root, &target)?;
        let snapshot = EnvironmentSnapshot {
            registry: Arc::clone(&self.registry),
            constants: Arc::clone(&self.constants),
            types: Arc::clone(&self.runtime_types),
        };
        Ok(Arc::new(CelProgram::new(Arc::clone(&expression.source), tree, Arc::new(snapshot))))
    }

    fn checker_context(&self, options: CheckOptions) -> CheckerContext<'_> {
        let variables = &self.variables;
        let namespace_functions = &self.namespace_functions;
        let namespace_results = &self.namespace_results;
        let open_namespaces = &self.open_namespaces;
        let types = &self.types;
        CheckerContext {
            registry: &self.registry,
            variable: Box::new(move |name| variables.get(name).map(|record| &record.ty)),
            variable_provenance: Box::new(move |name| variables.get(name).and_then(|record| record.provenance.as_ref())),
            schema_dependencies: options.schema_dependencies,
            schema_nodes: options.schema_nodes,
            declared_variable_names: Box::new(move || variables.keys().map(String::as_str).collect()),
            namespace_function: Box::new(move |namespace, name| namespace_functions.get(namespace)?.get(name)),
            namespace_result_provenance: Box::new(move |namespace, name| {
                namespace_results.get(namespace)?.get(name).map(|result| &result.provenance)
            }),
            namespace_is_open: Box::new(move |namespace| open_namespaces.contains(namespace)),
            construction: self.construction_types(),
            type_named: Box::new(move |name| type_named(types, name)),
            options: CheckerOptions {
                unlisted_variables_are_dyn: self.options.unlisted_variables_are_dyn,
                homogeneous_aggregate_literals: self.options.homogeneous_aggregate_literals,
                enable_optional_types: self.options.enable_optional_types,
            },
            assumptions: Vec::new(),
        }
    }

    /// What a construction's name is resolved against — one reading for the checker and the
    /// evaluator.
    fn construction_types(&self) -> ConstructionTypes<'_> {
        let types = &self.types;
        ConstructionTypes {
            types: &types.order,
            registered_type: Box::new(move |name| types.get(name)),
            optional_types: self.options.enable_optional_types,
            registry: &self.registry,
        }
    }

    /// Whether a value of this type converts to text by the environment's own
    /// `string()`: whether a call `string(x)` over it resolves, as the checker resolves one —
    /// as written, then over a union's members. `dyn` passes, because only the runtime knows
    /// what it holds.
    pub fn converts_to_string(&self, ty: &CelType) -> bool {
        let args = std::slice::from_ref(ty);
        is_dyn(ty)
            || self.registry.resolve("string", CallForm::Global, args, None).is_ok()
            || matches!(self.registry.resolve_expanded("string", CallForm::Global, args, None), Some(Expansion::Resolved { .. }))
    }

    /// Every registration of one function name, in registration order, as
    /// [`CelEnvironment::definitions`] lists each.
    pub fn functions_named(&self, name: &str) -> Vec<FunctionDefinition> {
        self.registry.named(name).iter().map(|entry| function_definition(entry)).collect()
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
            functions: self.registry.list().iter().map(|entry| function_definition(entry)).collect(),
            types: self
                .types
                .order
                .iter()
                .map(|registered| TypeDefinitionListing {
                    name: registered.definition.name.clone(),
                    base: exact_type_text(&registered.base, false),
                    parameters: registered.parameters().to_vec(),
                    fields: registered
                        .self_type
                        .fields
                        .as_ref()
                        .map(|fields| fields.iter().map(|(name, ty)| (name, exact_type_text(ty, false))).collect()),
                    constructible: registered.constructible.then(|| ConstructibleListing {
                        required: registered.required.clone(),
                        builder: registered.construct.is_some(),
                    }),
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
                            // A result declared as a schema is displayed, cut as every converted type is;
                            // one read from type text is written whole.
                            let schema = self.namespace_results.get(&name).is_some_and(|results| results.contains_key(&held.name));
                            let declaration = held.signature.clone().unwrap_or_else(|| {
                                let returns = if schema { format_type(&held.returns, false) } else { exact_type_text(&held.returns, false) };
                                format!("{}(…): {returns}", held.name)
                            });
                            NamespaceFunctionListing { declaration, result_type: schema.then(|| held.returns.clone()) }
                        })
                        .collect(),
                    name,
                })
                .collect(),
        }
    }
}

fn function_definition(entry: &RegisteredFunction) -> FunctionDefinition {
    FunctionDefinition {
        name: entry.signature.name.clone(),
        signature: format_signature(&entry.signature),
        receiver_type: entry.signature.receiver.as_ref().map(|receiver| exact_type_text(receiver, false)),
        parameters: entry.signature.parameters.iter().map(|ty| exact_type_text(ty, false)).collect(),
        returns: exact_type_text(&entry.signature.returns, false),
        deterministic: entry.metadata.deterministic,
        host_backed: entry.metadata.host_backed,
        throws: entry.metadata.throws.clone(),
        description: entry.metadata.description.clone(),
        origin: entry.metadata.origin.clone(),
    }
}
