import type { AvailableKind, ParsedManifest, ParsedResource } from "./model";

/** The kernel built-ins `Telo.Application` / `Telo.Library` have no
 *  `Telo.Definition`, so the module root never appears in `viewData.kinds` or
 *  `manifest.resources` on its own. This adapter synthesizes both — an
 *  `AvailableKind` and a `ParsedResource`-shaped view of the module root — so
 *  selection, lookup, and the PickCanvas topology dispatch route the root
 *  through the exact same path as every other resource, rather than scattering
 *  "is it the root?" checks across the views. Applications and libraries share
 *  the same overview canvas; only the Application carries `targets`. */

export const APPLICATION_KIND_ID = "Telo.Application";
export const LIBRARY_KIND_ID = "Telo.Library";

/** Topology value that routes a module root to the overview graph canvas.
 *  Shared by both root kinds — the canvas is identical for either. */
export const MODULE_OVERVIEW_TOPOLOGY = "ModuleOverview";

/** True for a synthesized module-root kind (Application or Library). */
export function isModuleRootKind(kind: string): boolean {
  return kind === APPLICATION_KIND_ID || kind === LIBRARY_KIND_ID;
}

/** The synthesized kind id for a module manifest's root. */
function rootKindId(manifest: ParsedManifest): string {
  return manifest.kind === "Application" ? APPLICATION_KIND_ID : LIBRARY_KIND_ID;
}

/** Schema over the root's editable surface — used to satisfy the topology
 *  dispatch's `schema` guard and to drive the read-only detail body. The graph
 *  canvas reads resources directly, not this. `targets` is Application-only. */
function rootSchema(isApplication: boolean): Record<string, unknown> {
  return {
    type: "object",
    "x-telo-topology": MODULE_OVERVIEW_TOPOLOGY,
    properties: {
      ...(isApplication
        ? { targets: { type: "array", items: { type: "string" }, description: "Resources run on boot." } }
        : {}),
      variables: { type: "object", description: "Env-bound variables." },
      secrets: { type: "object", description: "Env-bound secrets." },
      ...(isApplication ? { ports: { type: "object", description: "Declared inbound ports." } } : {}),
    },
  };
}

/** The synthesized `AvailableKind` for a module root (Application or Library). */
export function moduleRootKind(manifest: ParsedManifest): AvailableKind {
  const isApplication = manifest.kind === "Application";
  const kindId = rootKindId(manifest);
  return {
    fullKind: kindId,
    alias: "Telo",
    kindName: isApplication ? "Application" : "Library",
    capability: kindId,
    topology: MODULE_OVERVIEW_TOPOLOGY,
    schema: rootSchema(isApplication),
  };
}

/** A `ParsedResource`-shaped projection of the module root, keyed by the module
 *  name. `fields` mirrors the root's editable blocks; only Applications carry
 *  `targets` / `ports`. */
export function moduleRootResource(manifest: ParsedManifest): ParsedResource {
  const fields: Record<string, unknown> = { metadata: manifest.metadata };
  if (manifest.kind === "Application") {
    fields.targets = manifest.targets;
    if (manifest.variables) fields.variables = manifest.variables;
    if (manifest.secrets) fields.secrets = manifest.secrets;
    if (manifest.ports) fields.ports = manifest.ports;
  }
  return { kind: rootKindId(manifest), name: manifest.metadata.name, fields };
}
