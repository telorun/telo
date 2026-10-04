import AjvModule from "ajv";
import addFormats from "ajv-formats";
import { isRefSentinel } from "@telorun/templating";
import {
  celBaseOfValueType,
  celTypeOfValueType,
  hostAnchorOf,
  isCelRecord,
  readValueTypeSlot,
  VALUE_TYPE_BINDINGS,
  valueBrandBases,
  valueTypeOf,
  valueTypePlaceholder,
} from "@telorun/sdk";
import { resolveSchemaPointer } from "./manifest-navigation.js";
import { ManifestRootSchema } from "./manifest-schemas.js";
import { deepEquals } from "./migrations/match.js";
import { schemaIssues, type SchemaIssue } from "./schema-error-report.js";
import { readStandIn, type StandIns } from "./stand-in-findings.js";
import { teloFormatOf } from "./telo-format.js";
import { registerTeloKeywords } from "./value-type-keyword.js";

const Ajv = (AjvModule as any).default ?? AjvModule;

/** Creates a configured AJV instance (allErrors, strict: false, with formats).
 *  Also registers the kernel manifest root schema under `telo://manifest` so
 *  module YAMLs can `$ref` into the shared `$defs/ResourceRef` (and any future
 *  shared fragments) from this analyzer's AJV without each module having to
 *  bundle its own copy.
 *
 *  Called once for the module-level instance and once per
 *  DefinitionRegistry instance. */
export function createAjv(options: { verbose?: boolean } = {}): InstanceType<typeof Ajv> {
  // `verbose` makes each error name the schema node that raised it — what the
  // stand-in judge locates a union by.
  const instance = new Ajv({ allErrors: true, strict: false, verbose: options.verbose === true });
  (addFormats as any).default
    ? (addFormats as any).default(instance)
    : (addFormats as any)(instance);
  // One registration site for every Telo keyword — the annotations as no-ops and
  // `x-telo-type` as the one that checks. Registered here and in the kernel's
  // validators from one definition, so a literal at an instance-typed slot is
  // rejected statically and at dispatch by the identical rule. This instance is
  // static analysis alone, so it also asserts a `live` type: no literal can be one.
  registerTeloKeywords(instance, { assertLive: true });
  // This package's own constant, meta-validated once by its test rather than on
  // every instance.
  instance.addSchema(ManifestRootSchema, undefined, undefined, false);
  return instance;
}

const ajv = createAjv();
const compiledSchemaValidators = new WeakMap<Record<string, any>, ReturnType<typeof ajv.compile>>();

export interface CompatibilityResult {
  compatible: boolean;
  issues: string[];
  /** Each issue with where it lies, in `issues` order. */
  conflicts: CompatibilityConflict[];
}

export interface CompatibilityConflict {
  message: string;
  /** True when the conflict sits beneath a type argument of a value type both
   *  sides name; a union's takes the union's own position. */
  beneathTypeArgument: boolean;
}

/** How an issue names the two sides — the value produced, and the slot it must
 *  fill — so a caller reports a mismatch in its own reader's terms. */
export interface CompatibilityRoles {
  source: string;
  target: string;
}

const DEFAULT_ROLES: CompatibilityRoles = { source: "source", target: "target" };

/** The alternatives a union node declares, or undefined when it is not one.
 *  `anyOf` and `oneOf` are one question here — which branches could accept this
 *  value — and their difference (exactly-one vs at-least-one) is a validation
 *  rule, not a compatibility one. */
export function unionBranches(schema: Record<string, any>): Record<string, any>[] | undefined {
  const branches = schema.anyOf ?? schema.oneOf;
  if (!Array.isArray(branches) || branches.length === 0) return undefined;
  return branches.filter((b) => b && typeof b === "object") as Record<string, any>[];
}

/**
 * Conservative structural JSON Schema compatibility check — is a value shaped
 * like `source` acceptable where `target` is declared?
 *
 * COVARIANT, because the values this compares are consumed by reading: a
 * narrower element satisfies a slot declaring a wider one. Only DEFINITE
 * mismatches are flagged — a missing required field, a primitive type conflict,
 * a disagreeing type argument. Anything ambiguous (`anyOf` / `oneOf` / `allOf`,
 * an absent `type`, an undeclared argument) is treated as compatible, so an
 * unmigrated producer and consumer keep checking exactly as they did.
 *
 * The traversal is written here rather than reused: the function this replaced
 * compared only `type` for the names in `target.required` and descended only
 * into objects, so a stream of arrays of strings and a stream of arrays of
 * integers both read as `array` and passed — leaving argument checking inert on
 * exactly the nested shapes it exists for. What survives from it is its posture.
 *
 * `resolveRef` sees through a named shape. Declaring a shape once and
 * referencing it is the sanctioned way to reuse one, so without it two such
 * arguments present as opaque nodes carrying no information — the same reason
 * {@link withLiveValuesSkipped} takes one.
 */
export function checkSchemaCompatibility(
  source: Record<string, any>,
  target: Record<string, any>,
  resolveRef?: (ref: string) => Record<string, any> | undefined,
  roles: CompatibilityRoles = DEFAULT_ROLES,
): CompatibilityResult {
  const conflicts: CompatibilityConflict[] = [];
  compare(source, target, "", conflicts, resolveRef, new Set(), roles, false);
  return {
    compatible: conflicts.length === 0,
    issues: conflicts.map((conflict) => conflict.message),
    conflicts,
  };
}

type RefResolver = ((ref: string) => Record<string, any> | undefined) | undefined;

/** JSON types compare by containment: every `integer` is a `number`, so one
 *  satisfies a slot declaring the other, and not the reverse. */
function jsonTypeSatisfies(source: string, target: string): boolean {
  return source === target || (source === "integer" && target === "number");
}

function deref(schema: Record<string, any>, resolveRef: RefResolver): Record<string, any> {
  if (!resolveRef || typeof schema.$ref !== "string") return schema;
  return resolveRef(schema.$ref) ?? schema;
}

