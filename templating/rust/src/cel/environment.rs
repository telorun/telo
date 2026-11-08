//! The two environments — `environment.ts`.
//!
//! [`build_cel_language_environment`] is the bare CEL language under Telo's options;
//! [`build_cel_environment`] is the dialect built on it: Telo's function catalog with the
//! host's handlers, every value type's CEL face, and the live `Stream` type. A second engine
//! reproduces the two separately, so they are named separately.
//!
//! **A handler the host does not supply** gets the engine's own answer: evaluating its
//! function is the error value `unbound_function`, `<name>() is supplied by the host, and
//! this environment was given no implementation for it`. Node supplies stub handlers that
//! throw a message of their own instead; no vector observes the difference, and a test
//! names it.
//!
//! A registration refused here is a defect in the engine or the data, and panics naming
//! the entry.

use telorun_cel::{
    function_catalog, register_function_catalog, CatalogFunction, CelCatalogHandlers, CelEnvironment,
    CelEnvironmentOptions, FunctionDefinition, NominalTypeDefinition, RegisterCatalogOptions,
};

use crate::cel::value_types::register_value_types;

/// The nine functions the host answers for — the engine's own seam, named here so a
/// consumer naming it need not name the engine.
pub type CelHandlers = CelCatalogHandlers;

/// The bare CEL language under Telo's options: the standard library and nothing else.
///
/// Unlisted names read as `dyn` because a host types only part of what a site may read;
/// optional types are on because the manifest surface uses them; heterogeneous list and
/// map literals unify to `dyn`, cel-go's default, which a manifest needs.
pub fn build_cel_language_environment() -> CelEnvironment {
    CelEnvironment::new(CelEnvironmentOptions {
        unlisted_variables_are_dyn: true,
        enable_optional_types: true,
        homogeneous_aggregate_literals: false,
        ..CelEnvironmentOptions::default()
    })
}

/// Every function the language declares, for documentation that tells the language and
/// the dialect apart.
pub fn cel_builtin_functions() -> Vec<FunctionDefinition> {
    build_cel_language_environment().definitions().functions
}

/// Telo's dialect: the language, the function catalog over `handlers`, every value type's
/// CEL face, and the live `Stream` type.
pub fn build_cel_environment(handlers: CelHandlers) -> CelEnvironment {
    let mut environment = build_cel_language_environment();
    register_function_catalog(&mut environment, RegisterCatalogOptions { handlers });
    register_value_types(&mut environment);
    // A live handle: `dyn` underneath with no conversion and no member, so reading anything
    // off one is refused at check.
    environment
        .register_type(NominalTypeDefinition { name: "Stream".into(), base: "dyn".into(), ..Default::default() })
        .unwrap_or_else(|refusal| panic!("the Stream type does not register: {refusal}"));
    environment
}

/// The dialect's functions as the one listing surface answers them.
pub fn cel_function_catalog() -> &'static [CatalogFunction] {
    function_catalog()
}
