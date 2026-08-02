//! Per-module scope: the kinds a module declares, the imports it reached them
//! through, and the resources it owns.
//! Mirrors `../../nodejs/src/module-context.ts`.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use crate::controller_registry::Definition;
use crate::error::KernelError;
use crate::evaluation_context::EvaluationContext;
use crate::runtime_registry::ControllerPolicy;

pub struct ModuleContext {
    /// `metadata.name` of the module's `Telo.Application` / `Telo.Library` doc —
    /// the canonical kind prefix, not a locator.
    pub name: String,
    /// Canonical path of the manifest file.
    pub source: String,
    /// Import alias → the module it resolved to.
    pub imports: HashMap<String, Rc<ModuleContext>>,
    /// Kind suffix → definition, for kinds this module declares.
    pub definitions: HashMap<String, Rc<Definition>>,
    /// `exports.kinds`. `None` means the module declared no list and is
    /// therefore ungated — the same "declaring the block opts into the gate"
    /// rule the Node kernel applies.
    pub exported_kinds: Option<HashSet<String>>,
    /// `exports.resources` — the instance names importers may reference.
    pub exported_resources: HashSet<String>,
    pub resources: EvaluationContext,
    /// Controller selection policy inherited from the import that reached this
    /// module; the root application's is the default.
    pub policy: ControllerPolicy,
}

impl ModuleContext {
    /// Resolve a `kind:` string written in this module's scope to its
    /// definition. Handles the three prefix forms: `Self.<Kind>` for a kind this
    /// module declares, `<Alias>.<Kind>` for an import's, and the canonical
    /// `<module>.<Kind>` a resolved reference carries.
    pub fn resolve_kind(&self, kind: &str) -> Result<Rc<Definition>, KernelError> {
        let Some((prefix, suffix)) = kind.split_once('.') else {
            return Err(KernelError::undefined_kind(format!(
                "kind '{kind}' is not qualified. Write `<Alias>.<Kind>`, or `Self.<Kind>` for a kind this module declares."
            )));
        };

        if prefix == "Self" || prefix == self.name {
            // Self-resolution is ungated: `exports.kinds` gates importers, not
            // the declaring module's own use.
            return self.definitions.get(suffix).cloned().ok_or_else(|| {
                KernelError::undefined_kind(format!(
                    "module '{}' declares no kind '{suffix}'",
                    self.name
                ))
            });
        }

        let import = self.imports.get(prefix).ok_or_else(|| {
            KernelError::undefined_kind(format!(
                "kind '{kind}' names import alias '{prefix}', which is not declared in '{}'. Declared aliases: {}",
                self.name,
                self.alias_list()
            ))
        })?;

        if let Some(exported) = &import.exported_kinds {
            if !exported.contains(suffix) {
                let mut kinds: Vec<&str> = exported.iter().map(String::as_str).collect();
                kinds.sort_unstable();
                return Err(KernelError::new(
                    "ERR_KIND_NOT_EXPORTED",
                    format!(
                        "module '{}' does not export kind '{suffix}'. It exports: {}",
                        import.name,
                        kinds.join(", ")
                    ),
                ));
            }
        }

        import.definitions.get(suffix).cloned().ok_or_else(|| {
            KernelError::undefined_kind(format!(
                "module '{}' declares no kind '{suffix}'",
                import.name
            ))
        })
    }

    /// The instance an importer reaches as `!ref <Alias>.<name>`, gated by
    /// `exports.resources`.
    pub fn exported_resource(
        &self,
        name: &str,
    ) -> Result<Rc<crate::evaluation_context::ResourceInstance>, KernelError> {
        if !self.exported_resources.contains(name) {
            let mut names: Vec<&str> = self.exported_resources.iter().map(String::as_str).collect();
            names.sort_unstable();
            return Err(KernelError::resource_not_found(format!(
                "module '{}' does not export resource '{name}'. It exports: {}",
                self.name,
                if names.is_empty() {
                    "(nothing)".to_string()
                } else {
                    names.join(", ")
                }
            )));
        }
        self.resources.require_resource(name)
    }

    fn alias_list(&self) -> String {
        let mut aliases: Vec<&str> = self.imports.keys().map(String::as_str).collect();
        aliases.sort_unstable();
        if aliases.is_empty() {
            return "(none)".to_string();
        }
        aliases.join(", ")
    }
}