function compare(
  rawSource: Record<string, any>,
  rawTarget: Record<string, any>,
  path: string,
  conflicts: CompatibilityConflict[],
  resolveRef: RefResolver,
  seen: Set<string>,
  roles: CompatibilityRoles,
  beneathTypeArgument: boolean,
): void {
  const issues = {
    push: (message: string) => conflicts.push({ message, beneathTypeArgument }),
  };
  if (!rawSource || !rawTarget || typeof rawSource !== "object" || typeof rawTarget !== "object") {
    return;
  }
  // A recursive shape reached through the same pair of references twice is the
  // same question again; answering it once terminates and loses nothing.
  //
  // The key is the REFERENCE PAIR and deliberately not the path. A path grows on
  // every descent, so a key containing it is new every time and the guard never
  // fires — which is a stack overflow on the first self-referential shape, taking
  // every other diagnostic in the file with it. It also has to be this way to be
  // correct rather than merely terminating: comparing two schemas gives the same
  // answer wherever they are reached from, so the second visit has nothing to add.
  if (typeof rawSource.$ref === "string" && typeof rawTarget.$ref === "string") {
    const key = `${rawSource.$ref}|${rawTarget.$ref}`;
    if (seen.has(key)) return;
    seen.add(key);
  }
  const source = deref(rawSource, resolveRef);
  const target = deref(rawTarget, resolveRef);

  // A union is ALTERNATIVES, so it is compared by distributing over branches on
  // both sides: a definite conflict is one where no source-branch/target-branch
  // pair agrees. Returning silently the moment either side was a union — which
  // is what this did — switched the whole comparison off for any slot that
  // accepts more than one shape, and those are exactly the slots where a value
  // type carries the only information distinguishing the branches.
  //
  // `allOf` is a conjunction rather than a choice, so it keeps the old posture:
  // it says too little to judge and stays compatible.
  if (source.allOf || target.allOf) return;
  const sourceBranches = unionBranches(source);
  const targetBranches = unionBranches(target);
  if (sourceBranches || targetBranches) {
    const lefts = sourceBranches ?? [source];
    const rights = targetBranches ?? [target];
    const reasons: string[] = [];
    for (const left of lefts) {
      for (const right of rights) {
        const probe: CompatibilityConflict[] = [];
        // A fresh `seen` per probe: a pair rejected on one branch must not mark
        // a reference pair visited for the next, which would silently pass it.
        compare(left, right, path, probe, resolveRef, new Set(seen), roles, beneathTypeArgument);
        if (probe.length === 0) return;
        reasons.push(...probe.map((conflict) => conflict.message));
      }
    }
    issues.push(
      `${path || "/"}: no alternative matches — ${[...new Set(reasons)].join("; ")}`,
    );
    return;
  }

  // Value types first: an `instance` representation has no JSON `type` to
  // compare, so its identity IS the comparison — and its arguments are where the
  // real information lives.
  const sourceType = readValueTypeSlot(source);
  const targetType = readValueTypeSlot(target);
  if (sourceType && targetType) {
    if (sourceType.name !== targetType.name) {
      issues.push(
        `${path || "/"}: value type mismatch — ${roles.source} is '${sourceType.name}', ${roles.target} expects '${targetType.name}'`,
      );
      return;
    }
    for (const [argument, targetArg] of Object.entries(targetType.args)) {
      const sourceArg = sourceType.args[argument];
      // An omitted argument is *any*, in BOTH directions. That is what keeps a
      // bare `Telo.Stream` flowing into a typed slot and vice versa, so nothing
      // that does not declare its element is forced to.
      if (sourceArg === undefined) continue;
      compare(
        sourceArg as Record<string, any>,
        targetArg as Record<string, any>,
        `${path}<${argument}>`,
        conflicts,
        resolveRef,
        seen,
        roles,
        true,
      );
    }
    return;
  }

  // One side declares a value type and the other does not. A `json`
  // representation refines a base type, so it stands as that base on the side
  // declaring it — a `Telo.TcpPort` into a plain `integer` or `number` slot is
  // gradual typing working. An `instance` is not JSON at all, so ANY declared
  // JSON type on the other side is a definite conflict; a side declaring no type
  // at all is still saying nothing and stays compatible.
  if (Boolean(sourceType) !== Boolean(targetType)) {
    const declared = (sourceType ?? targetType)!;
    const other = sourceType ? target : source;
    // A `fromHost` type is made only by anchoring, so its base does not satisfy
    // it: a target declaring one is refused by any source that says what it is.
    if (
      targetType?.entry?.fromHost !== undefined &&
      (source.type !== undefined || source.const !== undefined || source.enum !== undefined)
    ) {
      issues.push(
        `${path || "/"}: value type mismatch — ${roles.target} expects '${targetType.name}', ${roles.source} is a plain value`,
      );
      return;
    }
    if (declared.entry && typeof other.type === "string") {
      const base = celBaseOfValueType(declared.entry);
      const asJson = base === undefined ? undefined : declared.entry.base;
      const fits =
        asJson !== undefined &&
        (sourceType ? jsonTypeSatisfies(asJson, other.type) : jsonTypeSatisfies(other.type, asJson));
      if (!fits) {
        issues.push(
          `${path || "/"}: value type mismatch — ${
            sourceType ? `${roles.source} is` : `${roles.target} expects`
          } '${declared.name}', ${sourceType ? `${roles.target} expects` : `${roles.source} is`} '${other.type}'`,
        );
        return;
      }
    }
  }

  // Only flag definite primitive type clashes; an absent or union `type` says
  // too little to judge.
  if (
    typeof source.type === "string" &&
    typeof target.type === "string" &&
    !jsonTypeSatisfies(source.type, target.type)
  ) {
    issues.push(
      `${path || "/"}: type mismatch — ${roles.source} is '${source.type}', ${roles.target} expects '${target.type}'`,
    );
    return;
  }

  // An array's element, which the old comparison never looked at — so every
  // nested shape passed regardless of what it contained.
  if (target.items && source.items) {
    compare(
      source.items as Record<string, any>,
      target.items as Record<string, any>,
      `${path}[]`,
      conflicts,
      resolveRef,
      seen,
      roles,
      beneathTypeArgument,
    );
  }

  const targetRequired: string[] = Array.isArray(target.required) ? target.required : [];
  const sourceProps: Record<string, any> = source.properties ?? {};
  const targetProps: Record<string, any> = target.properties ?? {};
  for (const field of targetRequired) {
    if (!(field in sourceProps)) {
      // Only when the source describes an object at all: a schema with no
      // `properties` is saying nothing about its shape, not saying it is empty.
      if (source.properties === undefined) continue;
      issues.push(`${path}/${field}: required by ${roles.target} but missing from ${roles.source}`);
      continue;
    }
    const srcProp = sourceProps[field];
    const tgtProp = targetProps[field];
    if (tgtProp && srcProp) {
      compare(
        srcProp,
        tgtProp,
        `${path}/${field}`,
        conflicts,
        resolveRef,
        seen,
        roles,
        beneathTypeArgument,
      );
    }
  }
}

export { formatAjvErrors, formatSingleError } from "./schema-error-report.js";
export type { SchemaIssue } from "./schema-error-report.js";

