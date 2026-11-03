/**
 * `x-telo-serializable: true` — on a schema-valued slot, the declaration that values
 * of the shape the slot names are stored or serialized, so the shape holds no `live`
 * value type at any depth. The annotation's one reader, for `telo check` and for the
 * kernel's refusal at creation alike (the `ref-slot.ts` precedent).
 *
 * Keyed on the vocabulary's `live` flag, never on a type's name: a live type added
 * later is covered by its entry alone. Browser-safe.
 */
import { readValueTypeSlot } from "@telorun/sdk";
import { READS_WHOLE, type ReadReporter } from "./read-place.js";
import { possibleUses, readRefSlot } from "./ref-slot.js";
import { resolveRefIn, type ExternalSchemaResolver } from "./schema-compat.js";

export const X_TELO_SERIALIZABLE = "x-telo-serializable";

/** What `x-telo-serializable` reads: the shape the slot names, whole, and every
 *  shape it reaches. */
export const serializableReads: ReadReporter = ({ at }) => [{ kind: "reference", keys: at, transitive: true, reads: READS_WHOLE }];

type Node = Record<string, any>;

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Where a shape holds a live value: the data path to it (`/body/*`, `/` for the
 *  value itself) and the type it names. */
export interface LiveValueNode {
  readonly path: string;
  readonly type: string;
}

const UNION_KEYS = ["anyOf", "oneOf", "allOf"] as const;
const CONDITIONAL_KEYS = ["then", "else"] as const;

/**
 * The first live value type a shape holds — through properties, items,
 * `additionalProperties` / `patternProperties`, every union branch, `allOf`, a
 * conditional's branches, a document-local `$ref` (against the document the node
 * sits in) and a named shape (`external`, entered as a document of its own) — or
 * undefined when it holds none. Each node is visited once, so a recursive shape ends.
 */
export function liveValueIn(
  schema: unknown,
  external?: ExternalSchemaResolver,
): LiveValueNode | undefined {
  if (!isNode(schema)) return undefined;
  const visited = new Set<Node>();
  const walk = (node: unknown, root: Node, path: string[]): LiveValueNode | undefined => {
    if (!isNode(node) || visited.has(node)) return undefined;
    visited.add(node);
    const slot = readValueTypeSlot(node);
    if (slot?.entry?.live) return { path: `/${path.join("/")}`, type: slot.entry.name };
    if (typeof node.$ref === "string") {
      const target = resolveRefIn(node, root, external);
      if (target.schema !== node) {
        const found = walk(target.schema, target.root, path);
        if (found) return found;
      }
    }
    for (const [name, child] of Object.entries(isNode(node.properties) ? node.properties : {})) {
      const found = walk(child, root, [...path, name]);
      if (found) return found;
    }
    for (const child of Object.values(isNode(node.patternProperties) ? node.patternProperties : {})) {
      const found = walk(child, root, [...path, "*"]);
      if (found) return found;
    }
    const nested = [
      ...(isNode(node.additionalProperties) ? [node.additionalProperties] : []),
      ...(Array.isArray(node.items) ? node.items : isNode(node.items) ? [node.items] : []),
      ...(isNode(node.additionalItems) ? [node.additionalItems] : []),
    ];
    for (const child of nested) {
      const found = walk(child, root, [...path, "*"]);
      if (found) return found;
    }
    for (const key of [...UNION_KEYS, ...CONDITIONAL_KEYS]) {
      const branches = Array.isArray(node[key]) ? node[key] : isNode(node[key]) ? [node[key]] : [];
      for (const branch of branches) {
        const found = walk(branch, root, path);
        if (found) return found;
      }
    }
    return undefined;
  };
  return walk(schema, schema, []);
}

/** One value written at a slot the kind marks serializable, by its data path. */
export interface SerializableSite {
  /** JSON Pointer from the resource root. */
  readonly pointer: string;
  readonly value: unknown;
}

/**
 * Every value a resource writes at a slot its kind's schema marks
 * `x-telo-serializable: true` — walking the schema and the value together through
 * properties, items, map values, a document-local `$ref` and every union branch.
 */
