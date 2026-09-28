import type { ResourceManifest } from "@telorun/sdk";
import type { ModuleDocuments } from "./module-documents.js";
import { isModuleKind } from "./module-kinds.js";
import { readResourceInputs } from "./resource-input.js";

/**
 * Every imported library's own declarations, by (module, name) — what a
 * consumer's flattened view does not carry, since it forwards only a library's
 * export surface.
 *
 * Read by a projection hop whose holder is a library's declaration: the
 * reference it writes names that library's resource, which may be internal. A
 * declaration found here is input to that resolution ONLY; nothing here enters
 * the call graph, the dependency graph, the module graph or the `resources`
 * scope. Built once per analysis from the documents every host already
 * collects for the zone stage and the throws walk.
 */
export interface LibraryDeclarations {
  /** True when `module` is an imported library this analysis holds documents for. */
  holds(module: string): boolean;
  /** The resource `module` declares under `name`. */
  declaration(module: string, name: string): ResourceManifest | undefined;
  /** True when `name` is one of the resource INPUTS `module` requires of its importer. */
  isInput(module: string, name: string): boolean;
  /** The `Telo.Import` `module` declares under `alias`. */
  importOf(module: string, alias: string): ResourceManifest | undefined;
}

const key = (module: string, name: string): string => `${module}\0${name}`;

export function libraryDeclarations(documents: readonly ModuleDocuments[]): LibraryDeclarations {
  const modules = new Set<string>();
  const declarations = new Map<string, ResourceManifest>();
  const imports = new Map<string, ResourceManifest>();
  const inputs = new Set<string>();
  for (const library of documents) {
    modules.add(library.module);
    for (const manifest of library.manifests) {
      const name = manifest.metadata?.name;
      if (isModuleKind(manifest.kind)) {
        for (const input of readResourceInputs(manifest)) inputs.add(key(library.module, input.name));
        continue;
      }
      if (typeof name !== "string") continue;
      if (manifest.kind === "Telo.Import") imports.set(key(library.module, name), manifest);
      else if (manifest.kind !== "Telo.Definition" && manifest.kind !== "Telo.Abstract") {
        declarations.set(key(library.module, name), manifest);
      }
    }
  }
  return {
    holds: (module) => modules.has(module),
    declaration: (module, name) => declarations.get(key(module, name)),
    isInput: (module, name) => inputs.has(key(module, name)),
    importOf: (module, alias) => imports.get(key(module, alias)),
  };
}
