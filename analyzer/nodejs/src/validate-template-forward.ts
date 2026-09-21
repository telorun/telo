import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { moduleScopedDefResolver, type AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { effectiveAuthorSchema } from "./extends-resolution.js";
import { isForwardedDeclaration } from "./forwarded-declaration.js";
import { moduleAliasScope } from "./module-alias-scope.js";
import { checkSchemaCompatibility } from "./schema-compat.js";
import { gatherPropertySchemas, resolveLocalRef } from "./schema-walk.js";
import { templateBodies } from "./template-body.js";
import { formatPath, templateForwardsOf } from "./template-forward.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/**
 * A FORWARDED FIELD MUST BE DECLARED ASSIGNABLE TO WHERE IT GOES.
 *
 * A body entry holding `!cel "self.<path>"` hands the instance's value to the
 * entry verbatim, where it is checked as the entry kind's own field. So the
 * schema a templated kind declares for that path is a promise to its consumers
 * about what the entry will accept — and one that has drifted from the entry
 * admits values the entry refuses: the consumer's `telo check` reports them at
 * its own line, pointing at a constraint the kind's schema never mentioned.
 *
 * Reported at the declaring kind, in its own module's analysis, through the
 * comparison every other contract check uses (`checkSchemaCompatibility`), so
 * only a DEFINITE mismatch is reported — a type conflict, a field the entry
 * requires that the declaration does not have. Both sides are read the way a
 * resource of their kind is validated: local `$ref`s against their own schema,
 * a static `x-telo-schema-from` against the kind that declares it.
 *
 * Entry-module-scoped: a dependency's kinds are its own to fix. Browser-safe.
 */
export function validateTemplateForwards(
  manifests: readonly ResourceManifest[],
  registry: DefinitionRegistry,
  aliases: AliasResolver,
  aliasesByModule: Map<string, AliasResolver>,
  rootModules: ReadonlySet<string>,
): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];
  const scopes = { aliasesByModule, rootModules };
  const resolveDef = moduleScopedDefResolver<ResourceDefinition>(registry, aliases, scopes);

  for (const m of manifests) {
    if (m.kind !== "Telo.Definition" || isForwardedDeclaration(m)) continue;
    const meta = m.metadata as { name?: string; module?: string; source?: string } | undefined;
    if (typeof meta?.name !== "string") continue;
    if (meta.module && !rootModules.has(meta.module)) continue;
    const definition = m as unknown as ResourceDefinition;
    const ownSchema = (m as { schema?: unknown }).schema as Record<string, any> | undefined;
    const authorSchema = effectiveAuthorSchema(definition, resolveDef);
    const ownScope = moduleAliasScope(m.metadata, aliases, aliasesByModule);

    for (const body of templateBodies(m, registry, aliases, scopes)) {
      if (!body.definition) continue;
      const entrySchema = registry.effectiveSchemaOf(body.definition) as Record<string, any> | undefined;
      if (!entrySchema) continue;
      const entryScope = moduleAliasScope(body.definition.metadata, aliases, aliasesByModule);
      const entryName = body.manifest.metadata?.name;

      for (const forward of templateForwardsOf(body.manifest)) {
        const declared = schemaAt(authorSchema, forward.self, registry, ownScope);
        const target = schemaAt(entrySchema, forward.at, registry, entryScope);
        if (!declared || !target) continue;
        const { compatible, issues } = checkSchemaCompatibility(declared, target, (ref) =>
          registry.schemaForId(ref),
        );
        if (compatible) continue;
        const selfPath = forward.self.join(".");
        const at = formatPath(forward.at);
        out.push({
          severity: DiagnosticSeverity.Error,
          code: "TEMPLATE_FORWARD_INCOMPATIBLE",
          source: SOURCE,
          message:
            `Telo.Definition/${meta.name}: '${selfPath}' is forwarded by '!cel "self.${selfPath}"' ` +
            `into the ${body.manifest.kind} entry '${typeof entryName === "string" ? entryName : body.prefix}' ` +
            `at '${at}', but the schema declared for it here is not assignable to that field's: ` +
            `${issues.join("; ")}. A consumer's value is checked against the entry's field, so a ` +
            `declaration disagreeing with it describes values the entry refuses: align it with ` +
            `the entry's field.`,
          data: {
            resource: { kind: m.kind, name: meta.name },
            filePath: meta.source,
            path: declaredIn(ownSchema, forward.self)
              ? `schema.${forward.self.map((key) => `properties.${key}`).join(".")}`
              : `${body.prefix}.${at}`,
          },
        });
      }
    }
  }
  return out;
}

