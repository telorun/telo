import AjvModule from "ajv";
import addFormats from "ajv-formats";

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true, strict: false });
(addFormats as any).default ? (addFormats as any).default(ajv) : (addFormats as any)(ajv);

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

function formatSingleError(err: any): string {
  const p = err.instancePath || "/";
  return `${p} ${err.message ?? "is invalid"}`;
}

export function formatAjvErrors(errors: any[] | null | undefined): string {
  if (!errors || errors.length === 0) return "Unknown schema error";
  return errors.map(formatSingleError).join("; ");
}

/** Validate actual data against a JSON Schema. Returns issues or empty array if valid. */
export function validateAgainstSchema(data: unknown, schema: Record<string, any>): string[] {
  let validate: ReturnType<typeof ajv.compile>;
  try {
    validate = ajv.compile(schema);
  } catch {
    return [];
  }
  if (validate(data)) return [];
  return (validate.errors ?? []).map(formatSingleError);
}
