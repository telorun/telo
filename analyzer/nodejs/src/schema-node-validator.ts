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
 * Browser-safe; the analyzer's registry and the kernel's validator each hold
 * one over an instance of their own.
 */

import type { LocatedFinding, SchemaNodeFindings } from "./stand-in-findings.js";

type NodeValidate = ((data: unknown, context?: any) => unknown) & {
  errors?: LocatedFinding[] | null;
};

/** The part of a validator instance this reads. It must report every error and
 *  the node behind each (`allErrors`, `verbose`). */
export interface NodeValidatingAjv {
  addSchema(schema: any, key?: string, meta?: boolean, validateSchema?: any): unknown;
  getSchema(keyRef: string): unknown;
  readonly schemas: Record<string, unknown>;
  readonly refs: Record<string, unknown>;
}

interface NodePlace {
  /** The key its document is registered under. */
  key: string;
  /** The node's JSON Pointer inside that document, as a URI fragment. */
  pointer: string;
}

export interface SchemaNodeValidatorOptions {
  /** A whole schema as the host compiles it. */
  canonical?: (schema: object) => object;
  /** Runs a compiled validator the way the host runs its own. */
  run?: (validate: (data: unknown, context?: any) => unknown, value: unknown) => unknown;
}

export class SchemaNodeValidator {
  private readonly places = new WeakMap<object, NodePlace>();
  private readonly indexed = new WeakSet<object>();
  private readonly validators = new WeakMap<object, NodeValidate | null>();
  private documents = 0;

  constructor(
    private readonly ajv: NodeValidatingAjv,
    private readonly options: SchemaNodeValidatorOptions = {},
  ) {}

  /**
   * The judge's seam over one validated schema: `schema` itself is a document
   * of its own, and any other node must lie in a document this validator holds.
   */
  findingsFor(schema: object): SchemaNodeFindings {
    return (node, value) => this.validate(node, value, node === schema);
  }

  /**
   * Every finding `node` raises against `value`, or `undefined` when the node
   * cannot be compiled where it stands. Compiled once per node.
   */
  private validate(node: object, value: unknown, whole: boolean): LocatedFinding[] | undefined {
    let validate = this.validators.get(node);
    if (validate === undefined) {
      validate = this.compile(node, whole) ?? null;
      this.validators.set(node, validate);
    }
    if (!validate) return undefined;
    const run = this.options.run;
    const valid = run ? run(validate, value) : validate(value);
    return valid ? [] : [...(validate.errors ?? [])];
  }

  private compile(node: object, whole: boolean): NodeValidate | undefined {
    // A schema the instance refuses, or a node in no held document, yields no
    // validator, and the judge then keeps every finding of the union it asked
    // about.
    try {
      const place = whole ? (this.places.get(node) ?? this.hold(node)) : this.placeOf(node);
      if (!place) return undefined;
      const validate = this.ajv.getSchema(place.pointer ? `${place.key}#${place.pointer}` : place.key);
      return typeof validate === "function" ? (validate as NodeValidate) : undefined;
    } catch {
      return undefined;
    }
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
    const key = `telo://stand-in/${this.documents++}`;
    this.ajv.addSchema(document, key, undefined, false);
    this.index(document, key);
    const place = { key, pointer: "" };
    this.places.set(schema, place);
    return place;
  }

  private index(document: object, key: string): void {
    if (this.indexed.has(document)) return;
    this.indexed.add(document);
    const walk = (node: unknown, pointer: string): void => {
      if (node === null || typeof node !== "object" || this.places.has(node)) return;
      if (!Array.isArray(node)) {
        const proto = Object.getPrototypeOf(node);
        if (proto !== Object.prototype && proto !== null) return;
      }
      this.places.set(node, { key, pointer });
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