/** Whether the definition's OWN `schema:` writes this property chain — where a
 *  report can point. An inherited one has no line in this document. */
function declaredIn(schema: Record<string, any> | undefined, path: readonly string[]): boolean {
  let node: unknown = schema;
  for (const key of path) {
    const properties = (node as { properties?: Record<string, unknown> } | undefined)?.properties;
    if (!properties || typeof properties !== "object" || !(key in properties)) return false;
    node = properties[key];
  }
  return true;
}

/** The schema a value at `path` is validated against, with every local `$ref`
 *  and static `x-telo-schema-from` on the way and below it read through. */
function schemaAt(
  root: Record<string, any>,
  path: readonly (string | number)[],
  registry: DefinitionRegistry,
  scope: AliasResolver,
): Record<string, any> | undefined {
  let node: Record<string, any> | undefined = root;
  let nodeRoot: Record<string, any> | undefined = root;
  for (const segment of path) {
    const read = readThrough(node, nodeRoot, registry, scope);
    node = read.node;
    nodeRoot = read.root;
    if (!node) return undefined;
    if (typeof segment === "number") {
      const items: unknown = node.items;
      const item = Array.isArray(items) ? items[segment] : items;
      node = item && typeof item === "object" ? (item as Record<string, any>) : undefined;
    } else {
      node = gatherPropertySchemas(node, nodeRoot ?? {}).find(([key]) => key === segment)?.[1];
    }
    if (!node) return undefined;
  }
  return materialize(node, nodeRoot, registry, scope, new Set());
}

/**
 * One node read through what it points at. A static `x-telo-schema-from` is
 * replaced by the schema it derives (its siblings kept), whose own local `$ref`s
 * belong to the kind it was read off — so below it no local reference is
 * followed, and one left in place says nothing to the comparison.
 */
function readThrough(
  node: Record<string, any> | undefined,
  root: Record<string, any> | undefined,
  registry: DefinitionRegistry,
  scope: AliasResolver,
): { node: Record<string, any> | undefined; root: Record<string, any> | undefined } {
  let current = node;
  let currentRoot = root;
  for (let hop = 0; current && hop < 16; hop++) {
    const ref = current.$ref;
    if (typeof ref === "string") {
      const resolved = resolveLocalRef(current, currentRoot ?? {});
      if (resolved === current) break;
      current = resolved;
      continue;
    }
    const schemaFrom = current["x-telo-schema-from"];
    if (typeof schemaFrom === "string") {
      const derived = registry.resolveSchemaFromNode(schemaFrom, scope);
      if (!derived) break;
      const siblings: Record<string, any> = { ...current };
      delete siblings["x-telo-schema-from"];
      current = { ...derived, ...siblings };
      currentRoot = undefined;
      continue;
    }
    break;
  }
  return { node: current, root: currentRoot };
}

function materialize(
  node: Record<string, any>,
  root: Record<string, any> | undefined,
  registry: DefinitionRegistry,
  scope: AliasResolver,
  seen: ReadonlySet<string>,
): Record<string, any> {
  const marker =
    typeof node.$ref === "string"
      ? `ref:${node.$ref}`
      : typeof node["x-telo-schema-from"] === "string"
        ? `from:${node["x-telo-schema-from"]}`
        : undefined;
  if (marker && seen.has(marker)) return node;
  const read = readThrough(node, root, registry, scope);
  const current = read.node ?? node;
  const inner = marker ? new Set([...seen, marker]) : seen;
  const recurse = (child: unknown): unknown =>
    child && typeof child === "object" && !Array.isArray(child)
      ? materialize(child as Record<string, any>, read.root, registry, scope, inner)
      : child;

  const out: Record<string, any> = { ...current };
  if (current.properties && typeof current.properties === "object") {
    out.properties = Object.fromEntries(
      Object.entries(current.properties as Record<string, unknown>).map(([k, v]) => [k, recurse(v)]),
    );
  }
  if (Array.isArray(current.items)) out.items = current.items.map(recurse);
  else if (current.items) out.items = recurse(current.items);
  if (current.additionalProperties && typeof current.additionalProperties === "object") {
    out.additionalProperties = recurse(current.additionalProperties);
  }
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(current[key])) out[key] = (current[key] as unknown[]).map(recurse);
  }
  return out;
}