export function serializableSites(
  kindSchema: Node,
  resource: unknown,
  external?: ExternalSchemaResolver,
): SerializableSite[] {
  const sites: SerializableSite[] = [];
  const recorded = new Set<string>();
  const seen = new Map<Node, Set<unknown>>();
  const walk = (node: unknown, root: Node, value: unknown, path: string[]): void => {
    if (!isNode(node) || value === undefined) return;
    const values = seen.get(node) ?? new Set<unknown>();
    if (values.has(value)) return;
    values.add(value);
    seen.set(node, values);
    if (node[X_TELO_SERIALIZABLE] === true) {
      const pointer = path.map((segment) => `/${segment.replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
      if (!recorded.has(pointer)) {
        recorded.add(pointer);
        sites.push({ pointer, value });
      }
      return;
    }
    if (typeof node.$ref === "string") {
      const target = resolveRefIn(node, root, external);
      if (target.schema !== node) walk(target.schema, target.root, value, path);
    }
    for (const key of UNION_KEYS) {
      if (Array.isArray(node[key])) for (const branch of node[key]) walk(branch, root, value, path);
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        const items = Array.isArray(node.items) ? node.items[i] : node.items;
        walk(items, root, item, [...path, String(i)]);
      });
      return;
    }
    if (!isNode(value)) return;
    const properties = isNode(node.properties) ? node.properties : {};
    for (const [key, child] of Object.entries(value)) {
      if (key in properties) {
        walk(properties[key], root, child, [...path, key]);
        continue;
      }
      const pattern = Object.entries(isNode(node.patternProperties) ? node.patternProperties : {}).find(
        ([source]) => new RegExp(source, "u").test(key),
      );
      if (pattern) walk(pattern[1], root, child, [...path, key]);
      else if (isNode(node.additionalProperties)) walk(node.additionalProperties, root, child, [...path, key]);
    }
  };
  walk(kindSchema, kindSchema, resource, []);
  return sites;
}

/** A serializable slot's value whose shape holds a live value. */
export interface SerializableProblem {
  /** JSON Pointer from the resource root to the slot. */
  readonly pointer: string;
  readonly live: LiveValueNode;
  readonly message: string;
}

/**
 * Every serializable slot of a resource whose shape holds a live value.
 * `shapeOf` is the host's reading of a schema-valued field — a raw schema, an
 * inline type declaration or a reference to a named one — to the schema it names;
 * a value it cannot read is not judged (the field's own checks report it).
 */
export function serializableProblems(
  kindSchema: Node,
  resource: unknown,
  shapeOf: (value: unknown) => Node | undefined,
  external?: ExternalSchemaResolver,
): SerializableProblem[] {
  const problems: SerializableProblem[] = [];
  for (const site of serializableSites(kindSchema, resource, external)) {
    const shape = shapeOf(site.value);
    const live = shape ? liveValueIn(shape, external) : undefined;
    if (!live) continue;
    const field = site.pointer.slice(1).replace(/\//g, ".");
    problems.push({
      pointer: site.pointer,
      live,
      message:
        `'${field}' names a shape whose values are stored or serialized, but it holds a live ` +
        `${live.type} at ${live.path} — a live value exists once, as it is consumed, so it ` +
        `cannot be written down and read back. Declare that member as the data it carries instead.`,
    });
  }
  return problems;
}

/** A misplaced or malformed `x-telo-serializable` in a kind's schema. */
export interface SerializableAnnotationProblem {
  /** JSON Pointer from the kind's schema root to the annotated node. */
  readonly pointer: string;
  readonly message: string;
}

/** True when a node holds a schema as its value: a reference slot whose every use
 *  is `schema`, or a slot typed as plain JSON Schema data. */
function isSchemaValued(node: Node): boolean {
  const slot = readRefSlot(node);
  if (slot) {
    const uses = possibleUses(slot);
    return uses.length > 0 && uses.every((use) => use === "schema");
  }
  return node["x-telo-fragment"] === "JsonSchema7" || node.$ref === "#/$defs/telo:JsonSchema7";
}

/** Every `x-telo-serializable` in a kind's schema that is not `true` on a
 *  schema-valued slot — read by nothing, so it is reported rather than ignored. */
export function serializableAnnotationProblems(kindSchema: unknown): SerializableAnnotationProblem[] {
  const problems: SerializableAnnotationProblem[] = [];
  const visited = new Set<unknown>();
  const walk = (node: unknown, path: string[]): void => {
    if (typeof node !== "object" || node === null || visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, [...path, String(i)]));
      return;
    }
    const record = node as Node;
    if (X_TELO_SERIALIZABLE in record) {
      const pointer = path.map((segment) => `/${segment.replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
      if (record[X_TELO_SERIALIZABLE] !== true) {
        problems.push({
          pointer,
          message: `'${X_TELO_SERIALIZABLE}' takes only 'true', not ${JSON.stringify(record[X_TELO_SERIALIZABLE])}.`,
        });
      } else if (!isSchemaValued(record)) {
        problems.push({
          pointer,
          message:
            `'${X_TELO_SERIALIZABLE}' belongs on a slot holding a shape — a reference slot with ` +
            `'use: schema', or a JSON-Schema-valued field — where it says that shape's values ` +
            `are stored or serialized; here it is read by nothing.`,
        });
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (key === X_TELO_SERIALIZABLE) continue;
      walk(child, [...path, key]);
    }
  };
  walk(kindSchema, []);
  return problems;
}
