//! Turns one manifest file into a live module scope.
//! Mirrors `../../../nodejs/src/controllers/module/module-controller.ts`.
//!
//! Order is the whole content of this file: imports resolve first (their
//! exported instances are reference targets), then kinds register, then `!ref`
//! sentinels resolve against the now-known set of names, then resources are
//! created. Creating before resolving would hand a controller a sentinel; the
//! Node kernel gets the same ordering from its multi-pass init loop, which this
//! kernel does not need because nothing here can defer.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use serde_json::Value;
use telo_analyzer::system_kinds::{
    is_module_document, skips_ref_resolution, APPLICATION, DEFINITION, JSON_SCHEMA, LIBRARY,
};
use telo_analyzer::{
    find_invalid_reference_forms, find_unresolved_sentinels, kind_of, name_of,
    resolve_ref_sentinels, RefTargets,
};

use crate::controllers::module::import_controller::parse_import;
use crate::controllers::resource_definition::resource_definition_controller::register_definition;
use crate::error::KernelError;
use crate::evaluation_context::EvaluationContext;
use crate::kernel::LoadEnv;
use crate::module_context::ModuleContext;
use crate::resource_context::create_resource;
use crate::runtime_registry::ControllerPolicy;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ModuleRole {
    /// Loaded directly — must be a `Telo.Application`.
    Root,
    /// Reached through an `imports:` entry — must be a `Telo.Library`.
    Import,
}

pub struct LoadedModule {
    pub context: Rc<ModuleContext>,
    /// Every document in the file, with `!ref` sentinels resolved. The root's
    /// first document carries `targets:`.
    pub documents: Vec<Value>,
}

pub fn load_module(
    env: &LoadEnv,
    path: &str,
    policy: ControllerPolicy,
    role: ModuleRole,
) -> Result<LoadedModule, KernelError> {
    let loaded = env.loader.load(path)?;
    let documents: Vec<Value> = loaded.documents().cloned().collect();

    let module_doc = documents.first().ok_or_else(|| {
        KernelError::manifest_validation_failed(format!("'{path}' contains no documents"))
    })?;
    let module_kind = kind_of(module_doc).unwrap_or("");
    let expected = match role {
        ModuleRole::Root => APPLICATION,
        ModuleRole::Import => LIBRARY,
    };
    if module_kind != expected {
        return Err(KernelError::manifest_validation_failed(match role {
            ModuleRole::Root => format!(
                "'{path}' starts with '{module_kind}'; a manifest run directly must start with a {APPLICATION} document"
            ),
            ModuleRole::Import => format!(
                "'{path}' starts with '{module_kind}'; an imported manifest must be a {LIBRARY}. Applications are run, never imported."
            ),
        }));
    }
    let module_name = name_of(module_doc)
        .ok_or_else(|| {
            KernelError::manifest_validation_failed(format!("'{path}' has no metadata.name"))
        })?
        .to_string();
    reject_unsupported_module_fields(module_doc, &loaded.source)?;

    if let Some(second) = documents.iter().skip(1).find(|document| {
        kind_of(document).is_some_and(is_module_document)
    }) {
        return Err(KernelError::manifest_validation_failed(format!(
            "'{}' declares a second '{}' document; a file may declare at most one {APPLICATION} or {LIBRARY}, as its first document",
            loaded.source,
            kind_of(second).unwrap_or("")
        )));
    }

    let imports = load_imports(env, module_doc, &loaded.source)?;

    let mut definitions = HashMap::new();
    for document in documents.iter().skip(1) {
        if kind_of(document) != Some(DEFINITION) {
            continue;
        }
        let definition = register_definition(&module_name, &loaded.source, &policy, document)?;
        env.registry.register(Rc::clone(&definition))?;
        definitions.insert(definition.name.clone(), definition);
    }

    let (exported_kinds, exported_resources) = read_exports(module_doc, &loaded.source)?;

    let context = Rc::new(ModuleContext {
        name: module_name,
        source: loaded.source.clone(),
        imports,
        definitions,
        exported_kinds,
        exported_resources,
        resources: EvaluationContext::default(),
        policy,
    });

    let mut documents = documents;
    let targets = build_ref_targets(&context, &documents)?;
    for document in documents.iter_mut() {
        if kind_of(document).is_some_and(skips_ref_resolution) {
            continue;
        }
        resolve_ref_sentinels(document, &targets);
    }
    reject_leftover_references(&context, &documents)?;

    for document in documents.iter().skip(1) {
        let Some(kind) = kind_of(document) else {
            return Err(KernelError::manifest_validation_failed(format!(
                "'{}' contains a document with no `kind:`. Every document after the module doc declares a resource or a {DEFINITION}.",
                context.source
            )));
        };
        if kind == DEFINITION {
            continue;
        }
        let name = resource_name(document, &context.source)?;
        let definition = resolve_resource_kind(&context, kind, name)?;
        let instance = create_resource(definition, document, name, &env.controllers)?;
        context.resources.set_resource(instance);
    }

    for name in &context.exported_resources {
        if context.resources.get_resource(name).is_none() {
            return Err(KernelError::resource_not_found(format!(
                "module '{}' exports resource '{name}', which it does not declare",
                context.name
            )));
        }
    }

    Ok(LoadedModule { context, documents })
}

