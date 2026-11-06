import type { ResourceManifest } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import { holdsHostPath } from "./host-path-slot.js";
import type { ModuleDocuments } from "./module-documents.js";
import { inputValueSchema } from "./residual-schema.js";
import { canonicalShapeSchema, withCanonicalRefSentinels } from "./resolve-schema-type-refs.js";

/**
 * What a library declares for its importer to supply under `variables:` / `secrets:`,
 * read for one `Telo.Import` from the library documents the analysis holds — the
 * statically known half of the import decode site (invocation contract §4.6), whose
 * runtime half the import controller settles.
 *
 * The library is found by the import's resolved source, the identity the kernel keys a
 * library on, and otherwise by its module name when exactly one library carries it.
 * Undefined when the analysis holds no documents for it: a library whose declarations
 * this analysis cannot see is not judged.
 */
export function importInputsSchema(
  importDoc: ResourceManifest,
  documents: readonly ModuleDocuments[],
  /** Each module's import table, so a shape an entry names resolves in the
   *  library's own scope; absent, such a reference stays as written. */
  aliasesByModule?: ReadonlyMap<string, Pick<AliasResolver, "moduleForAlias">>,
): Record<string, any> | undefined {
  const found = libraryDocOf(importDoc, documents);
  if (!found) return undefined;
  const { library, documentSet } = found;
  let schema = schemas.get(library);
  if (!schema) schemas.set(library, (schema = blocksSchema(library, documentSet, aliasesByModule, () => true)));
  return schema;
}

/**
 * The same schema, less every entry holding a host path: what an expression supplying one
 * is joined against. A host-path entry's expressions are the import host-path pass's
 * (`HOST_PATH_UNTYPED_SOURCE`), so each finding is reported once.
 */
export function importInputsJoinSchema(
  importDoc: ResourceManifest,
  documents: readonly ModuleDocuments[],
  aliasesByModule?: ReadonlyMap<string, Pick<AliasResolver, "moduleForAlias">>,
): Record<string, any> | undefined {
  const found = libraryDocOf(importDoc, documents);
  if (!found) return undefined;
  const { library, documentSet } = found;
  let schema = joinSchemas.get(library);
  if (!schema) {
    joinSchemas.set(
      library,
      (schema = blocksSchema(library, documentSet, aliasesByModule, (entry) => !holdsHostPath(entry))),
    );
  }
  return schema;
}

/** Memoized per library document, so a validator compiled for one is reused by
 *  every import of it. */
const schemas = new WeakMap<object, Record<string, any>>();
const joinSchemas = new WeakMap<object, Record<string, any>>();

const BLOCKS = ["variables", "secrets"] as const;

/** A shape an entry names is the library's: its references resolve in the
 *  library's own module and imports, never the importer's. */
function blocksSchema(
  library: ResourceManifest,
  documentSet: ModuleDocuments,
  aliasesByModule: ReadonlyMap<string, Pick<AliasResolver, "moduleForAlias">> | undefined,
  keep: (entry: Record<string, any>) => boolean,
): Record<string, any> {
  const moduleForAlias = (alias: string): string | undefined =>
    aliasesByModule?.get(documentSet.module)?.moduleForAlias(alias);
  const inLibrary = (entry: Record<string, unknown>): Record<string, any> =>
    canonicalShapeSchema(
      withCanonicalRefSentinels(entry, documentSet.module, moduleForAlias) as Record<string, any>,
      documentSet.module,
      moduleForAlias,
    );
  const properties: Record<string, unknown> = {};
  for (const block of BLOCKS) {
    const declared = (library as Record<string, unknown>)[block];
    const entries: Record<string, unknown> = {};
    if (declared && typeof declared === "object" && !Array.isArray(declared)) {
      for (const [name, entry] of Object.entries(declared as Record<string, unknown>)) {
        if (entry && typeof entry === "object" && !Array.isArray(entry) && keep(entry as Record<string, any>)) {
          entries[name] = inputValueSchema(inLibrary(entry as Record<string, unknown>));
        }
      }
    }
    properties[block] = { type: "object", properties: entries };
  }
  return { type: "object", properties };
}

function libraryDocOf(
  importDoc: ResourceManifest,
  documents: readonly ModuleDocuments[],
): { library: ResourceManifest; documentSet: ModuleDocuments } | undefined {
  if (importDoc.kind !== "Telo.Import") return undefined;
  const meta = importDoc.metadata as { resolvedSource?: string; resolvedModuleName?: string } | undefined;
  const bySource = meta?.resolvedSource
    ? documents.find((documentSet) => documentSet.sourceId === meta.resolvedSource)
    : undefined;
  const byName = documents.filter((documentSet) => documentSet.module === meta?.resolvedModuleName);
  const found = bySource ?? (byName.length === 1 ? byName[0] : undefined);
  const library = found?.manifests.find((manifest) => manifest.kind === "Telo.Library");
  return library && found ? { library, documentSet: found } : undefined;
}
