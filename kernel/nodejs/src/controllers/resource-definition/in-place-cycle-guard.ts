import {
  callableInstanceSchemaDocuments,
  inPlaceCycleMessage,
  localInPlaceCycles,
  moduleInputSchemaDocuments,
  NEED_TYPE_KIND,
  needTypeOf,
  shapeInPlaceCycle,
  type DefResolver,
  type DocumentCycle,
} from "@telorun/analyzer";
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { parseCanonicalTypeSchemaId, RuntimeError } from "@telorun/sdk";

/**
 * `ERR_SCHEMA_IN_PLACE_CYCLE` — a schema whose references come back to the node
 * they left without descending into the value, which no validator finishes
 * validating against. Refused where it is registered, before any value is
 * validated against it, by the rule `telo check` reports as
 * `SCHEMA_IN_PLACE_CYCLE` (`schema-in-place-cycle.ts`).
 */
const CODE = "ERR_SCHEMA_IN_PLACE_CYCLE";

function refuse(owner: string, cycles: readonly DocumentCycle[]): void {
  const [first] = cycles;
  if (!first) return;
  throw new RuntimeError(CODE, inPlaceCycleMessage(owner, first.cycle, (document) => document));
}

/** A kind's own schemas: nothing references them by their field, so only their
 *  own local references can close a cycle through them. */
export function refuseInPlaceCycleDefinition(definition: ResourceDefinition): void {
  const kind = needTypeOf(definition) ? NEED_TYPE_KIND : definition.kind;
  refuse(`${kind} '${String(definition.metadata?.name)}'`, localInPlaceCycles(definition));
}

/** A callable instance's own signature schemas. */
export function refuseInPlaceCycleInstance(resource: ResourceManifest, resolve: DefResolver): void {
  const documents = callableInstanceSchemaDocuments(resource, resolve);
  if (documents.length === 0) return;
  refuse(`${resource.kind} '${String(resource.metadata?.name)}'`, localInPlaceCycles(documents));
}

/** A module document's `variables:` / `secrets:` entries, each a document of
 *  its own: refused before any input is validated against one. */
export function refuseInPlaceCycleModuleInputs(moduleDoc: ResourceManifest): void {
  refuse(`${moduleDoc.kind} '${String(moduleDoc.metadata?.name)}'`, localInPlaceCycles(moduleInputSchemaDocuments(moduleDoc)));
}

/** A named shape registered as `id`, every shape it reaches read through
 *  `lookup`. */
export function refuseInPlaceCycleShape(
  resource: ResourceManifest,
  id: string,
  schema: Record<string, unknown>,
  lookup: (id: string) => unknown,
): void {
  const cycle = shapeInPlaceCycle(id, schema, lookup);
  if (!cycle) return;
  const name = String(resource.metadata?.name);
  const module = resource.metadata?.module;
  const label = (document: string): string => {
    const named = parseCanonicalTypeSchemaId(document);
    if (!named) return document;
    return named.moduleName === module ? named.typeName : `${named.moduleName}.${named.typeName}`;
  };
  throw new RuntimeError(CODE, inPlaceCycleMessage(`${resource.kind} '${name}'`, cycle, label));
}
