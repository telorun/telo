/**
 * Validates a value against ONE NODE of a schema, inside the document that
 * declares the node.
 *
 * The stand-in judge decides a union by asking each branch on its own
 * (`stand-in-findings.ts`), and a branch is not a document: its `#/…`
 * references resolve against the schema it was written in. So the node is
 * found, by identity, in a document this validator holds — a schema it was
 * handed whole, or one registered on its instance — and compiled as a reference
 * into that document. Findings come back LOCATED: the instance is verbose, so
 * each names the schema node that raised it, which is what lets the judge find
 * the next union without reading a path.
 *
 * The contract:
 *
 * 1. Asked about the WHOLE schema: every finding, located, as the host
 *    validates. A host whose validation fills `default:`s runs that validation
 *    to completion first ({@link SchemaNodeValidatorOptions.fillDefaults}), so
 *    the findings describe the value with those defaults in it.
 * 2. Asked about a NODE inside it: every finding the node raises when evaluated
 *    inside its own document, located, with no default applied and nothing
 *    written. A validator ignores a `default:` inside a union when it runs the
 *    whole schema and applies it when a branch is compiled alone, so the
 *    instance must apply none — a branch judged alone would otherwise write its
 *    defaults into the value the next branch is judged against.
 * 3. It answers "cannot" (`undefined`) only for a node that lies in no document
 *    it holds.
 * 4. A reference the instance cannot resolve is asked of the host
 *    ({@link SchemaNodeValidatorOptions.resolveReference}, which every host
 *    must supply) — the document the host's own validation resolves it to — so
 *    a node compiles here exactly where it compiled for the host.
 * 5. Anything else is thrown: a located node that cannot be registered or
 *    compiled where it stands is a defect, never a "cannot".
 *
 * Whole and node findings come off ONE instance, because the judge matches a
 * branch's finding to the whole schema's by the node that raised it: two
 * instances holding two copies of a document would reproduce nothing.
 *
 * Browser-safe; the analyzer's registry and the kernel's validator each hold
 * one over an instance of their own.
 */

import { isValidationOverflow, VALIDATION_UNFINISHED, type ValidationUnfinished } from "./schema-validation.js";
import type { LocatedFinding, SchemaNodeFindings } from "./stand-in-findings.js";

type NodeValidate = ((data: unknown, context?: any) => unknown) & {
  errors?: LocatedFinding[] | null;
};

/** The part of a validator instance this reads. It must report every error and
 *  the node behind each (`allErrors`, `verbose`), and apply no default. */
export interface NodeValidatingAjv {
  addSchema(schema: any, key?: string, meta?: boolean, validateSchema?: any): unknown;
  getSchema(keyRef: string): unknown;
  readonly schemas: Record<string, unknown>;
  readonly refs: Record<string, unknown>;
  readonly opts: {
    readonly useDefaults?: unknown;
    readonly uriResolver?: { resolve(base: string, path: string): string };
  };
  /** Every keyword the instance compiles. */
  readonly RULES?: { readonly all: Record<string, unknown> };
}

interface NodePlace {
  /** The key its document is registered under. */
  key: string;
  /** The node's JSON Pointer inside that document, as a URI fragment. */
  pointer: string;
}

export interface SchemaNodeValidatorOptions {
  /** The document the host's own validator resolves a schema id to, for a
   *  reference this instance does not hold; undefined when it resolves none. */
  resolveReference: (id: string) => object | undefined;
  /** A whole schema as the host compiles it. */
  canonical?: (schema: object) => object;
  /** Runs a compiled validator the way the host runs its own. */
  run?: (validate: (data: unknown, context?: any) => unknown, value: unknown) => unknown;
  /** The host's own whole-schema validation where that fills `default:`s: run
   *  to completion over `value`, writing them into it, before the whole
   *  schema's findings are raised. Absent on a host that fills none. */
  fillDefaults?: (schema: object, value: unknown) => void;
}

export class SchemaNodeValidator {
  private readonly places = new WeakMap<object, NodePlace>();
  private readonly indexed = new WeakSet<object>();
  private readonly validators = new WeakMap<object, NodeValidate>();
  private documents = 0;

  constructor(
    private readonly ajv: NodeValidatingAjv,
    private readonly options: SchemaNodeValidatorOptions,
  ) {
    if (ajv.opts.useDefaults) {
      throw new Error(
        "A schema node validator needs an instance that applies no default: a union branch " +
          "validated alone would write its defaults into the value it is asked about.",
      );
    }
  }