/** Does `schema` compile as-authored? Used to tell a malformed module schema
 *  (the author's problem) apart from a fault we introduced while normalizing it. */
function schemaCompiles(schema: Record<string, any>): boolean {
  try {
    ajv.compile(schema);
    return true;
  } catch {
    return false;
  }
}

/** Validate actual data against a JSON Schema. Returns issues with path info, or empty array if valid. */
export function validateAgainstSchema(data: unknown, schema: Record<string, any>): SchemaIssue[] {
  let validate = compiledSchemaValidators.get(schema);
  if (!validate) {
    try {
      validate = ajv.compile(schema);
    } catch (err) {
      // The normalized schema didn't compile. If the original schema is itself
      // malformed, that is the module author's error — already surfaced once,
      // anchored on the definition, by the analyzer's `SCHEMA_COMPILE_ERROR`
      // pre-check (`DefinitionRegistry.schemaCompileError`); re-reporting it per
      // resource would be noise, so skip. If the original compiles and only the
      // normalized form fails, the fault is ours — let it throw.
      if (schemaCompiles(schema)) throw err;
      return [];
    }
    compiledSchemaValidators.set(schema, validate);
  }
  if (validate(data)) return [];
  return schemaIssues(validate.errors, data);
}

/** Resolves a JSON Pointer (RFC 6901, must start with "/") into a schema object.
 *  Returns undefined when any segment along the path is missing or not an object. */
