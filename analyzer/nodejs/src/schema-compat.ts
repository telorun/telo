import AjvModule from "ajv";
import addFormats from "ajv-formats";
import {
  INCLUDE_BYTES_ENGINE,
  INCLUDE_ENGINE_NAMES,
  isRefSentinel,
  isTaggedSentinel,
  ManifestRootSchema,
  normalizeRefSlots,
} from "@telorun/templating";
import { binaryKeyword, isBinarySlot } from "./binary-slot.js";

const Ajv = (AjvModule as any).default ?? AjvModule;

/** Creates a configured AJV instance (allErrors, strict: false, with formats).
 *  Also registers the kernel manifest root schema under `telo://manifest` so
 *  module YAMLs can `$ref` into the shared `$defs/ResourceRef` (and any future
 *  shared fragments) from this analyzer's AJV without each module having to
 *  bundle its own copy.
 *
 *  Called once for the module-level instance and once per
 *  DefinitionRegistry instance. */
export function createAjv(): InstanceType<typeof Ajv> {
  const instance = new Ajv({ allErrors: true, strict: false });
  (addFormats as any).default
    ? (addFormats as any).default(instance)
    : (addFormats as any)(instance);
  // Bytes have no JSON Schema type, so the annotation carries the check. Registered
  // here and in the kernel's validators from one definition, so a literal at a byte
  // slot is rejected statically and at dispatch by the identical rule.
  instance.addKeyword(binaryKeyword());
  instance.addSchema(ManifestRootSchema);
  return instance;
}

const ajv = createAjv();
const compiledSchemaValidators = new WeakMap<Record<string, any>, ReturnType<typeof ajv.compile>>();

export interface CompatibilityResult {
  compatible: boolean;
  issues: string[];
}

/** Conservative structural JSON Schema compatibility check.
 *  Only flags definite mismatches: missing required fields and primitive type conflicts.
 *  Ambiguous cases (anyOf/oneOf/etc.) are treated as compatible. */
export function checkSchemaCompatibility(
  source: Record<string, any>,
  target: Record<string, any>,
): CompatibilityResult {
  const issues: string[] = [];
  checkObject(source, target, "", issues);
  return { compatible: issues.length === 0, issues };
}

function checkObject(
  source: Record<string, any>,
  target: Record<string, any>,
  path: string,
  issues: string[],
): void {
  const targetRequired: string[] = target.required ?? [];
  const sourceProps: Record<string, any> = source.properties ?? {};
  const targetProps: Record<string, any> = target.properties ?? {};

  for (const field of targetRequired) {
    if (!(field in sourceProps)) {
      issues.push(`${path}/${field}: required by target but missing from source`);
      continue;
    }
    const srcProp = sourceProps[field];
    const tgtProp = targetProps[field];
    if (tgtProp && srcProp) {
      checkProperty(srcProp, tgtProp, `${path}/${field}`, issues);
    }
  }
}

function checkProperty(
  source: Record<string, any>,
  target: Record<string, any>,
  path: string,
  issues: string[],
): void {
  // Only flag definite primitive type clashes; skip anyOf/oneOf/allOf
  if (
    source.type &&
    target.type &&
    typeof source.type === "string" &&
    typeof target.type === "string" &&
    source.type !== target.type
  ) {
    issues.push(
      `${path}: type mismatch — source is '${source.type}', target expects '${target.type}'`,
    );
    return;
  }
  if (target.type === "object" && source.type === "object") {
    checkObject(source, target, path, issues);
  }
}

export function formatSingleError(err: any): string {
  const p = err.instancePath || "/";
  const params = err.params ?? {};
  switch (err.keyword) {
    case "additionalProperties":
      return `${p} must NOT have additional properties ('${params.additionalProperty}' is not allowed)`;
    case "required":
      return `${p} is missing required property '${params.missingProperty}'`;
    case "enum":
      return `${p} ${err.message ?? "is invalid"} (${(params.allowedValues as unknown[])?.join(" | ")})`;
    case "type":
      return `${p} must be ${params.type} (got ${typeof err.data})`;
    default:
      return `${p} ${err.message ?? "is invalid"}`;
  }
}

export function formatAjvErrors(errors: any[] | null | undefined): string {
  if (!errors || errors.length === 0) return "Unknown schema error";
  return errors.map(formatSingleError).join("; ");
}

/** Converts an AJV error object to a dotted path string compatible with PositionIndex keys.
 *  e.g. instancePath "/config/routes/0/handler" → "config.routes[0].handler"
 *  For "required" keyword errors, appends the missing property to the parent path. */
function ajvErrorToPath(err: any): string {
  const instancePath = (err.instancePath ?? "") as string;
  const parts = instancePath.split("/").filter((p) => p !== "");
  let result = "";
  for (const part of parts) {
    if (/^\d+$/.test(part)) {
      result += `[${part}]`;
    } else {
      result += result ? `.${part}` : part;
    }
  }
  if (err.keyword === "required" && err.params?.missingProperty) {
    const missing = err.params.missingProperty as string;
    result += result ? `.${missing}` : missing;
  }
  return result;
}