  /**
   * The judge's seam over one validated schema: `schema` itself is a document
   * of its own, and any other node must lie in a document this validator holds.
   */
  findingsFor(schema: object): SchemaNodeFindings {
    return (node, value) => {
      if (node !== schema) return this.validate(node, value, false);
      try {
        this.options.fillDefaults?.(schema, value);
      } catch (error) {
        if (isValidationOverflow(error)) return VALIDATION_UNFINISHED;
        throw error;
      }
      return this.validate(node, value, true);
    };
  }

  /**
   * What a `$ref` written in `node` names, read as this validator compiles it:
   * against the document `node` lies in, a document it does not hold adopted
   * from the host. `undefined` when `node` lies in no held document or the
   * reference names nothing.
   */
  reference(node: object, ref: string): object | undefined {
    const place = this.placeOf(node);
    return place ? this.referenceTarget(ref, place.key)?.node : undefined;
  }

  /**
   * A failed-union finding for every `anyOf` / `oneOf` node in force at
   * `pointer` of `value` judged against `schema` — reached through properties,
   * pattern and additional properties, items, `allOf`, every union branch,
   * `then` / `else` and references — located as {@link findingsFor}'s findings
   * are: what a union the validator passed is decided from.
   */
  unionsAt(schema: object, value: unknown, pointer: string): LocatedFinding[] {
    const place = this.places.get(schema) ?? this.hold(schema);
    const root = registeredDocument(this.ajv, place.key);
    if (!root) return [];
    type At = { node: object; key: string };
    const closure = (start: At[]): At[] => {
      const out: At[] = [];
      const seen = new Set<object>();
      const visit = (at: At): void => {
        if (seen.has(at.node)) return;
        seen.add(at.node);
        out.push(at);
        const node = at.node as Record<string, unknown>;
        if (typeof node.$ref === "string") {
          const target = this.referenceTarget(node.$ref, at.key);
          if (target) visit(target);
        }
        for (const keyword of ["allOf", "anyOf", "oneOf"]) {
          const list = node[keyword];
          if (Array.isArray(list)) for (const member of list) if (isSchemaObject(member)) visit({ node: member, key: at.key });
        }
        for (const keyword of ["then", "else"]) if (isSchemaObject(node[keyword])) visit({ node: node[keyword] as object, key: at.key });
      };
      for (const at of start) visit(at);
      return out;
    };
    let current = closure([{ node: root, key: place.key }]);
    let data = value;
    for (const raw of pointer === "" ? [] : pointer.slice(1).split("/")) {
      const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
      const next: At[] = [];
      for (const { node, key } of current) {
        const schemaNode = node as Record<string, any>;
        if (Array.isArray(data)) {
          const index = Number(segment);
          if (isSchemaObject(schemaNode.items)) next.push({ node: schemaNode.items, key });
          if (Array.isArray(schemaNode.items) && isSchemaObject(schemaNode.items[index])) next.push({ node: schemaNode.items[index], key });
          if (Array.isArray(schemaNode.prefixItems) && isSchemaObject(schemaNode.prefixItems[index])) next.push({ node: schemaNode.prefixItems[index], key });
          continue;
        }
        let matched = false;
        const properties = schemaNode.properties as Record<string, unknown> | undefined;
        if (properties && Object.hasOwn(properties, segment) && isSchemaObject(properties[segment])) {
          matched = true;
          next.push({ node: properties[segment] as object, key });
        }
        for (const [pattern, child] of Object.entries((schemaNode.patternProperties ?? {}) as Record<string, unknown>)) {
          let test = false;
          try {
            test = new RegExp(pattern, "u").test(segment);
          } catch {
            // A pattern JS cannot read is the validator's to report.
          }
          if (!test) continue;
          matched = true;
          if (isSchemaObject(child)) next.push({ node: child, key });
        }
        if (!matched && isSchemaObject(schemaNode.additionalProperties)) next.push({ node: schemaNode.additionalProperties, key });
      }
      current = closure(next);
      data = data !== null && typeof data === "object" ? (data as Record<string, unknown>)[segment] : undefined;
    }
    const out: LocatedFinding[] = [];
    for (const { node } of current) {
      for (const keyword of ["anyOf", "oneOf"] as const) {
        const branches = (node as Record<string, unknown>)[keyword];
        if (!Array.isArray(branches)) continue;
        out.push({
          keyword,
          instancePath: pointer,
          schemaPath: `#/${keyword}`,
          params: keyword === "oneOf" ? { passingSchemas: null } : {},
          message: keyword === "oneOf" ? "must match exactly one schema in oneOf" : "must match a schema in anyOf",
          schema: branches,
          parentSchema: node,
          data,
        } as LocatedFinding);
      }
    }
    return out;
  }