/// Module-doc fields this kernel does not implement, and what each would need.
///
/// Each is rejected rather than ignored. A manifest that binds `variables:` from
/// the environment and then runs with those variables simply absent is the worst
/// available outcome: it neither works nor says why.
const UNSUPPORTED_MODULE_FIELDS: &[(&str, &str)] = &[
    ("variables", "binding host environment variables"),
    ("secrets", "binding host secrets"),
    ("ports", "binding inbound ports"),
    ("include", "loading partial files into the module scope"),
    ("lifecycle", "lifecycle selection"),
];

fn reject_unsupported_module_fields(module_doc: &Value, source: &str) -> Result<(), KernelError> {
    for (field, what) in UNSUPPORTED_MODULE_FIELDS {
        if module_doc.get(field).is_some() {
            return Err(KernelError::new(
                "ERR_UNSUPPORTED_MANIFEST_FEATURE",
                format!("'{source}' declares `{field}:`; this kernel does not implement {what} yet"),
            ));
        }
    }
    Ok(())
}

/// Fail on any reference this kernel cannot make sense of, once resolution has
/// run over every document.
///
/// Two shapes, both of which the Node analyzer rejects and neither of which may
/// reach a controller: a `!ref` that resolved to nothing, and a hand-written
/// `{kind, name}` mapping. The first is swept for explicitly because this kernel
/// has no scopes — unlike Node, no sentinel can legitimately survive to be
/// resolved on demand later.
fn reject_leftover_references(
    context: &ModuleContext,
    documents: &[Value],
) -> Result<(), KernelError> {
    for document in documents {
        for invalid in find_invalid_reference_forms(document) {
            return Err(KernelError::new(
                "ERR_INVALID_REFERENCE_FORM",
                format!(
                    "'{}' at '{}': a reference must be written with the `!ref` tag, not as a `{{kind, name}}` mapping. Write `!ref {}`.",
                    context.source, invalid.path, invalid.name
                ),
            ));
        }
        for unresolved in find_unresolved_sentinels(document) {
            return Err(unresolved_reference_error(
                context,
                &unresolved.path,
                &unresolved.source,
            ));
        }
    }
    Ok(())
}

/// Explain an unresolved `!ref` in terms of what the author can act on.
///
/// A cross-module name is routed through `exported_resource` so the answer names
/// the module's actual exports; that distinction is the whole difference between
/// "check the spelling" and "the module declares it but does not export it".
fn unresolved_reference_error(
    context: &ModuleContext,
    path: &str,
    source: &str,
) -> KernelError {
    let at = format!("'{}' at '{path}'", context.source);
    let (alias, name) = match source.split_once('.') {
        None => (None, source),
        Some(("Self", name)) => (None, name),
        Some((alias, name)) => (Some(alias), name),
    };

    match alias {
        None => KernelError::resource_not_found(format!(
            "{at}: `!ref {source}` names no resource declared in module '{}'",
            context.name
        )),
        Some(alias) => match context.imports.get(alias) {
            // The import exists, so let it answer with its own export list —
            // "declared but not exported" and "misspelled" need different fixes.
            Some(import) => match import.exported_resource(name) {
                Ok(_) => KernelError::resource_not_found(format!(
                    "{at}: `!ref {source}` did not resolve, though import '{alias}' exports '{name}'"
                )),
                Err(err) => KernelError::new(err.code.clone(), format!("{at}: {}", err.message)),
            },
            None => KernelError::resource_not_found(format!(
                "{at}: `!ref {source}` names import alias '{alias}', which module '{}' does not declare",
                context.name
            )),
        },
    }
}