/** A schema validation issue with a dotted-path pointer to the offending field. */
export interface SchemaIssue {
  message: string;
  /** Dotted path to the field (e.g. "config.handler"). Empty string means root. */
  path: string;
}

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
    // Normalize outside the try: a fault in our own ref-slot normalization must
    // surface, never be mistaken for the module author's schema being malformed.
    // Drop the legacy scalar `type` an older published module may still pin on
    // its `x-telo-ref` slots so a resolved reference object validates.
    const normalized = normalizeRefSlots(schema) as Record<string, any>;
    try {
      validate = ajv.compile(normalized);
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
  return (validate.errors ?? []).map((err: any) => ({
    message: formatSingleError(err),
    path: ajvErrorToPath(err),
  }));
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
 * Recognized `x-telo-type` value brands and the CEL primitive each refines.
 * A brand is a nominal type the analyzer registers (see cel-environment.ts) so
 * structurally-identical values (a `TcpPort` and a `UdpPort` are both integers)
 * stay distinct for static wiring checks. Brands carry no runtime effect — the
 * value flows as its base type. Add new brands here (e.g. `Url: "string"`).
 */
export const VALUE_BRAND_BASE: Record<string, string> = {
  TcpPort: "int",
  UdpPort: "int",
};

/** Read a recognized `x-telo-type` brand off a schema, or undefined. */
export function brandOfSchema(schema: Record<string, any> | undefined): string | undefined {
  const brand = schema?.["x-telo-type"];
  return typeof brand === "string" && brand in VALUE_BRAND_BASE ? brand : undefined;
}

/** Map a JSON Schema type annotation to a CEL type string. */
export function jsonSchemaToCelType(schema: Record<string, any> | undefined): string {
  if (!schema || typeof schema !== "object") return "dyn";
  const brand = brandOfSchema(schema);
  if (brand) return brand;
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
      return "null_type";
  }
  if (schema.properties) return "map";
  if (schema.items) return "list";
  return "dyn";
}

/** Check whether a CEL return type is compatible with a JSON Schema type constraint. */
export function celTypeSatisfiesJsonSchema(celType: string, schema: Record<string, any>): boolean {
  if (celType === "dyn") return true;
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
  }
  if (!schema.type && !schema.anyOf && !schema.oneOf && !schema.allOf) return true;
  if (schema.anyOf || schema.oneOf || schema.allOf) return true;
  const schemaTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
  const accepted: Record<string, string[]> = {
    int: ["integer", "number"],
    uint: ["integer", "number"],
    double: ["number"],
    string: ["string"],
    bool: ["boolean"],
    list: ["array"],
    map: ["object"],
    null_type: ["null"],
    timestamp: ["string"],
    duration: ["string"],
    bytes: ["string"],
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
function foldedConstraints(schema: Record<string, any>): Record<string, any> {
  const branches = Array.isArray(schema.allOf) ? (schema.allOf as Record<string, any>[]) : [];
  if (branches.length === 0) return schema;
  const out: Record<string, any> = { ...schema };
  for (const branch of branches) {
    const folded = foldedConstraints(branch);
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
    if (out.default === undefined && folded.default !== undefined) out.default = folded.default;
    if (folded.required) {
      out.required = [...new Set([...(out.required ?? []), ...folded.required])];
    }
    if (folded.properties) out.properties = { ...folded.properties, ...(out.properties ?? {}) };
  }
  return out;
}

export function celPlaceholderForSchema(rawSchema: Record<string, any>): unknown {
  const schema = foldedConstraints(rawSchema);
  // A byte slot's placeholder must BE bytes: the same keyword validates statically
  // and at dispatch, so a CEL leaf standing in for a runtime buffer has to satisfy
  // it. This is what keeps the rule single — a literal is rejected because no YAML
  // literal is a Uint8Array, while a value arriving by reference passes.
  if (isBinarySlot(schema)) return new Uint8Array();
  if (schema.default !== undefined) return schema.default;
  // An enum-constrained field needs a placeholder drawn from the enum: the
  // type-based fallbacks below ("" for a string, 0 for a number) satisfy `type`
  // but violate `enum`, so a CEL expression feeding any enum field would report
  // a spurious SCHEMA_VIOLATION against a value the author never wrote. The
  // member chosen is irrelevant — only its acceptability to AJV matters, since
  // the real value is checked at runtime once the expression resolves.
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
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
            celPlaceholderForSchema((schema.items ?? {}) as Record<string, any>),
          )
        : [];
    case "object":
      return objectPlaceholder(schema);
    default:
      return null;
  }
}

/** An object satisfying the schema's `required` list. A bare `{}` would report
 *  every required property as missing against a value the author never wrote —
 *  the case where a whole map is produced by one expression (`inputs: !cel
 *  "buildRequest(...)"`), which is exactly when the analyzer knows least and
 *  should say least. Members are filled recursively by the same rule, so a
 *  required nested object is satisfied too. */