export function navigateJsonPointer(schema: unknown, pointer: string): unknown {
  const segments = pointer.split("/").slice(1); // drop leading empty string from "/"
  let current: unknown = schema;
  for (const seg of segments) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

/** Navigate a JSON Schema following a `walkCelExpressions`-style path
 *  (e.g. `port`, `routes[0].handler.when`).
 *  Dot-separated segments navigate `properties`; `[N]` indices navigate `items`.
 *  Stops and returns the current node when a union type (`anyOf`/`oneOf`) is reached.
 *  Returns `undefined` if any segment cannot be resolved. */
export function navigateSchemaToExprPath(
  schema: Record<string, any>,
  path: string,
): Record<string, any> | undefined {
  if (!path) return schema;
  let current: Record<string, any> = schema;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    if (current.anyOf || current.oneOf) return current;
    const m = part.match(/^([a-zA-Z_][a-zA-Z0-9_]*)((?:\[\d+\])*)$/);
    if (!m) return undefined;
    const [, ident, indices] = m as [string, string, string];
    const props = current.properties as Record<string, any> | undefined;
    if (!props || !(ident in props)) return undefined;
    current = props[ident] as Record<string, any>;
    if (!current) return undefined;
    const indexCount = (indices.match(/\[/g) ?? []).length;
    for (let i = 0; i < indexCount; i++) {
      if (!current || typeof current !== "object") return undefined;
      if (current.anyOf || current.oneOf) return current;
      if (!current.items) return undefined;
      current = current.items as Record<string, any>;
    }
  }
  return current;
}

/**
 * Every `json`-represented value type's CEL brand → the primitive it refines.
 *
 * A brand is a nominal type the analyzer registers (see cel-environment.ts) so
 * structurally-identical values (a `Telo.TcpPort` and a `Telo.UdpPort` are both
 * integers) stay distinct for static wiring checks. Brands carry no runtime
 * effect — the value flows as its base type.
 *
 * DERIVED from the value-type vocabulary, never hand-written: a new brand is a
 * new entry file, and a table here would be a second place to edit that could
 * silently disagree with the one the runtime reads.
 */
export const VALUE_BRAND_BASE: Record<string, string> = valueBrandBases();

/** Read a `json`-represented value type's brand off a schema, or undefined.
 *  An `instance` type is not a brand — it replaces the JSON layer rather than
 *  refining it, so it carries its binding's CEL type instead — and neither is a
 *  `json` type declaring its own `celType`. */
export function brandOfSchema(schema: Record<string, any> | undefined): string | undefined {
  const entry = valueTypeOf(schema);
  return entry && entry.representation === "json" && entry.celType === undefined
    ? entry.name
    : undefined;
}

/** Map a JSON Schema type annotation to a CEL type string. */
export function jsonSchemaToCelType(schema: Record<string, any> | undefined): string {
  if (!schema || typeof schema !== "object") return "dyn";
  // A declared value type IS the type — for an `instance` representation it is
  // the only thing that says so, since bytes and streams have no JSON Schema
  // type at all. Before the three annotations were unified, a byte slot's
  // expression typed as `dyn` because nothing here consulted `x-telo-binary`.
  const entry = valueTypeOf(schema);
  if (entry) return celTypeOfValueType(entry);
  if (schema.anyOf || schema.oneOf || schema.allOf) return "dyn";
  if (Array.isArray(schema.type)) return "dyn";
  switch (schema.type) {
    case "integer":
      return "int";
    case "number":
      return "double";
    case "string":
      return "string";
    case "boolean":
      return "bool";
    case "array":
      return "list";
    case "object":
      return "map";
    case "null":
      return "null";
  }
  if (schema.properties) return "map";
  if (schema.items) return "list";
  return "dyn";
}

/** The CEL types an `instance` value carries, one per binding. */
const INSTANCE_CEL_TYPES: ReadonlySet<string> = new Set(
  Object.values(VALUE_TYPE_BINDINGS).map((binding) => binding.celType),
);

/** The JSON types of a node's `const` / `enum` values; empty when it lists none. */
function literalJsonTypes(schema: Record<string, any>): string[] {
  const values: unknown[] =
    "const" in schema ? [schema.const] : Array.isArray(schema.enum) ? schema.enum : [];
  const types = new Set<string>();
  for (const value of values) {
    if (value === null) types.add("null");
    else if (Array.isArray(value)) types.add("array");
    else if (typeof value === "number") types.add(Number.isInteger(value) ? "integer" : "number");
    else types.add(typeof value);
  }
  return [...types];
}

/** Check whether a CEL return type is compatible with a JSON Schema type constraint. */
export function celTypeSatisfiesJsonSchema(celType: string, schema: Record<string, any>): boolean {
  if (celType === "dyn") return true;
  // A union is a CHOICE, satisfied by satisfying any branch — split BEFORE a
  // brand degrades to its base, or a `Telo.HostPath` source would reach the
  // host-path branch as a plain string and be refused by the one branch it fits.
  // Distributed for the same reason `compare` does it: accepting every union
  // outright turns the check off for exactly the slots that admit more than one
  // shape, and those are the ones where the branches carry the information.
  const branches = valueTypeOf(schema) === undefined ? unionBranches(schema) : undefined;
  if (branches) return branches.some((branch) => celTypeSatisfiesJsonSchema(celType, branch));
  // Nominal value brands: when the expression's type is a recognized brand,
  // a branded consuming field must match exactly (a UdpPort wired into a
  // TcpPort-branded field is the error we want). An unbranded field accepts
  // the brand as its base type — gradual typing, so a TcpPort flows freely
  // into a plain integer field. (A plain integer into a branded field is also
  // allowed: only a *conflicting* brand is rejected.)
  const sourceBase = VALUE_BRAND_BASE[celType];
  if (sourceBase) {
    const fieldBrand = brandOfSchema(schema);
    if (fieldBrand) return fieldBrand === celType;
    celType = sourceBase;
  } else if (valueTypeOf(schema)?.fromHost !== undefined) {
    // The one brand that is not gradual: a host path is made by anchoring
    // (a host-path variable, `!module-path`, `.join` on one), so a plain string
    // is not one however it was built.
    return false;
  }
  // An `instance` slot holds exactly its binding's value, so at a non-live one an
  // expression of any other concrete CEL type is a mismatch — the assertion would
  // refuse it at dispatch. A live slot is exempt from validation there, so it
  // keeps the permissive reading, whatever the expression's type.
  const slotEntry = valueTypeOf(schema);
  const liveSlot = slotEntry?.representation === "instance" && slotEntry.live === true;
  if (slotEntry?.representation === "instance") {
    if (celTypeOfValueType(slotEntry) === celType) return true;
    if (!liveSlot) return false;
  }
  // And the reverse: an instance's CEL type is no JSON type, so it satisfies no
  // slot that declares one. Derived from the binding table, so a new instance
  // type needs no row here.
  if (
    INSTANCE_CEL_TYPES.has(celType) &&
    (schema.type !== undefined || (slotEntry !== undefined && !liveSlot))
  ) {
    return false;
  }
  // `allOf` is a conjunction and says too little to judge from a single CEL type.
  if (schema.allOf) return true;
  // A `const` / `enum` with no `type` still says what its values are.
  const schemaTypes: string[] = schema.type
    ? Array.isArray(schema.type)
      ? schema.type
      : [schema.type]
    : literalJsonTypes(schema);
  if (schemaTypes.length === 0) return true;
  const accepted: Record<string, string[]> = {
    int: ["integer", "number"],
    uint: ["integer", "number"],
    double: ["number"],
    string: ["string"],
    bool: ["boolean"],
    list: ["array"],
    map: ["object"],
    null: ["null"],
  };
  const compatibleWith = accepted[celType];
  if (!compatibleWith) return true; // unknown CEL type — don't flag
  return compatibleWith.some((t) => schemaTypes.includes(t));
}

/** Return a literal placeholder value of the correct schema type for AJV. */
/** A number inside the schema's declared bounds. The placeholder stands in for a
 *  value only known at runtime, so its single job is to be ACCEPTABLE — a bare 0
 *  into an `exclusiveMinimum: 0` field (a scale, a positive dimension) would
 *  report a violation against a value the author never wrote. Bounds are read in
 *  the order that pins the value: an inclusive minimum is usable as-is, an
 *  exclusive one needs a step past it, and a wholly-negative range needs the
 *  maximum end instead. */
function numericPlaceholder(schema: Record<string, any>): number {
  const isInteger = schema.type === "integer";
  // One step past an exclusive bound. Integral for both `integer` and `number`:
  // any value inside the band will do, and a whole number is inside it whenever
  // a fractional one is (the narrow-band case below handles when it is not).
  const step = 1;
  if (typeof schema.minimum === "number") return schema.minimum;
  if (typeof schema.exclusiveMinimum === "number") {
    const candidate = schema.exclusiveMinimum + step;
    if (typeof schema.maximum === "number" && candidate > schema.maximum) {
      // A narrow band (0 < x <= 0.5) has no integral step; take the midpoint,
      // which the band's own definition guarantees is inside it.
      return isInteger ? schema.maximum : (schema.exclusiveMinimum + schema.maximum) / 2;
    }
    return candidate;
  }
  if (typeof schema.maximum === "number" && schema.maximum < 0) return schema.maximum;
  if (typeof schema.exclusiveMaximum === "number" && schema.exclusiveMaximum <= 0) {
    return schema.exclusiveMaximum - step;
  }
  return 0;
}

/** The constraints a placeholder must satisfy, folded across `allOf` branches.
 *  Inheritance between types is expressed by intersecting `allOf`, so a bound a
 *  parent declared lives in a branch rather than on the property itself — a
 *  placeholder that reads only the top level would violate it and report against
 *  a value the author never wrote. The tightest bound wins, which is what the
 *  intersection means. */
function foldedConstraints(
  schema: Record<string, any>,
  root: Record<string, any>,
  build: StandInBuild,
  open: ReadonlySet<string>,
): Record<string, any> {
  const branches = Array.isArray(schema.allOf) ? (schema.allOf as Record<string, any>[]) : [];
  if (branches.length === 0) return schema;
  const out: Record<string, any> = { ...schema };
  for (const branch of branches) {
    if (!branch || typeof branch !== "object") continue;
    const entered = enterStandInNode(branch, root, build, open);
    const folded = foldedConstraints(entered.schema, entered.root, build, entered.open);
    for (const key of ["minimum", "exclusiveMinimum", "minLength", "minItems"] as const) {
      if (typeof folded[key] === "number" && (typeof out[key] !== "number" || folded[key] > out[key])) {
        out[key] = folded[key];
      }
    }
    for (const key of ["maximum", "exclusiveMaximum"] as const) {
      if (typeof folded[key] === "number" && (typeof out[key] !== "number" || folded[key] < out[key])) {
        out[key] = folded[key];
      }
    }
    if (out.type === undefined && folded.type !== undefined) out.type = folded.type;
    if (out.enum === undefined && folded.enum !== undefined) out.enum = folded.enum;
    if (out.format === undefined && folded.format !== undefined) out.format = folded.format;
    if (out.default === undefined && folded.default !== undefined) out.default = folded.default;
    if (folded.required) {
      out.required = [...new Set([...(out.required ?? []), ...folded.required])];
    }
    if (folded.properties) {
      // A member folded in keeps the document it was declared in.
      for (const member of Object.values(folded.properties)) {
        if (member && typeof member === "object" && !build.foreign.has(member)) {
          build.foreign.set(member, entered.root);
        }
      }
      out.properties = { ...folded.properties, ...(out.properties ?? {}) };
    }
  }
  return out;
}

/** Where the schema a stand-in is built from resolves its references. */
export interface StandInOptions {
  /** The document the schema's own `#/…` references resolve against. Defaults
   *  to the schema itself. */
  root?: Record<string, any>;
  /** Resolves a named shape (`telo:<module>/<Type>`) to its schema. */
  external?: ExternalSchemaResolver;
}

/** One stand-in build: the resolver, and the document of every member folded in
 *  from another one — an `allOf` branch that names a shape contributes members
 *  whose own `#/…` references are relative to that shape. */
interface StandInBuild {
  external?: ExternalSchemaResolver;
  foreign: WeakMap<object, Record<string, any>>;
  /** Numbers the documents met, so a `#/…` reference is identified with the
   *  document it is relative to. */
  documents: WeakMap<object, number>;
  documentCount: number;
}

const standInBuild = (external?: ExternalSchemaResolver): StandInBuild => ({
  external,
  foreign: new WeakMap(),
  documents: new WeakMap(),
  documentCount: 0,
});

/** What a reference names, as a key: a named shape by its id, a document-local
 *  pointer with its document. Keyed on the reference rather than on the schema
 *  it resolves to, so termination does not rest on a resolver returning the
 *  same object twice. */
function referenceKey(ref: string, root: Record<string, any>, build: StandInBuild): string {
  if (!ref.startsWith("#")) return ref;
  let document = build.documents.get(root);
  if (document === undefined) {
    document = build.documentCount++;
    build.documents.set(root, document);
  }
  return `${document}${ref}`;
}

/**
 * The node a stand-in is built from: `schema` with its reference followed, and
 * the document the result's own `#/…` references resolve against — the base
 * travels with the schema, as it does for the substitution walk.
 *
 * A reference already open on this descent stands in as undescribed, which is
 * what ends a shape that contains itself.
 */
function enterStandInNode(
  schema: Record<string, any>,
  root: Record<string, any>,
  build: StandInBuild,
  open: ReadonlySet<string>,
): { schema: Record<string, any>; root: Record<string, any>; open: ReadonlySet<string> } {
  let node = { schema, root };
  let seen = open;
  while (typeof node.schema.$ref === "string") {
    const target = resolveRefIn(node.schema, node.root, build.external);
    if (target.schema === node.schema) break;
    const key = referenceKey(node.schema.$ref, node.root, build);
    if (seen.has(key)) return { schema: {}, root: node.root, open: seen };
    seen = new Set(seen).add(key);
    node = target;
  }
  return { ...node, open: seen };
}

/** The stand-in for a CEL leaf at a `live` slot. Static analysis asserts a live
 *  type like any instance type (a literal can never be one), so the leaf's
 *  stand-in has to satisfy the binding's own assertion — which the BINDING
 *  builds, being the only place that knows what the value is. */
function liveValuePlaceholder(schema: Record<string, any>): unknown | undefined {
  const entry = readValueTypeSlot(schema)?.entry;
  if (!entry?.live || entry.representation !== "instance") return undefined;
  return VALUE_TYPE_BINDINGS[entry.binding!]?.placeholder?.();
}

/**
 * A value the schema accepts, standing in for one only known at runtime.
 *
 * A node that NAMES its shape — a named shape, a document-local `#/…` pointer —
 * is resolved before anything is built from it, at every descent: the node
 * itself, a list's items, a required member, a union branch, a folded `allOf`
 * branch. Building from the reference as written reads a described value as
 * undescribed and yields `null`, which the shape then rejects.
 */
export function celPlaceholderForSchema(
  rawSchema: Record<string, any>,
  options: StandInOptions = {},
): unknown {
  return standIn(rawSchema, options.root ?? rawSchema, standInBuild(options.external), new Set());
}

function standIn(
  rawSchema: Record<string, any>,
  base: Record<string, any>,
  build: StandInBuild,
  open: ReadonlySet<string>,
): unknown {
  const node = enterStandInNode(rawSchema, build.foreign.get(rawSchema) ?? base, build, open);
  const schema = foldedConstraints(node.schema, node.root, build, node.open);
  const descend = (child: Record<string, any>) => standIn(child, node.root, build, node.open);
  // An instance-typed slot's placeholder must BE an instance: the same keyword
  // validates statically and at dispatch, so a CEL leaf standing in for a runtime
  // value has to satisfy it. This is what keeps the rule single — a literal is
  // rejected because no YAML literal is a byte buffer, while a value arriving by
  // reference passes. The stand-in comes from the binding table, so a new
  // instance type brings its own rather than adding a branch here; a `live` type
  // declares none, because nothing validates it at dispatch.
  const placeholder = valueTypePlaceholder(schema) ?? liveValuePlaceholder(schema);
  if (placeholder !== undefined) return placeholder;
  // A host path must be absolute, so its stand-in is one; whether the expression
  // really yields an absolute path is only known once it is evaluated.
  if (hostAnchorOf(schema) !== undefined) return "/";
  // A Telo format's grammar is checked wherever a value is validated, so the
  // stand-in for an expression must be in it: the typeless `""` is not a CSS
  // selector. Scoped to the Telo vocabulary; JSON Schema's own formats keep the
  // fallbacks below.
  const format = teloFormatOf(schema);
  if (format !== undefined) return format.standIn;
  // A `json` value type written without a `type:` stands in as its base, so the
  // keyword's range check sees a number rather than nothing.
  const jsonEntry = valueTypeOf(schema);
  if (jsonEntry?.base !== undefined && schema.type === undefined) {
    return descend({ ...node.schema, type: jsonEntry.base });
  }
  // A declared default stands in only when it fits what this node resolves to.
  // A node typed from elsewhere may require what its own default lacks
  // (`default: {}` beside a conjoined type requiring a member), and such a
  // default would be reported against an expression that supplies the member.
  if (
    schema.default !== undefined &&
    fitsStandInConstraints(schema.default, schema, (member, child) =>
      defaultFits(member, child, node.root, build, node.open),
    )
  ) {
    return schema.default;
  }
  // An enum-constrained field needs a placeholder drawn from the enum: the
  // type-based fallbacks below ("" for a string, 0 for a number) satisfy `type`
  // but violate `enum`, so a CEL expression feeding any enum field would report
  // a spurious SCHEMA_VIOLATION against a value the author never wrote. The
  // member chosen is irrelevant — only its acceptability to AJV matters, since
  // the real value is checked at runtime once the expression resolves.
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if ("const" in schema) return schema.const;
  // A UNION with no `type` of its own. Without this, a whole-field CEL leaf at
  // such a slot gets `null`, which every branch then rejects — so a field
  // declared `anyOf: [array, boolean]` could not be written as an expression at
  // all, while one whose union happens to contain a `live` branch escaped by
  // accident (nothing validates a live value, so `null` passed). The first
  // branch that yields a placeholder wins: the same conservative posture
  // `selectUnionBranch` takes, and enough for AJV, whose question is only
  // whether SOME branch accepts the stand-in.
  if (schema.type === undefined) {
    const branches = unionBranches(schema);
    if (branches) {
      for (const branch of branches) {
        const candidate = descend(branch);
        if (candidate !== null) return candidate;
      }
    }
  }
  switch (schema.type) {
    case "integer":
    case "number":
      return numericPlaceholder(schema);
    case "string":
      // `minLength` is the string analogue of `minimum`: a bare "" into a
      // `minLength: 1` field would report a violation against a value the author
      // never wrote. Any string of the right length will do.
      return typeof schema.minLength === "number" && schema.minLength > 0
        ? "x".repeat(schema.minLength)
        : "";
    case "boolean":
      return false;
    case "array":
      // `minItems` is the array analogue of `minimum` / `minLength`: an empty
      // array into a `minItems: 1` field would report a violation against a
      // value the author never wrote.
      return typeof schema.minItems === "number" && schema.minItems > 0
        ? Array.from({ length: schema.minItems }, () =>
            descend((schema.items ?? {}) as Record<string, any>),
          )
        : [];
    case "object":
      return objectPlaceholder(schema, descend);
    default:
      return null;
  }
}

/** Whether `value` fits the node `rawSchema` names, entered and folded as a
 *  stand-in is built from it — a reference already open reads as undescribed. */
function defaultFits(
  value: unknown,
  rawSchema: Record<string, any>,
  base: Record<string, any>,
  build: StandInBuild,
  open: ReadonlySet<string>,
): boolean {
  const node = enterStandInNode(rawSchema, build.foreign.get(rawSchema) ?? base, build, open);
  const schema = foldedConstraints(node.schema, node.root, build, node.open);
  return fitsStandInConstraints(value, schema, (member, child) =>
    defaultFits(member, child, node.root, build, node.open),
  );
}

/**
 * Whether `value` satisfies the constraints a stand-in is built for at a folded
 * node: its JSON type, `enum` / `const`, numeric bounds, `minLength`,
 * `minItems` and each item, an object's required members and the members its
 * `properties` describe, and — with no `type` — at least one union branch.
 * Anything a stand-in is not built for (`pattern`, JSON Schema's own formats,
 * `not`, conditionals) is not judged, so it never refuses what a validator
 * accepts.
 */
function fitsStandInConstraints(
  value: unknown,
  schema: Record<string, any>,
  fits: (member: unknown, child: Record<string, any>) => boolean,
): boolean {
  const types: unknown[] =
    schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length > 0 && !types.some((type) => isOfJsonType(value, type))) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((member) => deepEquals(member, value))) {
    return false;
  }
  if ("const" in schema && !deepEquals(schema.const, value)) return false;
  if (types.length === 0) {
    const branches = unionBranches(schema);
    if (branches && !branches.some((branch) => fits(value, branch))) return false;
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return false;
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) return false;
    if (typeof schema.maximum === "number" && value > schema.maximum) return false;
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) return false;
    return true;
  }
  if (typeof value === "string") {
    return typeof schema.minLength !== "number" || [...value].length >= schema.minLength;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return false;
    const items = schema.items;
    if (!items || typeof items !== "object" || Array.isArray(items)) return true;
    return value.every((item) => fits(item, items as Record<string, any>));
  }
  if (value !== null && typeof value === "object") {
    const held = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    if (required.some((key) => held[key] === undefined)) return false;
    const properties = (schema.properties ?? {}) as Record<string, unknown>;
    return Object.entries(held).every(([key, member]) => {
      const child = properties[key];
      return !child || typeof child !== "object" || fits(member, child as Record<string, any>);
    });
  }
  return true;
}

