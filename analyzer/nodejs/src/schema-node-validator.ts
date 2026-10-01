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
 * 4. Anything else is thrown: a located node that cannot be registered or
 *    compiled where it stands is a defect, never a "cannot".
 *
 * Whole and node findings come off ONE instance, because the judge matches a
 * branch's finding to the whole schema's by the node that raised it: two
 * instances holding two copies of a document would reproduce nothing.
 *
 * Browser-safe; the analyzer's registry and the kernel's validator each hold
 * one over an instance of their own.
 */

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
  readonly opts: { readonly useDefaults?: unknown };
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
    private readonly options: SchemaNodeValidatorOptions = {},
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
      this.options.fillDefaults?.(schema, value);
      return this.validate(node, value, true);
    };
  }

  /**
   * Every finding `node` raises against `value`, or `undefined` when the node
   * lies in no held document. Compiled once per node.
   */
  private validate(node: object, value: unknown, whole: boolean): LocatedFinding[] | undefined {
    let validate = this.validators.get(node);
    if (!validate) {
      const place = whole ? (this.places.get(node) ?? this.hold(node)) : this.placeOf(node);
      if (!place) return undefined;
      validate = this.compile(place);
      this.validators.set(node, validate);
    }
    const run = this.options.run;
    const valid = run ? run(validate, value) : validate(value);
    return valid ? [] : [...(validate.errors ?? [])];
  }

  private compile(place: NodePlace): NodeValidate {
    let validate: unknown;
    try {
      validate = this.ajv.getSchema(place.pointer ? `${place.key}#${place.pointer}` : place.key);
    } catch (cause) {
      throw new Error(`${describePlace(place)} does not compile where it stands: ${reasonOf(cause)}`, {
        cause,
      });
    }
    if (typeof validate !== "function") {
      throw new Error(`${describePlace(place)} resolves to no schema the validator can compile.`);
    }
    return validate as NodeValidate;
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

function describePlace(place: NodePlace): string {
  return place.pointer
    ? `Schema node '#${place.pointer}' of document '${place.key}', asked about on its own to judge a stand-in,`
    : `The schema held as document '${place.key}', validated to judge a stand-in,`;
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