fn load_imports(
    env: &LoadEnv,
    module_doc: &Value,
    base_source: &str,
) -> Result<HashMap<String, Rc<ModuleContext>>, KernelError> {
    let mut imports = HashMap::new();
    let Some(entries) = module_doc.get("imports").and_then(Value::as_object) else {
        return Ok(imports);
    };
    for (alias, entry) in entries {
        let spec = parse_import(alias, entry, base_source)?;
        let child = env.load_import(&spec.source, spec.policy)?;
        imports.insert(alias.clone(), child);
    }
    Ok(imports)
}

fn read_exports(
    module_doc: &Value,
    source: &str,
) -> Result<(Option<HashSet<String>>, HashSet<String>), KernelError> {
    let exports = module_doc.get("exports");
    let kinds = read_export_list(exports, "kinds", source)?;
    let resources = read_export_list(exports, "resources", source)?.unwrap_or_default();
    for name in &resources {
        // `<Alias>.<name>` re-exports another module's instance. Detected by the
        // dot rather than left to fail later as "declares no such resource",
        // which would send the author looking for a typo they did not make.
        if name.contains('.') {
            return Err(KernelError::new(
                "ERR_UNSUPPORTED_MANIFEST_FEATURE",
                format!(
                    "'{source}' re-exports resource '{name}'; this kernel does not implement re-export yet"
                ),
            ));
        }
    }
    Ok((kinds, resources))
}

/// Read one `exports.<field>` list, rejecting a non-string entry rather than
/// dropping it — a silently skipped export becomes an unresolvable reference in
/// the importer, which is a much harder error to trace back here.
fn read_export_list(
    exports: Option<&Value>,
    field: &str,
    source: &str,
) -> Result<Option<HashSet<String>>, KernelError> {
    let Some(entries) = exports.and_then(|exports| exports.get(field)) else {
        return Ok(None);
    };
    let Some(entries) = entries.as_array() else {
        return Err(KernelError::manifest_validation_failed(format!(
            "'{source}': `exports.{field}` must be a list of names, got {entries}"
        )));
    };
    entries
        .iter()
        .map(|entry| {
            entry.as_str().map(str::to_string).ok_or_else(|| {
                KernelError::manifest_validation_failed(format!(
                    "'{source}': every `exports.{field}` entry must be a name string, got {entry}"
                ))
            })
        })
        .collect::<Result<HashSet<_>, _>>()
        .map(Some)
}

/// Names a `!ref` may resolve to in this module: its own resources, and every
/// instance its imports export.
fn build_ref_targets(
    context: &ModuleContext,
    documents: &[Value],
) -> Result<RefTargets, KernelError> {
    let mut targets = RefTargets::default();
    for document in documents.iter().skip(1) {
        let Some(kind) = kind_of(document) else {
            return Err(KernelError::manifest_validation_failed(format!(
                "'{}' contains a document with no `kind:`. Every document after the module doc declares a resource or a {DEFINITION}.",
                context.source
            )));
        };
        if kind == DEFINITION {
            continue;
        }
        let name = resource_name(document, &context.source)?;
        let definition = resolve_resource_kind(context, kind, name)?;
        targets.add_local(name, definition.kind.clone());
    }
    for (alias, import) in &context.imports {
        for name in &import.exported_resources {
            if let Some(instance) = import.resources.get_resource(name) {
                targets.add_foreign(alias, name, instance.kind.clone());
            }
        }
    }
    Ok(targets)
}

fn resource_name<'a>(document: &'a Value, source: &str) -> Result<&'a str, KernelError> {
    let name = name_of(document).ok_or_else(|| {
        KernelError::manifest_validation_failed(format!(
            "a resource in '{source}' has no metadata.name"
        ))
    })?;
    if name.contains('.') {
        return Err(KernelError::new(
            "ERR_INVALID_RESOURCE_NAME",
            format!(
                "resource '{name}' in '{source}': a resource name must contain no dot — the reference grammar splits on the first one"
            ),
        ));
    }
    Ok(name)
}

fn resolve_resource_kind(
    context: &ModuleContext,
    kind: &str,
    name: &str,
) -> Result<Rc<crate::controller_registry::Definition>, KernelError> {
    if kind.starts_with("Telo.") {
        return Err(KernelError::new(
            "ERR_UNSUPPORTED_MANIFEST_FEATURE",
            format!(
                "resource '{name}' declares built-in kind '{kind}', which this kernel cannot instantiate as a standalone resource. Only `{JSON_SCHEMA}` used inline as a type is supported."
            ),
        ));
    }
    context.resolve_kind(kind)
}
