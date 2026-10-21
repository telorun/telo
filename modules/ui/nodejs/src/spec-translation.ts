import { isTextRecord, type TextRecord } from "@telorun/sdk";
import type { JsonSchema } from "./model-schema.js";

/**
 * Every text a node holds, replaced by what a renderer sends the browser — found
 * by following `Ui.SpecNode`, never by a value's shape alone: a `oneOf` is read
 * through the branch its tag and its members choose, a member a branch does not
 * declare is never entered, and only a node the schema types as a text record
 * is translated. A text with values arrives as the translation with its values
 * beside it. A word reference is left as it is, for the renderer to resolve.
 */

/** The schema documents a walk reads: `Ui.SpecNode` and the shapes it names. */
export interface SpecSchemas {
  /** The registered, expanded `Ui.SpecNode` schema. */
  readonly root: JsonSchema;
  /** Another registered shape by its id (`telo:Ui/OverlaySpec`). */
  readonly resolve: (id: string) => JsonSchema | undefined;
}

type Located = { node: JsonSchema; document: JsonSchema };

const RECORD_FRAGMENT = "TextRecord";

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const isRecordSchema = (node: JsonSchema): boolean => node["x-telo-fragment"] === RECORD_FRAGMENT;

function atPointer(document: JsonSchema, pointer: string): unknown {
  let at: unknown = document;
  for (const token of pointer.split("/").slice(1)) {
    if (!isObject(at)) return undefined;
    at = at[decodeURIComponent(token).replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return at;
}

export class SpecTranslator<T> {
  private readonly reaches = new WeakMap<object, boolean>();
  private readonly bound: unknown;

  constructor(
    private readonly schemas: SpecSchemas,
    private readonly translate: (record: TextRecord) => T,
  ) {
    this.bound = (schemas.root.$defs as JsonSchema | undefined)?.BoundText;
  }

  /** `node`, a `Ui.SpecNode`, with every text it holds translated. */
  node(node: unknown): unknown {
    return this.walk(node, { node: this.schemas.root, document: this.schemas.root });
  }

  private follow(located: Located): Located | undefined {
    const ref = located.node.$ref;
    if (typeof ref !== "string") return located;
    const hash = ref.indexOf("#");
    const id = hash < 0 ? ref : ref.slice(0, hash);
    const document = id === "" ? located.document : this.schemas.resolve(id);
    if (!document) return undefined;
    const target = atPointer(document, hash < 0 ? "" : ref.slice(hash + 1));
    return isObject(target) ? { node: target, document } : undefined;
  }

  /** Whether a text record lies anywhere beneath a schema node. */
  private reachesText(located: Located, open: Set<object> = new Set()): boolean {
    const known = this.reaches.get(located.node);
    if (known !== undefined) return known;
    if (open.has(located.node)) return false;
    open.add(located.node);
    const scan = (child: unknown): boolean => {
      if (!isObject(child)) return false;
      const next = this.follow({ node: child, document: located.document });
      return next !== undefined && (isRecordSchema(next.node) || this.reachesText(next, open));
    };
    const node = located.node;
    let found = isRecordSchema(node);
    if (!found && typeof node.$ref === "string") found = scan(node);
    for (const key of ["properties", "patternProperties", "$defs"] as const) {
      if (!found && isObject(node[key])) found = Object.values(node[key]).some(scan);
    }
    for (const key of ["anyOf", "oneOf", "allOf"] as const) {
      if (!found && Array.isArray(node[key])) found = node[key].some(scan);
    }
    if (!found) found = scan(node.items) || scan(node.additionalProperties);
    open.delete(node);
    this.reaches.set(node, found);
    return found;
  }

  /** Whether `value` is what a branch describes, judged by its type, required
   *  and closed members and every member a `const` or `enum` pins. */
  private matches(value: unknown, located: Located, depth = 0): boolean {
    const resolved = this.follow(located);
    if (!resolved || depth > 16) return false;
    const node = resolved.node;
    if (isRecordSchema(node)) return isTextRecord(value);
    for (const key of ["anyOf", "oneOf"] as const) {
      if (Array.isArray(node[key])) {
        return node[key].some((branch: JsonSchema) => this.matches(value, { node: branch, document: resolved.document }, depth + 1));
      }
    }
    const types = node.type === undefined ? [] : [node.type].flat();
    if (types.length > 0 && !types.some((type: string) => typeMatches(type, value))) return false;
    if ("const" in node && JSON.stringify(node.const) !== JSON.stringify(value)) return false;
    if (Array.isArray(node.enum) && !node.enum.some((allowed: unknown) => JSON.stringify(allowed) === JSON.stringify(value))) return false;
    if (!isObject(value)) return types.length > 0 || "const" in node || Array.isArray(node.enum);
    const properties = isObject(node.properties) ? node.properties : {};
    const required: unknown[] = Array.isArray(node.required) ? node.required : [];
    if (!required.every((name) => typeof name === "string" && name in value)) return false;
    if (node.additionalProperties === false && !Object.keys(value).every((key) => key in properties)) return false;
    for (const [key, member] of Object.entries(properties)) {
      if (!(key in value) || !isObject(member)) continue;
      const pinned = this.follow({ node: member, document: resolved.document });
      if (pinned && ("const" in pinned.node || Array.isArray(pinned.node.enum))) {
        if (!this.matches(value[key], pinned, depth + 1)) return false;
      }
    }
    return true;
  }

  private walk(value: unknown, at: Located): unknown {
    const located = this.follow(at);
    if (!located || value === null || typeof value !== "object") return value;
    const node = located.node;
    if (isRecordSchema(node)) return isTextRecord(value) ? this.translate(value) : value;
    if (!this.reachesText(located)) return value;
    for (const key of ["anyOf", "oneOf"] as const) {
      if (!Array.isArray(node[key])) continue;
      const branch = node[key].find((candidate: JsonSchema) => this.matches(value, { node: candidate, document: located.document }));
      return branch ? this.walk(value, { node: branch, document: located.document }) : value;
    }
    if (Array.isArray(value)) {
      if (!isObject(node.items)) return value;
      const items = node.items;
      return value.map((item) => this.walk(item, { node: items, document: located.document }));
    }
    if (!isObject(value)) return value;
    const properties = isObject(node.properties) ? node.properties : {};
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) {
      const schema = isObject(properties[key])
        ? properties[key]
        : isObject(node.additionalProperties)
          ? node.additionalProperties
          : undefined;
      out[key] = schema ? this.walk(member, { node: schema, document: located.document }) : member;
    }
    if (node === this.bound && isObject(out.text)) {
      const { text, ...rest } = out;
      return { ...text, ...rest };
    }
    return out;
  }
}

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return isObject(value);
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    default:
      return true;
  }
}
