/**
 * **Plain-encoded literals read as the instances their slots hold**, at resource
 * creation.
 *
 * A literal written in its plain encoding at an instance-typed slot (RFC 3339
 * text at a `Telo.Timestamp`) becomes the instance before validation — the
 * reading `telo check` applies too: at the kind's own config, and at every slot
 * typed from elsewhere (a call's `inputs:`, a schema-from slot), enumerated by the
 * analyzer's one reader of those sites. Text the encoding refuses stays, and
 * validation reports it.
 *
 * Once per manifest object: a `with:`-scoped resource is created on every run of
 * its scope, and a decoded literal already is the instance, so a second walk
 * would change nothing and cost a whole-manifest traversal on a request path.
 */
import { decodePlainLiterals, type AnalysisRegistry } from "@telorun/analyzer";
import type { EvaluationContext, ResourceManifest } from "@telorun/sdk";

type SchemaResolver = (ref: string) => Record<string, any> | undefined;

/** What decoding reads from the kernel. */
export interface LiteralDecodingHost {
  registry(): AnalysisRegistry;
  /** The root Application's own module names. */
  rootModules(): ReadonlySet<string>;
  /** Every declaration a named type resolves against. */
  typeDeclarations(): Record<string, any>[];
}

const decoded = new WeakSet<object>();

export function decodeResourceLiterals(
  resource: ResourceManifest,
  configSchema: Record<string, any>,
  evalContext: EvaluationContext,
  host: LiteralDecodingHost,
  schemaForRef: SchemaResolver,
): void {
  if (decoded.has(resource)) return;
  decodePlainLiterals(resource, configSchema, schemaForRef);
  const slots = host.registry().derivedSlotsOf(resource, {
    rootModules: host.rootModules(),
    typeManifests: host.typeDeclarations(),
    // Declarations, never instances: a call target need not exist yet, and a
    // step's edge is no init-order edge.
    resolveTarget: (ref) =>
      typeof ref.name === "string"
        ? (evalContext.resolveDeclaredManifest?.(ref.name, ref.alias) as
            | Record<string, any>
            | undefined)
        : undefined,
  });
  for (const slot of slots) {
    const next = decodePlainLiterals(slot.value, slot.schema, schemaForRef);
    if (next !== slot.value) slot.replace(next);
  }
  decoded.add(resource);
}