function isOfJsonType(value: unknown, type: unknown): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" || typeof value === "bigint";
    case "integer":
      return typeof value === "bigint" || (typeof value === "number" && Number.isInteger(value));
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    default:
      return true;
  }
}

/**
 * The stand-in for a tag whose produced type is a constant of the tag
 * (`!interpolate`, `!include-text` always yield a string), placed at `slot`.
 *
 * It is that type's placeholder, so a string tag at an integer slot is still
 * refused — except that text at a Telo format slot stands in as the format's
 * own stand-in, because whether the text is in the grammar is known only once
 * it is produced, exactly as for `!cel`.
 */
export function producedPlaceholder(
  produced: Record<string, any>,
  slot: Record<string, any>,
  options: StandInOptions = {},
): unknown {
  const format =
    produced.type === "string"
      ? teloFormatOf(
          foldedConstraints(slot, options.root ?? slot, standInBuild(options.external), new Set()),
        )
      : undefined;
  return format !== undefined ? format.standIn : celPlaceholderForSchema(produced);
}

/** An object satisfying the schema's `required` list. A bare `{}` would report
 *  every required property as missing against a value the author never wrote —
 *  the case where a whole map is produced by one expression (`inputs: !cel
 *  "buildRequest(...)"`), which is exactly when the analyzer knows least and
 *  should say least. Members are filled recursively by the same rule, so a
 *  required nested object is satisfied too. */
