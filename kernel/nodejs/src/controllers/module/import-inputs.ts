import {
  assertValueDepth,
  decodePlainLiterals,
  inputValueSchema,
  judgeText,
  liftFragmentDefs,
  renderValuePath,
  slotAtPointer,
  textRecordOf,
  textRecordSchema,
  valueTypeRefusalCode,
  schemaNestingExceededMessage,
  unfinishedValidationOf,
  type ExternalSchemaResolver,
  type LibraryTextParameter,
  type OwnValuePositions,
} from "@telorun/analyzer";
import { isCompiledValue, membersEntryOfValue, plainScalar, RuntimeError, VALUE_TYPES } from "@telorun/sdk";
import { buildMembersValues, copyPlainContainers, type SchemaAccepts } from "../../members-values.js";
import { hostPathMismatchCode, hostPathMismatches, hostPathMismatchText } from "../../host-paths.js";
import { SchemaValidationError } from "../../schema-validator.js";

/** A validator for one schema node, as a controller context compiles one. */
export type CompileSchema = (
  schema: Record<string, any>,
  ownValues?: OwnValuePositions,
) => { validate(value: unknown): void };

/**
 * An import's `variables:` / `secrets:` — the library's own `default:` standing in for an
 * entry the import leaves out — read against the library's declared entries: the one
 * decode site an import is (invocation contract §4.6). Every instance value type is
 * decoded through its plain encoding, every type with members built, and each entry then
 * validated against its declaration.
 *
 * A value of a type with members that does not build is refused under the type's own code
 * (`ERR_URL_INVALID`), a relative host path as `ERR_HOST_PATH_RELATIVE`, an existing host
 * path of another entry or media type than its declaration names as
 * `ERR_HOST_PATH_ENTRY_MISMATCH` / `ERR_HOST_PATH_CONTENT_MISMATCH`, anything else as
 * `ERR_RESOURCE_SCHEMA_VALIDATION_FAILED` — each naming the import and the entry, never
 * a secret's value. Returns the settled block, and the texts the importer's and the library's
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
      // Each entry is its own schema root, so its `#/$defs/…` names the entry.
      entries[name] = slotAtPointer(inputValueSchema(entry as Record<string, unknown>), `#/properties/${pointerSegment(name)}`);
    }
  }
  if (Object.keys(entries).length === 0) return { values: supplied, redacted: [] };

  const schema = liftFragmentDefs({ type: "object", properties: entries });
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
      // The entry is a value of its own, its depth judged from its own root.
      assertValueDepth(value);
      compile(liftFragmentDefs({ type: "object", properties: { [name]: entry } }), [[name]]).validate({
        [name]: copyPlainContainers(value),
      });
    } catch (error) {
      const unfinished = unfinishedValidationOf(error);
      if (unfinished) {
        throw new RuntimeError(
          "ERR_SCHEMA_NESTING_EXCEEDED",
          schemaNestingExceededMessage(`Import '${alias}'`, `'${block}.${name}'`, unfinished),
        );
      }
      if (!(error instanceof SchemaValidationError)) throw error;
      throw importInputRefusal(error, alias, block, name);
    }
    // A secret of a type written as its text is secret whole.
    if (block === "secrets" && membersEntryOfValue(value)) {
      const text = plainScalar(value);
      if (typeof text === "string" && text.length > 0) redacted.push(text);
    }
  }
  refuseMismatchedInputPaths(values, schema, alias, block, external);
  return { values, redacted };
}

const pointerSegment = (key: string): string => key.replace(/~/g, "~0").replace(/\//g, "~1");

/** The first resolved host path whose existing entry or head contradicts the
 *  `entry` / `mediaType` its library input declares, refused naming the import. */
