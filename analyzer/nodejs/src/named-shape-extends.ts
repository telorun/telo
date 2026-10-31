/**
 * A named shape's schema as the kernel registers it: its `extends` parents
 * folded in, each parent resolved the way the kernel's type controller looks it
 * up — `<Module>.<Name>` names that module's shape, and a bare name the
 * declaring module's own shape, else the one shape of that name any module
 * declares. A nested `$ref` to a shape resolves to this schema at run time, so
 * the analyzer registers the same one.
 *
 * Browser-safe: no Node built-ins.
 */
import { canonicalTypeSchemaId } from "@telorun/sdk";
import { foldTypeExtends } from "./validate-cel-context.js";

/** One named shape: the module that declares it, its name, its own schema and
 *  its `extends` field as written. */
export interface NamedShapeDeclaration {
  readonly module: string;
  readonly name: string;
  readonly schema: Record<string, any>;
  readonly extends?: unknown;
}

/**
 * The folded schema of each shape in `declarations`, by canonical id — the
 * shape's own schema object itself when it extends nothing that resolves. A
 * parent that resolves to nothing, or one already on the resolution path, is
 * left out, as `foldTypeExtends` leaves out any parent it cannot resolve.
 */
export function foldedNamedShapes(
  declarations: Iterable<NamedShapeDeclaration>,
): (module: string, name: string) => Record<string, any> | undefined {
  const { byId, parentId } = shapeIndex(declarations);
  const folded = new Map<string, Record<string, any>>();
  const fold = (id: string, ancestry: ReadonlySet<string>): Record<string, any> | undefined => {
    const known = folded.get(id);
    if (known) return known;
    const declaration = byId.get(id);
    if (!declaration || ancestry.has(id)) return undefined;
    const path = new Set(ancestry).add(id);
    const schema = foldTypeExtends(declaration.schema, declaration.extends, (parent) => {
      const target = parentId(parent, declaration.module);
      return target === undefined ? undefined : fold(target, path);
    });
    folded.set(id, schema);
    return schema;
  };

  return (module, name) => fold(canonicalTypeSchemaId(module, name), new Set());
}

/**
 * The ids of the shapes the fold of each shape in `declarations` reads — its
 * own and every parent it folds, transitively — resolved as
 * {@link foldedNamedShapes} resolves them.
 */
export function foldedNamedShapeReads(
  declarations: Iterable<NamedShapeDeclaration>,
): (module: string, name: string) => ReadonlySet<string> {
  const { byId, parentId } = shapeIndex(declarations);
  return (module, name) => {
    const out = new Set<string>();
    const queue = [canonicalTypeSchemaId(module, name)];
    while (queue.length > 0) {
      const id = queue.pop()!;
      if (out.has(id)) continue;
      out.add(id);
      const declaration = byId.get(id);
      if (!declaration?.extends) continue;
      for (const parent of Array.isArray(declaration.extends) ? declaration.extends : [declaration.extends]) {
        const target = parentId(parent, declaration.module);
        if (target !== undefined) queue.push(target);
      }
    }
    return out;
  };
}

/** Each shape of `declarations` by canonical id, the first of an id winning,
 *  and how a parent written in a module resolves. */
function shapeIndex(declarations: Iterable<NamedShapeDeclaration>): {
  byId: Map<string, NamedShapeDeclaration>;
  parentId: (parent: unknown, ownModule: string) => string | undefined;
} {
  const byId = new Map<string, NamedShapeDeclaration>();
  const modulesByName = new Map<string, Set<string>>();
  for (const declaration of declarations) {
    const id = canonicalTypeSchemaId(declaration.module, declaration.name);
    if (byId.has(id)) continue;
    byId.set(id, declaration);
    let modules = modulesByName.get(declaration.name);
    if (!modules) modulesByName.set(declaration.name, (modules = new Set()));
    modules.add(declaration.module);
  }

  const parentId = (parent: unknown, ownModule: string): string | undefined => {
    if (typeof parent !== "string") return undefined;
    const dot = parent.indexOf(".");
    if (dot !== -1) return canonicalTypeSchemaId(parent.slice(0, dot), parent.slice(dot + 1));
    const own = canonicalTypeSchemaId(ownModule, parent);
    if (byId.has(own)) return own;
    const modules = modulesByName.get(parent);
    return modules?.size === 1 ? canonicalTypeSchemaId([...modules][0]!, parent) : undefined;
  };
  return { byId, parentId };
}