function objectPlaceholder(
  schema: Record<string, any>,
  standInFor: (member: Record<string, any>) => unknown,
): Record<string, unknown> {
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  if (required.length === 0) return {};
  const properties = (schema.properties ?? {}) as Record<string, Record<string, any>>;
  const out: Record<string, unknown> = {};
  for (const key of required) {
    out[key] = standInFor(properties[key] ?? {});
  }
  return out;
}

/**
 * Resolve a `$ref` — any document-local `#/...` pointer against `root`, and
 * anything else through `external` when a caller supplies one.
 *
 * A named shape is addressed by a registered id (`telo:<module>/<Type>`), which
 * lives in a schema store rather than in this document, so without the hook a
 * walk stops at the reference and treats a described value as undescribed:
 * every CEL leaf under it is handed the schema-unaware `""` placeholder and
 * then rejected against a branch it was never measured against. The caller
 * supplies the store because only the caller has one.
 */
export function resolveRef(
  schema: Record<string, any>,
  root: Record<string, any>,
  external?: ExternalSchemaResolver,
): Record<string, any> {
  return resolveRefIn(schema, root, external).schema;
}

/**
 * {@link resolveRef}, reporting the ROOT the result's own `#/...` references
 * resolve against.
 *
 * Following an external reference enters another document, and a `$ref` inside
 * it is relative to THAT document — which is the whole of how a shape declares
 * its own vocabulary (`anyOf: [{$ref: "#/$defs/Text"}, …]`). Resolving those
 * against the referring document finds nothing, and a walker that then treats
 * the branches as unconstrained accepts every one of them, resolves the union
 * to nothing, and hands the values underneath an untyped stand-in. So the base
 * travels with the schema.
 */