function refuseMismatchedInputPaths(
  values: Record<string, unknown>,
  schema: Record<string, any>,
  alias: string,
  block: "variables" | "secrets",
  external?: ExternalSchemaResolver,
): void {
  const [mismatch] = hostPathMismatches(values, schema, external);
  if (!mismatch) return;
  const code = hostPathMismatchCode(mismatch);
  if (block === "variables") {
    throw new RuntimeError(code, `Import '${alias}': variables: ${hostPathMismatchText(mismatch)}.`);
  }
  // A secret's path is not shown.
  const declared = mismatch.unreadable !== undefined ? "cannot be read" : mismatch.content ? "mediaType" : "entry";
  throw new RuntimeError(
    code,
    declared === "cannot be read"
      ? `Import '${alias}': secrets${dottedPointer(mismatch.pointer)} cannot be read (${mismatch.unreadable})`
      : `Import '${alias}': secrets${dottedPointer(mismatch.pointer)} fails the library's declaration ('${declared}')`,
  );
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

/** How each text parameter of a block arrived: computed by an expression, or
 *  left to the library's `default:`. */
export interface TextParameterOrigins {
  readonly computed: ReadonlySet<string>;
  readonly defaulted: ReadonlySet<string>;
}

/**
 * Which of a block's text parameters an import computes — refusing one holding an
 * expression inside a written value, which can only be a computed text — and which
 * it leaves to the library's `default:`. `written` is the block as the import
 * holds it, `expanded` the same block evaluated.
 */
export function textParameterOrigins(
  params: readonly LibraryTextParameter[],
  written: unknown,
  expanded: Record<string, unknown>,
  alias: string,
): TextParameterOrigins {
  const computed = new Set<string>();
  const defaulted = new Set<string>();
  // A block computed whole computes every text in it.
  if (isCompiledValue(written) && params[0]) throw textArgumentComputed(alias, params[0], [], false);
  for (const param of params) {
    const value = (written as Record<string, unknown> | undefined)?.[param.name];
    if (isCompiledValue(value)) {
      if (expanded[param.name] !== undefined && expanded[param.name] !== null) computed.add(param.name);
      else if (Object.hasOwn(param.entry, "default")) defaulted.add(param.name);
      continue;
    }
    const inner = compiledWithin(value);
    if (inner) throw textArgumentComputed(alias, param, inner);
    if ((value === undefined || value === null) && Object.hasOwn(param.entry, "default")) defaulted.add(param.name);
  }
  return { computed, defaulted };
}

/**
 * A block's text parameters handed over as records: a written text judged in the
 * importer's language and attributed to it, the `default:` standing in judged in
 * the library's, and a computed value — admitted only as the record of a text
 * already shown — passed on unchanged. `values` holds the settled literals,
 * `expanded` every value as evaluated.
 */
export function settleTextParameters(
  values: Record<string, unknown>,
  expanded: Record<string, unknown>,
  params: readonly LibraryTextParameter[],
  origins: TextParameterOrigins,
  langs: { readonly importer: string | null; readonly library: string | null },
  alias: string,
  compile: CompileSchema,
): Record<string, unknown> {
  if (params.length === 0) return values;
  const out = { ...values };
  for (const param of params) {
    if (origins.computed.has(param.name)) {
      const value = expanded[param.name];
      try {
        compile(liftFragmentDefs({ type: "object", properties: { [param.name]: textRecordSchema() } })).validate({
          [param.name]: copyPlainContainers(value),
        });
      } catch (error) {
        if (!(error instanceof SchemaValidationError)) throw error;
        throw textArgumentComputed(alias, param, []);
      }
      out[param.name] = value;
      continue;
    }
    const value = out[param.name];
    if (value === undefined || value === null) continue;
    const lang = origins.defaulted.has(param.name) ? langs.library : langs.importer;
    const [problem] = judgeText(value, lang).problems;
    if (problem) {
      const at = renderValuePath([param.block, param.name, ...(origins.defaulted.has(param.name) ? ["default"] : []), ...problem.path]);
      throw new RuntimeError(
        `ERR_${problem.code}`,
        origins.defaulted.has(param.name)
          ? `Import '${alias}': the library's text at '${at}' is refused: ${problem.message}.`
          : `Import '${alias}': the text at '${at}' is refused: ${problem.message}.`,
      );
    }
    out[param.name] = textRecordOf(value, lang, false);
  }
  return out;
}

function textArgumentComputed(
  alias: string,
  param: LibraryTextParameter,
  within: readonly (string | number)[],
  entry = true,
): RuntimeError {
  const at = entry ? [param.block, param.name, ...within] : [param.block];
  return new RuntimeError(
    "ERR_TEXT_ARGUMENT_COMPUTED",
    `Import '${alias}': the value at '${renderValuePath(at)}' is computed, and the ` +
      `library's input '${param.name}' is a text parameter: it takes a text the importing module writes, or the ` +
      `record of a text already shown — a text parameter forwarded with \`!cel "variables.<name>"\`. A text an ` +
      `expression produces can be neither checked nor translated. Write the text itself.`,
  );
}

/** The path of the first compiled expression inside `value`, plain containers only. */
function compiledWithin(value: unknown, path: (string | number)[] = []): (string | number)[] | undefined {
  if (isCompiledValue(value)) return path;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = compiledWithin(item, [...path, index]);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  for (const [key, child] of Object.entries(value)) {
    const found = compiledWithin(child, [...path, key]);
    if (found) return found;
  }
  return undefined;
}
