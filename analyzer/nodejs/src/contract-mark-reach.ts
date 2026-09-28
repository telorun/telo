import type { ResourceManifest } from "@telorun/sdk";
import { SCHEMA_REGION_KEYS } from "./schema-region.js";
import { resolveTypeFieldToSchema } from "./validate-cel-context.js";

/**
 * Where `telo check` finds the contracts the kernel binds, and where each schema
 * node a contract reaches was written — the static half of the two data-schema
 * annotations the kernel reads off a bound contract (`x-telo-sensitive`,
 * `x-telo-span-attribute`).
 *
 * The kernel walks a resolved contract, following `$ref` into `$defs` entries
 * and named shapes; `telo check` runs the same walk over the same resolved
 * contract, then maps each node back to the manifest and path it was written at.
 */

export interface ContractSite {
  manifest: ResourceManifest;
  /** Path to the `inputType` / `outputType` key. */
  path: (string | number)[];
  /** The contract's root schema, resolved as the kernel resolves it. */
  schema: Record<string, any>;
}

export interface WrittenAt {
  manifest: ResourceManifest;
  path: (string | number)[];
}

const CONTRACT_KEYS = new Set(["inputType", "outputType"]);

/** A declared contract is an `inputType` / `outputType` not nested in another
 *  schema — on a resource, a definition, or a declaration inside one (a
 *  template body's entry, a `with:` member). */
export function contractSites(manifests: readonly ResourceManifest[]): ContractSite[] {
  const all = manifests as unknown as Record<string, any>[];
  const sites: ContractSite[] = [];
  for (const manifest of manifests) {
    const walk = (node: unknown, path: (string | number)[], seen: Set<object>): void => {
      if (!node || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) {
        node.forEach((child, i) => walk(child, [...path, i], seen));
        return;
      }
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if (CONTRACT_KEYS.has(key)) {
          const schema = resolveTypeFieldToSchema(child, all);
          if (schema) sites.push({ manifest, path: [...path, key], schema });
          continue;
        }
        if (SCHEMA_REGION_KEYS.includes(key)) continue;
        walk(child, [...path, key], seen);
      }
    };
    walk(manifest, [], new Set());
  }
  return sites;
}

/** Resolves a named shape's `$ref` to the shape as written, so a node reached
 *  through it maps back to the shape's own manifest. */
export function namedShapeResolver(
  manifests: readonly ResourceManifest[],
): (ref: string) => Record<string, any> | undefined {
  const all = manifests as unknown as Record<string, any>[];
  return (ref) => resolveTypeFieldToSchema({ $ref: ref }, all);
}

/** Every object node in `manifests`, keyed by identity, at the first place it
 *  is written. */
export function writtenNodeIndex(manifests: readonly ResourceManifest[]): Map<object, WrittenAt> {
  const index = new Map<object, WrittenAt>();
  for (const manifest of manifests) {
    const walk = (node: unknown, path: (string | number)[]): void => {
      if (!node || typeof node !== "object" || index.has(node)) return;
      index.set(node, { manifest, path });
      if (Array.isArray(node)) node.forEach((child, i) => walk(child, [...path, i]));
      else for (const [key, child] of Object.entries(node)) walk(child, [...path, key]);
    };
    walk(manifest, []);
  }
  return index;
}

/** The nodes carrying `annotation` as an own key, where each is written. */
export function markedNodes(
  manifests: readonly ResourceManifest[],
  annotation: string,
): Map<object, WrittenAt> {
  const marks = new Map<object, WrittenAt>();
  for (const manifest of manifests) {
    const seen = new Set<object>();
    const walk = (node: unknown, path: (string | number)[]): void => {
      if (!node || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) {
        node.forEach((child, i) => walk(child, [...path, i]));
        return;
      }
      if (Object.hasOwn(node, annotation) && !marks.has(node)) marks.set(node, { manifest, path });
      for (const [key, child] of Object.entries(node)) walk(child, [...path, key]);
    };
    walk(manifest, []);
  }
  return marks;
}

/** The capability of a manifest's kind, resolved through the alias scope of
 *  the module that wrote it and inherited along `extends`. */
export type KindCapability = (manifest: ResourceManifest) => string | undefined;

/** True when `written` sits in a named shape's own schema — one an author
 *  declared (its kind's capability is `Telo.Type`), not a contract written
 *  inline and extracted into a shape. */
export function inNamedShape(written: WrittenAt, capabilityOf: KindCapability): boolean {
  const origin = (written.manifest.metadata as { xTeloOrigin?: unknown } | undefined)?.xTeloOrigin;
  return (
    origin === undefined &&
    written.path[0] === "schema" &&
    capabilityOf(written.manifest) === "Telo.Type"
  );
}

/** A named shape its library exports, which an importer's contract may reach
 *  even when nothing in this analysis does. */
export function isExportedShape(
  manifest: ResourceManifest,
  manifests: readonly ResourceManifest[],
): boolean {
  const owner = (manifest.metadata as { module?: string } | undefined)?.module;
  const name = manifest.metadata?.name;
  if (typeof name !== "string") return false;
  return manifests.some((m) => {
    if (m.kind !== "Telo.Library" || m.metadata?.name !== owner) return false;
    const exported = (m as { exports?: { resources?: unknown } }).exports?.resources;
    return Array.isArray(exported) && exported.includes(name);
  });
}

/** Where an unreached mark sits, for the message saying why nothing reads it. */
export function unreachedMarkPlace(written: WrittenAt, capabilityOf: KindCapability): string {
  if (inNamedShape(written, capabilityOf)) return "in a named shape no contract uses";
  const extracted =
    (written.manifest.metadata as { xTeloOrigin?: unknown } | undefined)?.xTeloOrigin !== undefined;
  const region = written.path.find(
    (segment): segment is string =>
      typeof segment === "string" && SCHEMA_REGION_KEYS.includes(segment),
  );
  if (extracted || region === "inputType" || region === "outputType") {
    return "somewhere the contract does not reach through `properties`";
  }
  return region === undefined ? "not inside a schema at all" : `inside \`${region}\``;
}
