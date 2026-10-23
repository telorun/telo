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
use telo_analyzer::builtin_vocabulary::{
    builtin_vocabulary_import_message, BUILTIN_VOCABULARY_KIND, BUILTIN_VOCABULARY_NOT_A_MODULE,
};
use telo_analyzer::reserved_kind_prefix::{
    is_reserved_kind_prefix, reserved_import_alias_message, reserved_library_name_message,
    reserved_module_name_message,
};
use telo_analyzer::system_kinds::{
    is_module_document, skips_ref_resolution, APPLICATION, DEFINITION, JSON_SCHEMA, LIBRARY,
};
use telo_analyzer::{
    authored_object_form, declares_name_field, find_invalid_reference_forms,
    find_unresolved_sentinels, kind_of, name_of, reference_form_message, resolve_ref_sentinels,
    InvalidReferenceForm, RefTargets, ReferenceForm, RESOLVED_REFERENCE_MARKER,
};

use crate::controllers::module::import_controller::parse_import;

/// The built-in document a need type is declared with.
const NEED_TYPE: &str = "Telo.NeedType";
use crate::controllers::resource_definition::resource_definition_controller::register_definition;
use crate::error::KernelError;
use crate::evaluation_context::EvaluationContext;
use crate::kernel::LoadEnv;
use crate::module_context::ModuleContext;
use crate::resolve_include_sentinels::{resolve_include_sentinels, IncludeCache};
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
    // The built-in vocabulary is read, never run or imported; the refusal says
    // what it is, in the words `telo check` uses, and an import of it is the
    // runtime twin of that import's `INVALID_IMPORT_TARGET`.
    if module_kind == BUILTIN_VOCABULARY_KIND {
        return Err(match role {
            ModuleRole::Root => {
                KernelError::manifest_validation_failed(BUILTIN_VOCABULARY_NOT_A_MODULE)
            }
            ModuleRole::Import => KernelError::new(
                "ERR_INVALID_IMPORT_TARGET",
                builtin_vocabulary_import_message(
                    path,
                    module_doc
                        .get("metadata")
                        .and_then(|metadata| metadata.get("version"))
                        .and_then(Value::as_str),
                ),
            ),
        });
    }
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
    if is_reserved_kind_prefix(&module_name) {
        return Err(KernelError::new(
            "ERR_KIND_PREFIX_RESERVED",
            match role {
                ModuleRole::Root => reserved_module_name_message(&module_name),
                ModuleRole::Import => reserved_library_name_message(path, &module_name),
            },
        ));
    }
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

    reject_need_types(&documents, &loaded.source)?;

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
    read_reference_forms(&context, &mut documents, role)?;
    let targets = build_ref_targets(&context, &documents)?;
    for document in documents.iter_mut() {
        if kind_of(document).is_some_and(skips_ref_resolution) {
            continue;
        }
        resolve_ref_sentinels(document, &targets);
    }
    reject_leftover_references(&context, &documents)?;

    let mut includes = IncludeCache::new();
    let module_files = env.loader.module_files(&context.source);
    for document in documents.iter_mut().skip(1) {
        // Owned, because reading the kind borrows the document that the embed
        // resolution below rewrites in place.
        let Some(kind) = kind_of(document).map(str::to_owned) else {
            return Err(KernelError::manifest_validation_failed(format!(
                "'{}' contains a document with no `kind:`. Every document after the module doc declares a resource or a {DEFINITION}.",
                context.source
            )));
        };
        // Embedded files are read here, immediately before the resource is
        // built, so a marker never reaches a controller and the schema below
        // sees the resolved value.
        //
        // BEFORE the definition skip, not after: the Node kernel resolves embeds
        // inside a `Telo.Definition` too, so skipping them here would make one
        // manifest mean two different things on the two kernels — and the
        // divergence is silent, because an unresolved marker left in a `schema:`
        // default is injected verbatim into every consumer's config by AJV's
        // `useDefaults` with nothing raising.
        resolve_include_sentinels(document, &context.source, &module_files, &mut includes)?;
        if kind == DEFINITION {
            continue;
        }
        let name = resource_name(document, &context.source)?;
        let definition = resolve_resource_kind(&context, &kind, name)?;
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
    ("resources", "resource inputs supplied by the importer"),
    ("needs", "needs, which a host or an importer supplies"),
    ("tracing", "exporting trace spans"),
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

/// A `Telo.NeedType` registers a kind whose resources are need fulfilments, which
/// this kernel does not implement. Refused by name rather than as an unknown
/// built-in kind, so the message says what is missing.
fn reject_need_types(documents: &[Value], source: &str) -> Result<(), KernelError> {
    for document in documents.iter().skip(1) {
        if kind_of(document) != Some(NEED_TYPE) {
            continue;
        }
        let name = name_of(document).unwrap_or("<unnamed>");
        return Err(KernelError::new(
            "ERR_UNSUPPORTED_MANIFEST_FEATURE",
            format!(
                "'{source}' declares `{NEED_TYPE}` '{name}'; this kernel does not implement need types yet"
            ),
        ));
    }
    Ok(())
}

/// Read the objects an author wrote as a reference at a reference slot, before
/// `!ref` resolution writes the marker itself, at reference slots only — so a
/// resource whose own kind declares a `name` field is no reference at all.
///
/// The entry's own module is refused for both spellings, as the Node kernel's
/// load analysis and `telo check` refuse them: the legacy `{ kind, name }` form
/// of a kind declaring no `name` field, and the `__ref` key. An imported
/// library's `{ kind, name }` — what published artifacts carry — is marked as
/// the reference it means, and only its `__ref` key is refused.
fn read_reference_forms(
    context: &ModuleContext,
    documents: &mut [Value],
    role: ModuleRole,
) -> Result<(), KernelError> {
    let kind_declares_name = |written: &str| {
        context
            .resolve_kind(written)
            .ok()
            .map(|definition| declares_name_field(definition.manifest.get("schema").unwrap_or(&Value::Null)))
    };
    for document in documents.iter_mut() {
        let Some(kind) = kind_of(document).map(str::to_owned) else {
            continue;
        };
        if skips_ref_resolution(&kind) {
            continue;
        }
        let label = format!("{kind}/{}", name_of(document).unwrap_or("<unnamed>"));
        let found = if is_module_document(&kind) {
            target_reference_forms(document, &kind_declares_name)
        } else {
            let Some(schema) = context
                .resolve_kind(&kind)
                .ok()
                .and_then(|definition| definition.manifest.get("schema").cloned())
            else {
                continue;
            };
            find_invalid_reference_forms(document, &schema, &kind_declares_name, &value_branch_accepts)
        };
        for invalid in found {
            if role == ModuleRole::Import && invalid.form == ReferenceForm::Object {
                if let Some(Value::Object(object)) = document.pointer_mut(&invalid.pointer) {
                    object.insert(RESOLVED_REFERENCE_MARKER.to_string(), Value::Bool(true));
                }
                continue;
            }
            return Err(KernelError::new(
                "ERR_INVALID_REFERENCE_FORM",
                format!("{label}: {}", reference_form_message(&invalid)),
            ));
        }
    }
    Ok(())
}

/// The objects written as a reference among a module document's `targets:` —
/// an entry that is itself a reference, or an inline step's `invoke:`, the
/// boot-step grammar this kernel runs.
fn target_reference_forms(
    document: &Value,
    kind_declares_name: &dyn Fn(&str) -> Option<bool>,
) -> Vec<InvalidReferenceForm> {
    let Some(targets) = document.get("targets").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for (index, target) in targets.iter().enumerate() {
        let (value, path, pointer) = match target.get("invoke") {
            Some(invoke) if target.get("kind").is_none() => {
                (invoke, format!("targets[{index}].invoke"), format!("/targets/{index}/invoke"))
            }
            _ => (target, format!("targets[{index}]"), format!("/targets/{index}")),
        };
        if let Some((form, name)) = authored_object_form(value, kind_declares_name) {
            found.push(InvalidReferenceForm { path, pointer, form, name });
        }
    }
    found
}

/// Whether a value branch of a union accepts `value`, validated against the
/// branch with the `$defs` of the document it was written in. A branch that
/// does not compile accepts nothing.
fn value_branch_accepts(branch: &Value, root: &Value, value: &Value) -> bool {
    let mut schema = branch.clone();
    if let Some(object) = schema.as_object_mut() {
        for key in ["$defs", "definitions"] {
            if let Some(definitions) = root.get(key) {
                object.entry(key.to_string()).or_insert_with(|| definitions.clone());
            }
        }
    }
    jsonschema::validator_for(&schema).is_ok_and(|validator| validator.is_valid(value))
}

/// Fail on a `!ref` that resolved to nothing, once resolution has run over
/// every document. Swept for explicitly because this kernel has no scopes —
/// unlike Node, no sentinel can legitimately survive to be resolved on demand
/// later.
fn reject_leftover_references(
    context: &ModuleContext,
    documents: &[Value],
) -> Result<(), KernelError> {
    for document in documents {
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
        if is_reserved_kind_prefix(alias) {
            return Err(KernelError::new(
                "ERR_KIND_PREFIX_RESERVED",
                reserved_import_alias_message(alias),
            ));
        }
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