  /** What a `$ref` written in the document held under `key` names. */
  private referenceTarget(ref: string, key: string): { node: object; key: string } | undefined {
    const resolver = this.ajv.opts.uriResolver;
    const entry = (this.ajv.schemas[key] ?? this.ajv.refs[key]) as { baseId?: unknown } | undefined;
    const base = typeof entry?.baseId === "string" ? entry.baseId : key;
    const absolute = ref.startsWith("#") ? `${key}${ref}` : resolver ? resolver.resolve(base, ref) : ref;
    const hash = absolute.indexOf("#");
    const target = hash < 0 ? absolute : absolute.slice(0, hash);
    const pointer = hash < 0 ? "" : absolute.slice(hash + 1);
    const document = target === key ? registeredDocument(this.ajv, key) : this.heldDocument(target);
    if (!document) return undefined;
    const node = nodeAt(document, pointer);
    return isSchemaObject(node) ? { node, key: target } : undefined;
  }

  /**
   * Every finding `node` raises against `value`, `undefined` when the node
   * lies in no held document, or that the validation could not finish.
   * Compiled once per node.
   */
  private validate(node: object, value: unknown, whole: boolean): LocatedFinding[] | undefined | ValidationUnfinished {
    let validate = this.validators.get(node);
    if (!validate) {
      const place = whole ? (this.places.get(node) ?? this.hold(node)) : this.placeOf(node);
      if (!place) return undefined;
      validate = this.compile(whole ? place : this.throughBareReferences(node, place));
      this.validators.set(node, validate);
    }
    const run = this.options.run;
    const compiled = validate;
    let valid: unknown;
    try {
      valid = run ? run(compiled, value) : compiled(value);
    } catch (error) {
      if (isValidationOverflow(error)) return VALIDATION_UNFINISHED;
      throw error;
    }
    return valid ? [] : [...(compiled.errors ?? [])];
  }

  private compile(place: NodePlace): NodeValidate {
    let validate: unknown;
    const adopted = new Set<string>();
    for (;;) {
      try {
        validate = this.ajv.getSchema(place.pointer ? `${place.key}#${place.pointer}` : place.key);
        break;
      } catch (cause) {
        const missing = missingSchemaOf(cause);
        const document =
          missing !== undefined && !adopted.has(missing) ? this.options.resolveReference(missing) : undefined;
        if (!document) {
          throw new Error(`${describePlace(place)} does not compile where it stands: ${reasonOf(cause)}`, {
            cause,
          });
        }
        adopted.add(missing!);
        try {
          this.ajv.addSchema(document, missing, undefined, false);
        } catch (addCause) {
          throw new Error(
            `${describePlace(place)} references '${missing}', which cannot be registered: ${reasonOf(addCause)}`,
            { cause: addCause },
          );
        }
      }
    }
    if (typeof validate !== "function") {
      throw new Error(`${describePlace(place)} resolves to no schema the validator can compile.`);
    }
    return validate as NodeValidate;
  }

  /**
   * Where a node that is nothing but a `$ref` is compiled: at what it names,
   * followed until a node that is more. AJV resolves such a fragment's
   * reference in the fragment's own scope, where a document registered by key
   * — its own `#/…` references included — is read against the fragment's base
   * and does not compile. What the reference names raises exactly what the
   * node does.
   */
  private throughBareReferences(node: object, place: NodePlace): NodePlace {
    const seen = new Set<object>();
    let current: object = node;
    let at = place;
    while (at.pointer !== "" && this.isBareReference(current) && !seen.has(current)) {
      seen.add(current);
      const resolver = this.ajv.opts.uriResolver;
      const ref = (current as { $ref: string }).$ref;
      const entry = (this.ajv.schemas[at.key] ?? this.ajv.refs[at.key]) as { baseId?: unknown } | undefined;
      const base = typeof entry?.baseId === "string" ? entry.baseId : at.key;
      const absolute = resolver ? resolver.resolve(base, ref) : ref;
      const hash = absolute.indexOf("#");
      const key = hash < 0 ? absolute : absolute.slice(0, hash);
      const pointer = hash < 0 ? "" : absolute.slice(hash + 1);
      const document = this.heldDocument(key);
      if (!document) break;
      const target = nodeAt(document, pointer);
      if (target === undefined || target === null || typeof target !== "object") break;
      current = target;
      at = { key, pointer };
    }
    return at;
  }

