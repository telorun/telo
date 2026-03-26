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