export function resolveRefIn(
  schema: Record<string, any>,
  root: Record<string, any>,
  external?: ExternalSchemaResolver,
): { schema: Record<string, any>; root: Record<string, any> } {
  if (!schema.$ref || typeof schema.$ref !== "string") return { schema, root };
  if (schema.$ref.startsWith("#")) {
    const resolved = resolveSchemaPointer(root, schema.$ref);
    return resolved && typeof resolved === "object"
      ? { schema: resolved as Record<string, any>, root }
      : { schema, root };
  }
  const target = external?.(schema.$ref);
  return target ? { schema: target, root: target } : { schema, root };
}

/** Looks a registered schema up by its `$id`. */
export type ExternalSchemaResolver = (ref: string) => Record<string, any> | undefined;

/** The keys a reference node is made of — what an expansion replaces. */
export const REFERENCE_KEYS: ReadonlySet<string> = new Set(["$ref", "kind", "name", "alias"]);

/**
 * A copy of `schema` with every named shape it references — at the root and at
 * any depth — replaced by the shape itself.
 *
 * For the walks that only read `properties` / `items` and follow no reference:
 * CEL member-access checking and null-guard analysis see a `$ref` as a node that
 * says nothing, so a typo below `items: !ref Money` went unreported. A reference
 * already being expanded higher up is left as it is, which is what keeps a
 * recursive shape finite; document-local `#/…` references belong to the document
 * they sit in and are left too.
 */
export function inlineNamedShapes(
  schema: Record<string, any>,
  resolve: ExternalSchemaResolver,
): Record<string, any> {
  const expand = (node: unknown, open: ReadonlySet<string>): unknown => {
    if (Array.isArray(node)) return node.map((item) => expand(item, open));
    if (!node || typeof node !== "object") return node;
    const record = node as Record<string, any>;
    const ref = record.$ref;
    if (typeof ref === "string" && !ref.startsWith("#") && !open.has(ref)) {
      const target = resolve(ref);
      if (target) {
        // The reference's own keys go; a `title` or `description` beside it stays.
        const siblings: Record<string, any> = {};
        for (const [key, value] of Object.entries(record)) {
          if (!REFERENCE_KEYS.has(key)) siblings[key] = value;
        }
        return expand({ ...target, ...siblings }, new Set(open).add(ref));
      }
    }
    const out: Record<string, any> = {};
    for (const [key, value] of Object.entries(record)) {
      out[key] = key.startsWith("x-telo-") ? value : expand(value, open);
    }
    return out;
  };
  return expand(schema, new Set()) as Record<string, any>;
}

/** Collect property schemas from top-level `properties` and all `oneOf`/`anyOf` sub-schemas. */
/**
 * The `oneOf` / `anyOf` branch a value is written against, when exactly one fits.
 *
 * A union carries no `type` / `properties` / `items` of its own, so a walker that
 * ignores it descends with an empty schema and hands every CEL leaf underneath a
 * `null` placeholder — which then fails every branch and reports a pile of
 * violations against a value that is perfectly valid. Picking the branch first
 * is what lets the leaves be typed.
 *
 * Selection is structural and conservative: a branch must agree with the data's
 * kind, and for an object every `required` key must be present (which is what
 * separates a `{type, text}` part from a `{type, data, mediaType}` one). If that
 * leaves anything other than exactly one branch, the union is returned unchanged
 * — an ambiguous union is one the analyzer should not resolve on the author's
 * behalf. A union beside a shared base (`type` / `properties` of its own)
 * selects the same way and returns the base with the branch merged over it.
 */
export function selectUnionBranch(
  schema: Record<string, any>,
  data: unknown,
  root: Record<string, any>,
  external?: ExternalSchemaResolver,
): Record<string, any> {
  const fits = fittingUnionBranches(schema, data, root, external);
  return fits?.length === 1 ? fits[0]! : schema;
}

/**
 * Every `oneOf` / `anyOf` branch `data` may be written against — each merged
 * over the union's shared base, as {@link selectUnionBranch} returns the one it
 * selects — or `undefined` when `schema` is not a union. More than one entry is
 * an ambiguous union: a walker that must not guess a branch checks against all
 * of them.
 */
export function fittingUnionBranches(
  schema: Record<string, any>,
  data: unknown,
  root: Record<string, any>,
  external?: ExternalSchemaResolver,
): Record<string, any>[] | undefined {
  const unionKey = schema.oneOf !== undefined ? "oneOf" : "anyOf";
  const branches = schema[unionKey] as Record<string, any>[] | undefined;
  if (!Array.isArray(branches) || branches.length === 0) return undefined;

  const kind = Array.isArray(data)
    ? "array"
    : data === null
      ? "null"
      : typeof data === "object"
        ? "object"
        : typeof data === "string"
          ? "string"
          : typeof data === "number"
            ? "number"
            : typeof data === "boolean"
              ? "boolean"
              : undefined;
  if (!kind) return undefined;

  const fits = branches
    .map((b) => resolveRef(b, root, external))
    .filter((b) => {
      const types = Array.isArray(b.type) ? b.type : b.type ? [b.type] : [];
      if (types.length > 0 && !types.includes(kind)) return false;
      // A constant branch is the reading of exactly one scalar — `":memory:"`
      // beside a path — so any other scalar is the other branch's.
      if ("const" in b && (data === null || typeof data !== "object") && b.const !== data) {
        return false;
      }
      if (kind === "object" && Array.isArray(b.required)) {
        const keys = Object.keys(data as Record<string, unknown>);
        if (!(b.required as string[]).every((r) => keys.includes(r))) return false;
      }
      return true;
    });
  if (schema.type === undefined && schema.properties === undefined) return fits;
  // A discriminated union over a shared base (a step: a `name` beside one of
  // several statement shapes) is the base with the branch's own keys over it.
  const base: Record<string, any> = { ...schema };
  delete base[unionKey];
  return fits.map((branch) => {
    const required = [...(base.required ?? []), ...(branch.required ?? [])];
    return {
      ...base,
      ...branch,
      properties: { ...(base.properties ?? {}), ...(branch.properties ?? {}) },
      ...(required.length > 0 ? { required: [...new Set(required)] } : {}),
    };
  });
}

