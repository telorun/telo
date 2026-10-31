import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { expansionBody, expansionTagOf, isTaggedSentinel } from "@telorun/templating";
import { moduleScopedDefResolver, type ModuleScopes } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import type { FamilyExpansion } from "./template-expansion.js";
import { TEMPLATE_BODY_FIELDS } from "./template-expansion.js";
import {
  applyObservedStateNode,
  analyzedKind,
  applyReadingNode,
  type AnalyzedResource,
} from "./validate-observed-state.js";

/**
 * What the CEL `resources` record holds inside a template body, beyond the
 * defining module's readings: the body's own `resources:` entries, a family as
 * a map from element key to member reading.
 *
 * The rule is the module's, applied inside the instance: every entry is
 * readable from every CEL site of the body — the entries' own fields, the
 * definition's `inputs:` and `result:` — and a body name shadows a module
 * resource of the same name, as a body `!ref` resolves siblings first.
 *
 * Browser-safe.
 */
export interface TemplateBodyResources {
  /** The `resources` properties a read at `path` of `definition` sees from its
   *  body, or undefined where the definition has none or `path` is outside it. */
  properties(definition: ResourceManifest, path: string): Record<string, any> | undefined;
  /** The plain body entry `name` is, for a read at `path` of `definition`. */
  entry(definition: ResourceManifest, path: string, name: string): AnalyzedResource | undefined;
}

export interface TemplateBodyResourcesInputs {
  /** The families `definition`'s expansion declared, when it is expanded. A
   *  definition read as written declares its families open: which keys they
   *  hold is the expansion's to decide. */
  familiesOf(definition: ResourceManifest): ReadonlyMap<string, FamilyExpansion> | undefined;
  /** What a resource of `kind`, written in `module`, reads as. */
  analyzed(kind: string, module: string | undefined): AnalyzedResource;
}

interface BodyReading {
  readonly properties: Record<string, any>;
  /** What a read of `resources.<name>` is of, name by name: a plain entry or,
   *  for a family whose members share one kind, that kind. */
  readonly entries: ReadonlyMap<string, AnalyzedResource>;
}

const OPEN = { type: "object", additionalProperties: true } as const;

/** One resource's reading as a `resources.<name>` node. */
function readingNode(resource: AnalyzedResource | undefined): Record<string, any> {
  if (!resource) return OPEN;
  const holder: Record<string, any> = {};
  if (resource.reading) applyReadingNode(holder, "x", resource.reading);
  else if (resource.status) applyObservedStateNode(holder, "x", resource.status);
  else return OPEN;
  return holder.x;
}

/** A family's node: one map per loop, `string` keys typed by their entries and
 *  `int` keys, which JSON Schema cannot spell, left open. */
function familyNode(family: FamilyExpansion, leaf: Record<string, any>): Record<string, any> {
  const keys = family.members[0]?.keys ?? [];
  let node = leaf;
  for (let depth = keys.length - 1; depth >= 0; depth--) {
    node = typeof keys[depth] === "string" ? { type: "object", additionalProperties: node } : {};
  }
  return node;
}

function isEntry(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value) && !isTaggedSentinel(value);
}

export function templateBodyResourcesOf(inputs: TemplateBodyResourcesInputs): TemplateBodyResources {
  const readings = new WeakMap<object, BodyReading | null>();

  const readingOf = (definition: ResourceManifest): BodyReading | null => {
    const known = readings.get(definition);
    if (known !== undefined) return known;
    let reading: BodyReading | null = null;
    const body = (definition as Record<string, unknown>).resources;
    if (definition.kind === "Telo.Definition" && Array.isArray(body)) {
      const module = (definition.metadata as { module?: string } | undefined)?.module;
      const families = inputs.familiesOf(definition) ?? new Map<string, FamilyExpansion>();
      const memberNames = new Set<string>();
      const properties: Record<string, any> = {};
      const entries = new Map<string, AnalyzedResource>();
      for (const family of families.values()) {
        for (const member of family.members) memberNames.add(member.name);
        const kinds = new Set(family.members.map((member) => member.kind));
        const [kind] = kinds;
        const member = kinds.size === 1 && typeof kind === "string" ? inputs.analyzed(kind, module) : undefined;
        if (member) entries.set(family.name, member);
        properties[family.name] = familyNode(family, readingNode(member));
      }
      for (const entry of body) {
        if (!inputs.familiesOf(definition) && expansionTagOf(entry) === "for-each") {
          const name = (expansionBody(entry as never).metadata as { name?: unknown } | undefined)?.name;
          if (typeof name === "string") properties[name] = {};
          continue;
        }
        if (!isEntry(entry) || typeof entry.kind !== "string") continue;
        const name = entry.metadata?.name;
        if (typeof name !== "string" || memberNames.has(name)) continue;
        const analyzed = inputs.analyzed(entry.kind, module);
        entries.set(name, analyzed);
        properties[name] = readingNode(analyzed);
      }
      if (Object.keys(properties).length > 0) reading = { properties, entries };
    }
    readings.set(definition, reading);
    return reading;
  };

  const inBody = (path: string): boolean => TEMPLATE_BODY_FIELDS.includes(path.split(/[.[]/)[0]!);

  return {
    properties: (definition, path) => (inBody(path) ? readingOf(definition)?.properties : undefined),
    entry: (definition, path, name) => (inBody(path) ? readingOf(definition)?.entries.get(name) : undefined),
  };
}

/**
 * The one way every builder of CEL globals gets a template body's entries:
 * kinds read through the declaring module's aliases, families as the
 * definition's expansion declared them (`familiesOf`) or open when it is read
 * as written.
 */
export function bodyResourcesFor(
  defs: DefinitionRegistry,
  aliases: { resolveKind(kind: string): string | undefined },
  scopes: ModuleScopes,
  familiesOf: TemplateBodyResourcesInputs["familiesOf"] = () => undefined,
): TemplateBodyResources {
  const resolve = moduleScopedDefResolver<ResourceDefinition>(defs, aliases, scopes);
  return templateBodyResourcesOf({
    familiesOf,
    analyzed: (kind, module) => analyzedKind(resolve, kind, module),
  });
}