  /** Whether AJV compiles `node` as its `$ref` alone: no other keyword it knows. */
  private isBareReference(node: object): boolean {
    if (typeof (node as { $ref?: unknown }).$ref !== "string") return false;
    const rules = this.ajv.RULES?.all;
    return Object.keys(node).every((key) => key === "$ref" || (rules ? !rules[key] : false));
  }

  /** The document held under `key`, adopted from the host when this instance
   *  holds none. */
  private heldDocument(key: string): object | undefined {
    const held = registeredDocument(this.ajv, key);
    if (held) return held;
    const adopted = this.options.resolveReference(key);
    if (!adopted) return undefined;
    try {
      this.ajv.addSchema(adopted, key, undefined, false);
    } catch (cause) {
      throw new Error(`The schema '${key}', referenced by a node asked about on its own, cannot be registered: ${reasonOf(cause)}`, {
        cause,
      });
    }
    return registeredDocument(this.ajv, key);
  }

  private placeOf(node: object): NodePlace | undefined {
    const known = this.places.get(node);
    if (known) return known;
    for (const table of [this.ajv.schemas, this.ajv.refs]) {
      for (const [key, entry] of Object.entries(table)) {
        const document = (entry as { schema?: unknown } | undefined)?.schema;
        if (document && typeof document === "object") this.index(document, key);
      }
    }
    return this.places.get(node);
  }

  /** Registers a whole schema as a document of its own. */
  private hold(schema: object): NodePlace {
    const document = this.options.canonical ? this.options.canonical(schema) : schema;
    const place = { key: `telo://stand-in/${this.documents++}`, pointer: "" };
    try {
      this.ajv.addSchema(document, place.key, undefined, false);
    } catch (cause) {
      throw new Error(`${describePlace(place)} cannot be registered: ${reasonOf(cause)}`, { cause });
    }
    this.index(document, place.key);
    this.places.set(schema, place);
    return place;
  }

  private index(document: object, key: string): void {
    if (this.indexed.has(document)) return;
    this.indexed.add(document);
    const walk = (node: unknown, pointer: string): void => {
      if (node === null || typeof node !== "object") return;
      // A document's root may be placed already — a schema asked about as a whole
      // is held under a key of its own — and its members are still this
      // document's to place.
      const root = pointer === "";
      if (this.places.has(node) && !root) return;
      if (!Array.isArray(node)) {
        const proto = Object.getPrototypeOf(node);
        if (proto !== Object.prototype && proto !== null) return;
      }
      if (!this.places.has(node)) this.places.set(node, { key, pointer });
      for (const [segment, child] of Object.entries(node)) {
        walk(
          child,
          `${pointer}/${encodeURIComponent(segment.replace(/~/g, "~0").replace(/\//g, "~1"))}`,
        );
      }
    };
    walk(document, "");
  }
}

/** The node a URI-fragment JSON Pointer names inside `document`. */
function nodeAt(document: object, pointer: string): unknown {
  let current: unknown = document;
  if (pointer === "") return current;
  if (!pointer.startsWith("/")) return undefined;
  for (const segment of pointer.slice(1).split("/")) {
    if (current === null || typeof current !== "object") return undefined;
    const key = decodeURIComponent(segment).replace(/~1/g, "/").replace(/~0/g, "~");
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function describePlace(place: NodePlace): string {
  return place.pointer
    ? `Schema node '#${place.pointer}' of document '${place.key}', asked about on its own to judge a stand-in,`
    : `The schema held as document '${place.key}', validated to judge a stand-in,`;
}

/** The schema id a validator could not resolve, as its missing-reference
 *  error names it. */
function missingSchemaOf(cause: unknown): string | undefined {
  const missing = (cause as { missingSchema?: unknown } | null)?.missingSchema;
  return typeof missing === "string" && missing.length > 0 ? missing : undefined;
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The document a validator instance resolves `id` to, read and never
 *  compiled — what a {@link SchemaNodeValidatorOptions.resolveReference} over a
 *  host instance answers. */
export function registeredDocument(
  ajv: { readonly schemas: Record<string, unknown>; readonly refs: Record<string, unknown> },
  id: string,
): object | undefined {
  let entry = ajv.schemas[id] ?? ajv.refs[id];
  while (typeof entry === "string") entry = ajv.schemas[entry] ?? ajv.refs[entry];
  const schema = (entry as { schema?: unknown } | undefined)?.schema;
  return schema && typeof schema === "object" ? schema : undefined;
}

function isSchemaObject(value: unknown): value is object {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