export function collectProperties(schema: Record<string, any>): Record<string, any> {
  const props: Record<string, any> = { ...(schema.properties ?? {}) };
  // `allOf` INTERSECTS, so a branch constraining a property constrains the
  // property itself — type inheritance expresses an inherited bound exactly this
  // way (`allOf: [{ properties: { score: { minimum: 10 } } }]`). Merging the
  // branch's constraints into the property is what lets a placeholder for that
  // property be built from the bound the value must actually satisfy; reading
  // only the top level would produce one that violates it.
  for (const sub of (schema.allOf ?? []) as Record<string, any>[]) {
    if (!sub || typeof sub !== "object" || !sub.properties) continue;
    for (const [k, v] of Object.entries(sub.properties as Record<string, any>)) {
      props[k] = k in props ? { ...(props[k] as object), ...(v as object) } : v;
    }
  }
  // `oneOf` / `anyOf` are alternatives, not constraints: a property seen in one
  // branch is contributed only when no branch already declared it.
  for (const sub of schema.oneOf ?? schema.anyOf ?? []) {
    if (sub && typeof sub === "object" && sub.properties) {
      for (const [k, v] of Object.entries(sub.properties as Record<string, any>)) {
        if (!(k in props)) props[k] = v;
      }
    }
  }
  return props;
}

/** The schema of a key `properties` does not declare: the first matching
 *  `patternProperties` entry (a TypeBox record compiles to one), else an object
 *  `additionalProperties`. Shared with the kernel's placeholder walk so both
 *  halves describe a map value the same way. */
export function undeclaredKeySchema(
  schema: Record<string, any>,
  key: string,
): Record<string, any> | undefined {
  const patterns = schema.patternProperties;
  if (patterns && typeof patterns === "object") {
    for (const [pattern, sub] of Object.entries(patterns as Record<string, unknown>)) {
      if (sub && typeof sub === "object" && new RegExp(pattern, "u").test(key)) {
        return sub as Record<string, any>;
      }
    }
  }
  const addl = schema.additionalProperties;
  return addl && typeof addl === "object" ? (addl as Record<string, any>) : undefined;
}

/** Everything {@link substituteCelFields} does beyond walking the value.
 *
 *  One object rather than trailing positionals: the resolver is the parameter a
 *  caller most needs and was the LAST of six, so reaching it meant counting
 *  `undefined`s — and a caller that stopped counting one short simply got the
 *  old blind behaviour, silently. Two of them did. */
export interface SubstituteOptions {
  /** Receives every stand-in substituted, by JSON Pointer, with its class and
   *  identity. A stand-in is not what the author wrote, so a caller validating
   *  the result passes this record to the validator, which drops the findings
   *  it excuses (`withoutStandInFindings`). */
  standIns?: StandIns;
  /** JSON Pointer of `data` within the validated root, for `standIns`. */
  pointer?: string;
  /** Resolves a named shape (`telo:<module>/<Type>`) to its schema. Without it
   *  a slot described by one reads as undescribed and every CEL leaf beneath it
   *  is handed the typeless `""` stand-in — which the shape then rejects, so a
   *  perfectly valid expression is reported as a violation. */
  external?: ExternalSchemaResolver;
}

/** Deep-clone `data`, replacing every tagged or compiled value with a stand-in
 *  of the type it will be, so AJV can validate the literal fields. */
export function substituteCelFields(
  data: unknown,
  schema: Record<string, any>,
  rootSchema?: Record<string, any>,
  options: SubstituteOptions = {},
): unknown {
  const { standIns, external } = options;
  const pointer = options.pointer ?? "";
  const base = rootSchema ?? schema;
  const entered = resolveRefIn(schema, base, external);
  const root = entered.root;
  const resolved = selectUnionBranch(entered.schema, data, root, external);

  // `!ref <name>` sentinels are identity markers, not runtime values —
  // schemas that opt into `$ref: "telo://manifest#/$defs/ResourceRef"`
  // (or `anyOf` it alongside other shapes) need the actual sentinel
  // object so AJV validates it against ResourceRefSchema. Collapsing it
  // to a CEL placeholder would either fail the schema (when the slot
  // expects the ResourceRef shape) or mask validation errors (when the
  // slot expects something else entirely).
  if (isRefSentinel(data)) {
    return data;
  }
  // An expression reaches this walk as a tagged sentinel BEFORE `precompileDoc`
  // and as a CompiledValue after — so a caller running under `compile: true`
  // (every `telo run`, unlike `telo check`) must substitute both, or AJV sees a
  // compiled value as a plain object and one manifest means two things
  // depending on which command read it.
  //
  // A tag whose produced type is a CONSTANT of the tag (`!interpolate`,
  // `!include-*`, `!module-path`) stands in as THAT type, so a byte embed at a
  // string slot, or text at an integer slot, is still refused statically; any
  // other expression stands in as the slot asks. The engine is what says which,
  // never a tag name — and a tag its engine resolves now (`!literal`) is no
  // stand-in at all: its value is judged like any literal. The builder is given
  // the resolver and the document this node sits in, so a slot whose items or
  // required members name a shape stands in as that shape.
  const reading = readStandIn(data);
  if (reading?.kind === "value") return reading.value;
  if (reading) {
    standIns?.set(pointer, reading);
    return reading.class === "produced"
      ? producedPlaceholder(reading.produced, resolved, { root, external })
      : celPlaceholderForSchema(resolved, { root, external });
  }
  if (Array.isArray(data)) {
    const item = resolveRefIn((resolved.items ?? {}) as Record<string, any>, root, external);
    return data.map((element, i) =>
      substituteCelFields(element, item.schema, item.root, {
        standIns,
        pointer: `${pointer}/${i}`,
        external,
      }),
    );
  }
  if (data !== null && typeof data === "object") {
    // An instance — a decoded timestamp, a duration, bytes — is a value, not a
    // container. Asked of the value DOMAIN, never of the prototype: a branded CEL
    // value is a PLAIN object, so rebuilding it from its entries drops the symbol
    // its brand lives under and the slot's own assertion then refuses the value
    // this walk produced.
    if (!isCelRecord(data)) return data;
    const props = collectProperties(resolved);
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      result[k] = substituteCelFields(v, (props[k] ?? undeclaredKeySchema(resolved, k) ?? {}) as Record<string, any>, root, {
        standIns,
        pointer: `${pointer}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`,
        external,
      });
    }
    return result;
  }
  return data;
}
