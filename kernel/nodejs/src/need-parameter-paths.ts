import type { NeedTable, NeedTableEntry, NeedTypeShape } from "@telorun/analyzer";
import { isModulePathSentinel } from "@telorun/templating";
import { refuseMismatchedHostPaths } from "./host-paths.js";
import type { ModuleFileLookup } from "./module-file-resolution.js";
import { resolveModulePath } from "./resolve-include-sentinels.js";

/**
 * Every `!module-path` a need's `parameters:` hold, resolved at load against the
 * module declaring the need to the absolute path of what it names, and held to
 * the `entry` and `mediaType` its parameter's host path declares — so `ctx.resolveNeed` and every
 * other reader of the load's need table see the path, as a host-path slot of a
 * resource does once it is created.
 *
 * Each table entry's need is replaced by a copy holding the resolved parameters;
 * the declaration is left as written. Needs of one declaration share the copy.
 */
export async function resolveNeedParameterPaths(
  table: NeedTable,
  shapeOf: (entry: NeedTableEntry) => NeedTypeShape | undefined,
  lookup: ModuleFileLookup,
): Promise<void> {
  const resolved = new Map<NeedTableEntry["need"], NeedTableEntry["need"]>();
  for (const entry of table.entries) {
    const need = entry.need;
    if (!holdsModulePath(need.parameters)) continue;
    let copy = resolved.get(need);
    if (!copy) {
      const parameters = await resolvedCopy(need.parameters, entry.declaredBy, lookup);
      const schema = shapeOf(entry)?.parameters;
      if (schema && parameters && typeof parameters === "object") {
        refuseMismatchedHostPaths(
          parameters as Record<string, unknown>,
          schema as Record<string, any>,
          `Need '${need.name}' of module '${entry.moduleName}', parameters`,
        );
      }
      copy = { ...need, parameters };
      resolved.set(need, copy);
    }
    entry.need = copy;
  }
}

function holdsModulePath(value: unknown): boolean {
  if (isModulePathSentinel(value)) return true;
  if (Array.isArray(value)) return value.some(holdsModulePath);
  if (value !== null && typeof value === "object") return Object.values(value).some(holdsModulePath);
  return false;
}

async function resolvedCopy(value: unknown, moduleSource: string, lookup: ModuleFileLookup): Promise<unknown> {
  if (isModulePathSentinel(value)) return resolveModulePath(value, moduleSource, lookup);
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => resolvedCopy(item, moduleSource, lookup)));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = await resolvedCopy(item, moduleSource, lookup);
    return out;
  }
  return value;
}