function objectPlaceholder(schema: Record<string, any>): Record<string, unknown> {
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  if (required.length === 0) return {};
  const properties = (schema.properties ?? {}) as Record<string, Record<string, any>>;
  const out: Record<string, unknown> = {};
  for (const key of required) {
    out[key] = celPlaceholderForSchema(properties[key] ?? {});
  }
  return out;
}

const CEL_PURE_RE = /^\s*\$\{\{[^}]*\}\}\s*$/;

/** Resolve a `$ref` (only `#/$defs/...` form) against the root schema. */
export function resolveRef(schema: Record<string, any>, root: Record<string, any>): Record<string, any> {
  if (schema.$ref && typeof schema.$ref === "string" && schema.$ref.startsWith("#/$defs/")) {
    const defName = schema.$ref.slice("#/$defs/".length);
    const resolved = root.$defs?.[defName];
    if (resolved) return resolved;
  }
  return schema;
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
 * behalf.
 */
function selectUnionBranch(
  schema: Record<string, any>,
  data: unknown,
  root: Record<string, any>,
): Record<string, any> {
  const branches = (schema.oneOf ?? schema.anyOf) as Record<string, any>[] | undefined;
  if (!Array.isArray(branches) || branches.length === 0) return schema;
  if (schema.type !== undefined || schema.properties !== undefined) return schema;

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
  if (!kind) return schema;

  const fits = branches
    .map((b) => resolveRef(b, root))
    .filter((b) => {
      const types = Array.isArray(b.type) ? b.type : b.type ? [b.type] : [];
      if (types.length > 0 && !types.includes(kind)) return false;
      if (kind === "object" && Array.isArray(b.required)) {
        const keys = Object.keys(data as Record<string, unknown>);
        if (!(b.required as string[]).every((r) => keys.includes(r))) return false;
      }
      return true;
    });
  return fits.length === 1 ? fits[0]! : schema;
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

/** Deep-clone `data`, replacing every pure CEL template string (`${{ expr }}`) with a
 *  schema-appropriate placeholder so AJV can validate non-CEL fields without false positives. */
export function substituteCelFields(
  data: unknown,
  schema: Record<string, any>,
  rootSchema?: Record<string, any>,
  /** Called with the dotted path of every value replaced by a placeholder.
   *
   *  A placeholder is a stand-in for something only known at runtime, so its
   *  VALUE says nothing: a caller that judges constraints at these paths reports
   *  against a value no author wrote. Some constraints cannot be satisfied by
   *  construction at all (`pattern`, `format`, a `oneOf` of unrelated shapes),
   *  so making every placeholder acceptable is not achievable in general —
   *  knowing where not to look is. Structural findings survive because they are
   *  located at the CONTAINER, not at the substituted leaf. */
  onSubstitute?: (path: string) => void,
  path = "",
): unknown {
  const root = rootSchema ?? schema;
  const resolved = selectUnionBranch(resolveRef(schema, root), data, root);
  const mark = () => onSubstitute?.(path);

  if (typeof data === "string" && CEL_PURE_RE.test(data)) {
    mark();
    return celPlaceholderForSchema(resolved);
  }
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
  // A file embed's type is a CONSTANT of the tag, not a function of the slot:
  // `!include-text` always produces a string and `!include-bytes` always
  // produces bytes. Collapsing them to a slot-shaped placeholder like a CEL
  // expression would make every slot accept both, so a byte embed at a
  // `type: string` field passed `telo check` and failed at resource creation —
  // and the reverse (text at an `x-telo-binary` slot) did too. Substituting the
  // real type lets AJV and the `x-telo-binary` keyword reject both directions
  // statically, with no new diagnostic code.
  if (isTaggedSentinel(data) && INCLUDE_ENGINE_NAMES.has(data.engine)) {
    return data.engine === INCLUDE_BYTES_ENGINE ? new Uint8Array() : "";
  }
  if (isTaggedSentinel(data)) {
    mark();
    return celPlaceholderForSchema(resolved);
  }
  if (Array.isArray(data)) {
    const itemSchema = resolveRef((resolved.items ?? {}) as Record<string, any>, root);
    return data.map((item, i) =>
      substituteCelFields(item, itemSchema, root, onSubstitute, `${path}[${i}]`),
    );
  }
  if (data !== null && typeof data === "object") {
    const props = collectProperties(resolved);
    const addlProps =
      resolved.additionalProperties && typeof resolved.additionalProperties === "object"
        ? (resolved.additionalProperties as Record<string, any>)
        : undefined;
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      result[k] = substituteCelFields(
        v,
        (props[k] ?? addlProps ?? {}) as Record<string, any>,
        root,
        onSubstitute,
        path ? `${path}.${k}` : k,
      );
    }
    return result;
  }
  return data;
}
