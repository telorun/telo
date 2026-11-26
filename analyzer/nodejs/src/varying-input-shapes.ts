/**
 * The named shapes a module's own choices vary, and whether a `variables:` /
 * `secrets:` entry reaches one.
 *
 * An input a choice decides on is settled before the module's documents are
 * expanded, against its declaration; an entry typed through a shape that is
 * only known once the configuration is cannot be settled first, so a choice
 * reading it is undecidable before boot.
 *
 * Browser-safe.
 */
import type { ResourceManifest } from "@telorun/sdk";
import { parseCanonicalTypeSchemaId, parseTeloTypeRef } from "@telorun/sdk";
import { expansionTagOf } from "@telorun/templating";
import { refSentinelTarget } from "./ref-sentinel-target.js";

/** A choice's holder, and the module it is written in. */
export interface ChoiceHolder {
  readonly holder: ResourceManifest;
  readonly module: string | undefined;
}

/** The first varying shape an entry reaches: the reference the entry writes,
 *  and the name of the shape that varies behind it. */
export interface VaryingShapeReached {
  readonly ref: string;
  readonly shape: string;
}

const DATA_KEYS = new Set(["default", "const", "enum", "examples"]);

/**
 * What an entry of `module` reaches. `holders` are the module's own choices
 * that a configuration decides — a choice inside a named shape's document, or
 * a whole-document choice declaring one, makes that shape vary — and
 * `declarations` the documents of the reading, through which a reference to a
 * shape that does not vary itself is followed.
 */
export function varyingShapeReach(
  holders: Iterable<ChoiceHolder>,
  declarations: readonly ResourceManifest[],
  moduleOf: (m: ResourceManifest) => string | undefined,
  isShapeKind: (kind: string, module: string | undefined) => boolean,
): (module: string, entry: unknown) => VaryingShapeReached | undefined {
  const key = (module: string, name: string) => `${module}\0${name}`;
  const varying = new Set<string>();
  for (const { holder, module } of holders) {
    const name = holder.metadata?.name;
    if (module === undefined || typeof name !== "string") continue;
    if (declaresShape(holder, module, isShapeKind)) varying.add(key(module, name));
  }
  if (varying.size === 0) return () => undefined;
  const shapes = new Map<string, ResourceManifest>();
  for (const m of declarations) {
    const owner = moduleOf(m);
    const name = m.metadata?.name;
    if (typeof m.kind !== "string" || typeof name !== "string" || owner === undefined) continue;
    if (isShapeKind(m.kind, owner)) shapes.set(key(owner, name), m);
  }

  const targetOf = (module: string, value: unknown): { module: string; name: string } | undefined => {
    const target = refSentinelTarget(value);
    if (target) return target.alias === undefined || target.alias === "Self" ? { module, name: target.name } : undefined;
    if (typeof value !== "string") return undefined;
    const id = value.split("#")[0]!;
    const canonical = parseCanonicalTypeSchemaId(id);
    if (canonical) return { module: canonical.moduleName, name: canonical.typeName };
    const written = parseTeloTypeRef(id);
    if (written && (written.authority === "Self" || written.authority === module)) {
      return { module, name: written.typeName };
    }
    return undefined;
  };

  return (module, entry) => {
    const seen = new Set<string>();
    /** `written` is the reference the entry writes on the way here. */
    const reach = (at: string, node: unknown, written: string | undefined): VaryingShapeReached | undefined => {
      if (Array.isArray(node)) {
        for (const item of node) {
          const found = reach(at, item, written);
          if (found) return found;
        }
        return undefined;
      }
      if (!node || typeof node !== "object") return undefined;
      const sentinel = refSentinelTarget(node);
      if (sentinel) {
        const target = targetOf(at, node);
        return target ? shapeReached(target, written ?? `!ref ${sentinel.source}`) : undefined;
      }
      for (const [name, child] of Object.entries(node)) {
        if (DATA_KEYS.has(name) || name.startsWith("x-telo-")) continue;
        const found =
          name === "$ref"
            ? (() => {
                const target = targetOf(at, child);
                return target ? shapeReached(target, written ?? String(child)) : undefined;
              })()
            : reach(at, child, written);
        if (found) return found;
      }
      return undefined;
    };
    const shapeReached = (target: { module: string; name: string }, written: string): VaryingShapeReached | undefined => {
      const id = key(target.module, target.name);
      if (varying.has(id)) return { ref: written, shape: target.name };
      if (seen.has(id)) return undefined;
      seen.add(id);
      const declaration = shapes.get(id) as Record<string, unknown> | undefined;
      if (!declaration) return undefined;
      const parents = Array.isArray(declaration.extends) ? declaration.extends : [declaration.extends];
      for (const parent of parents) {
        if (typeof parent !== "string") continue;
        const dot = parent.indexOf(".");
        const owner = dot === -1 ? target.module : parent.slice(0, dot);
        if (owner !== "Self" && owner !== target.module) continue;
        const found = shapeReached({ module: target.module, name: parent.slice(dot + 1) }, written);
        if (found) return found;
      }
      return reach(target.module, declaration.schema, written);
    };
    return reach(module, entry, undefined);
  };
}

/** A whole-document choice declaring a named shape in some branch, or a named
 *  shape's own document holding a choice. */
function declaresShape(
  holder: ResourceManifest,
  module: string,
  isShapeKind: (kind: string, module: string | undefined) => boolean,
): boolean {
  if (typeof holder.kind === "string") return isShapeKind(holder.kind, module);
  const leaves = (value: unknown): boolean => {
    const tag = expansionTagOf(value);
    if (tag !== "if" && tag !== "switch") {
      const kind = (value as { kind?: unknown } | null)?.kind;
      return typeof kind === "string" && isShapeKind(kind, module);
    }
    const body = value as Record<string, unknown>;
    const branches = tag === "if" ? [body.then, body.else] : [...Object.values((body.cases ?? {}) as object), body.default];
    return branches.some((branch) => branch !== undefined && leaves(branch));
  };
  return leaves(holder);
}
