import AjvModule from "ajv";
import addFormats from "ajv-formats";

const Ajv = (AjvModule as any).default ?? AjvModule;

/** Creates a configured AJV instance (allErrors, strict: false, with formats).
 *  Called once for the module-level instance and once per DefinitionRegistry instance. */
export function createAjv(): InstanceType<typeof Ajv> {
  const instance = new Ajv({ allErrors: true, strict: false });
  (addFormats as any).default
    ? (addFormats as any).default(instance)
    : (addFormats as any)(instance);
  return instance;
}

const ajv = createAjv();

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
  return `${p} ${err.message ?? "is invalid"}`;
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

/** Validate actual data against a JSON Schema. Returns issues with path info, or empty array if valid. */
export function validateAgainstSchema(data: unknown, schema: Record<string, any>): SchemaIssue[] {
  let validate: ReturnType<typeof ajv.compile>;
  try {
    validate = ajv.compile(schema);
  } catch {
    return [];
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

/** Map a JSON Schema type annotation to a CEL type string. */
export function jsonSchemaToCelType(schema: Record<string, any> | undefined): string {
  if (!schema || typeof schema !== "object") return "dyn";
  if (schema.anyOf || schema.oneOf || schema.allOf) return "dyn";
  if (Array.isArray(schema.type)) return "dyn";
  switch (schema.type) {
    case "integer": return "int";
    case "number": return "double";
    case "string": return "string";
    case "boolean": return "bool";
    case "array": return "list";
    case "object": return "map";
    case "null": return "null_type";
  }
  if (schema.properties) return "map";
  if (schema.items) return "list";
  return "dyn";
}

/** Check whether a CEL return type is compatible with a JSON Schema type constraint. */
export function celTypeSatisfiesJsonSchema(
  celType: string,
  schema: Record<string, any>,
): boolean {
  if (celType === "dyn") return true;
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
export function celPlaceholderForSchema(schema: Record<string, any>): unknown {
  if (schema.default !== undefined) return schema.default;
  switch (schema.type) {
    case "integer":
    case "number": return schema.minimum ?? 0;
    case "string": return "";
    case "boolean": return false;
    case "array": return [];
    case "object": return {};
    default: return null;
  }
}

const CEL_PURE_RE = /^\s*\$\{\{[^}]*\}\}\s*$/;

/** Deep-clone `data`, replacing every pure CEL template string (`${{ expr }}`) with a
 *  schema-appropriate placeholder so AJV can validate non-CEL fields without false positives. */
export function substituteCelFields(data: unknown, schema: Record<string, any>): unknown {
  if (typeof data === "string" && CEL_PURE_RE.test(data)) {
    return celPlaceholderForSchema(schema);
  }
  if (Array.isArray(data)) {
    const itemSchema = (schema.items ?? {}) as Record<string, any>;
    return data.map((item) => substituteCelFields(item, itemSchema));
  }
  if (data !== null && typeof data === "object") {
    const props = (schema.properties ?? {}) as Record<string, any>;
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      result[k] = substituteCelFields(v, (props[k] ?? {}) as Record<string, any>);
    }
    return result;
  }
  return data;
}
