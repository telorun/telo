import {
  decodePlainLiterals,
  inputValueSchema,
  valueTypeRefusalCode,
  type ExternalSchemaResolver,
} from "@telorun/analyzer";
import { membersEntryOfValue, plainScalar, RuntimeError, VALUE_TYPES } from "@telorun/sdk";
import { buildMembersValues, copyPlainContainers, type SchemaAccepts } from "../../members-values.js";
import { SchemaValidationError } from "../../schema-validator.js";

/** A validator for one schema node, as a controller context compiles one. */
export type CompileSchema = (schema: Record<string, any>) => { validate(value: unknown): void };

/**
 * An import's `variables:` / `secrets:` — the library's own `default:` standing in for an
 * entry the import leaves out — read against the library's declared entries: the one
 * decode site an import is (invocation contract §4.6). Every instance value type is
 * decoded through its plain encoding, every type with members built, and each entry then
 * validated against its declaration.
 *
 * A value of a type with members that does not build is refused under the type's own code
 * (`ERR_URL_INVALID`), a relative host path as `ERR_HOST_PATH_RELATIVE`, anything else as
 * `ERR_RESOURCE_SCHEMA_VALIDATION_FAILED` — each naming the import and the entry, never
 * the value. Returns the settled block, and the texts the importer's and the library's
 * contexts must redact.
 */
export function settleImportInputs(
  supplied: Record<string, unknown>,
  declared: Record<string, unknown>,
  block: "variables" | "secrets",
  alias: string,
  compile: CompileSchema,
  accepts: SchemaAccepts,
  external?: ExternalSchemaResolver,
): { values: Record<string, unknown>; redacted: string[] } {
  const entries: Record<string, Record<string, any>> = {};
  for (const [name, entry] of Object.entries(declared)) {
    if (entry && typeof entry === "object" && !Array.isArray(entry) && supplied[name] !== undefined) {
      entries[name] = inputValueSchema(entry as Record<string, unknown>);
    }
  }
  if (Object.keys(entries).length === 0) return { values: supplied, redacted: [] };

  const schema = { type: "object", properties: entries };
  const values = decodePlainLiterals(copyPlainContainers(supplied), schema, external) as Record<
    string,
    unknown
  >;
  // Every value of a type with members is built here, nested ones included, and
  // reported as the texts both contexts redact.
  const { redacted, refusals } = buildMembersValues(values, schema, accepts, external);
  const [unbuilt] = refusals;
  if (unbuilt) {
    throw new RuntimeError(
      unbuilt.code,
      `Import '${alias}': ${block}${dottedPointer(unbuilt.pointer)} is not a ${unbuilt.type}: ${unbuilt.reason}`,
    );
  }

  for (const [name, entry] of Object.entries(entries)) {
    const value = values[name];
    try {
      // On a copy: a default the schema declares is not filled into what the
      // library receives. Held as a property, so a declaration with no string
      // `type` is never read as a property map.
      compile({ type: "object", properties: { [name]: entry } }).validate({
        [name]: copyPlainContainers(value),
      });
    } catch (error) {
      if (!(error instanceof SchemaValidationError)) throw error;
      throw importInputRefusal(error, alias, block, name);
    }
    // A secret of a type written as its text is secret whole.
    if (block === "secrets" && membersEntryOfValue(value)) {
      const text = plainScalar(value);
      if (typeof text === "string" && text.length > 0) redacted.push(text);
    }
  }
  return { values, redacted };
}

/** A validation failure at one entry, rendered from its issue — never from the
 *  validator's own message, which quotes the value. */
function importInputRefusal(
  error: SchemaValidationError,
  alias: string,
  block: "variables" | "secrets",
  name: string,
): RuntimeError {
  const issue = error.issues[0];
  const within = issue ? withinEntry(issue.path, name) : "";
  const where = `Import '${alias}': ${block}.${name}${within}`;
  if (!issue) return new RuntimeError(error.code, `${where} does not satisfy the library's declaration`);
  const textCode = valueTypeRefusalCode(issue);
  const fromHost = issue.valueType !== undefined && VALUE_TYPES.get(issue.valueType)?.fromHost !== undefined;
  const code = textCode
    ? `ERR_${textCode}`
    : fromHost
      ? "ERR_HOST_PATH_RELATIVE"
      : "ERR_RESOURCE_SCHEMA_VALIDATION_FAILED";
  // A secret's issue is named by its keyword alone: a rendered message may quote what
  // the value holds.
  const reason =
    block === "secrets"
      ? `fails the library's declaration ('${issue.keyword ?? "schema"}')`
      : `fails the library's declaration ('${issue.keyword ?? "schema"}'): ${issue.message.replace(/^\/\S*\s*/, "")}`;
  return new RuntimeError(code, `${where} ${reason}`);
}

/** An issue's dotted path below the entry it was validated as, e.g. `db.url` → `.url`. */
function withinEntry(path: string, name: string): string {
  if (path === name) return "";
  if (path.startsWith(`${name}.`) || path.startsWith(`${name}[`)) return path.slice(name.length);
  return path ? `.${path}` : "";
}

/** `/a/0/b` → `.a[0].b`. */
function dottedPointer(pointer: string): string {
  let out = "";
  for (const raw of pointer.split("/").slice(1)) {
    if (raw === "") continue;
    const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    out += /^\d+$/.test(segment) ? `[${segment}]` : `.${segment}`;
  }
  return out;
}
