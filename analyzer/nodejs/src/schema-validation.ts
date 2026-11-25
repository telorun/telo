/**
 * JSON Schema validation, as Telo configures it: one options factory and the
 * analyzer's own validation of a value against a schema.
 *
 * Moved out of `schema-compat.ts`, which keeps the schema-compatibility half; this
 * file is what a validator twin in another language reads as its counterpart.
 *
 * EVERY AJV INSTANCE IS ONE OF SEVEN NAMED CONFIGURATIONS, built here and nowhere
 * else, so a schema means the same thing wherever it is validated. Each is
 * `strict: false` with JSON Schema's formats and Telo's, every Telo keyword, and the
 * schema pattern seam (`schemaPattern`, `@telorun/sdk`) as its pattern language. They
 * differ only in what a validation reports and writes:
 *
 *  - `analysis` — every error, no default filled: static analysis, which also
 *    asserts a `live` value type (no literal can be one);
 *  - `analysis-verbose` — `analysis`, each error naming the schema node that raised
 *    it: the twin a union is judged on;
 *  - `analysis-defaults` — `analysis` filling defaults: a contract read the way the
 *    kernel binds one;
 *  - `primary` — the kernel's: the first error, defaults filled, source kept for the
 *    on-disk cache;
 *  - `filling` — `primary` run to completion, so every default the first error
 *    stopped short of is filled;
 *  - `locating` — every error, each naming its schema node, no default filled;
 *  - `schema-validate` — `ctx.validateSchema`: the first error, undeclared members
 *    removed, no default filled.
 *
 * A schema is compiled only after every pattern it holds has been read: at every
 * place the draft-07 meta-schema declares `format: regex` — whether or not the
 * validator would compile that place — a pattern RE2 refuses fails the compile
 * with the seam's sentence and where it sits (`SchemaPatternError.pointer`).
 *
 * Browser-safe.
 */

import AjvModule from "ajv";
import addFormats from "ajv-formats";
import { opaqueSchemaView, SCHEMA_REGEX_FORMAT, schemaPattern, SchemaPatternError, schemaPatternRefusal } from "@telorun/sdk";
import { ManifestRootSchema } from "./manifest-schemas.js";
import { schemaIssues, type AjvErrorLike, type SchemaIssue } from "./schema-error-report.js";
import { judgeSchemaFindings } from "./schema-findings-judge.js";
import { registeredDocument, SchemaNodeValidator } from "./schema-node-validator.js";
import type { StandIns } from "./stand-in-findings.js";
import { registerTeloKeywords } from "./value-type-keyword.js";
import { valueTypeDefaultFiller } from "./value-type-defaults.js";

const Ajv = (AjvModule as any).default ?? AjvModule;

export type SchemaAjv = InstanceType<typeof Ajv>;

/** The named configurations, in the order the factory documents them. */
export const SCHEMA_VALIDATION_CONFIGURATIONS = [
  "analysis",
  "analysis-verbose",
  "analysis-defaults",
  "primary",
  "filling",
  "locating",
  "schema-validate",
] as const;

export type SchemaValidationConfiguration = (typeof SCHEMA_VALIDATION_CONFIGURATIONS)[number];

interface ConfigurationOptions {
  readonly allErrors: boolean;
  readonly verbose: boolean;
  readonly useDefaults: boolean;
  readonly removeAdditional: boolean;
  /** Static analysis asserts a `live` value type as an instance. */
  readonly assertLive: boolean;
  /** Keep the generated source, which a standalone validator is written from. */
  readonly source: boolean;
}

const CONFIGURATIONS: Readonly<Record<SchemaValidationConfiguration, ConfigurationOptions>> = {
  analysis: { allErrors: true, verbose: false, useDefaults: false, removeAdditional: false, assertLive: true, source: false },
  "analysis-verbose": { allErrors: true, verbose: true, useDefaults: false, removeAdditional: false, assertLive: true, source: false },
  "analysis-defaults": { allErrors: true, verbose: false, useDefaults: true, removeAdditional: false, assertLive: true, source: false },
  primary: { allErrors: false, verbose: false, useDefaults: true, removeAdditional: false, assertLive: false, source: true },
  filling: { allErrors: true, verbose: false, useDefaults: true, removeAdditional: false, assertLive: false, source: true },
  locating: { allErrors: true, verbose: true, useDefaults: false, removeAdditional: false, assertLive: false, source: true },
  "schema-validate": { allErrors: false, verbose: false, useDefaults: false, removeAdditional: true, assertLive: false, source: false },
};

export interface CreateAjvOptions {
  /** Register the manifest root under `telo://manifest` (default), so a schema can
   *  `$ref` its shared fragments. A caller judging another copy of them leaves it out. */
  readonly manifestRoot?: boolean;
}

/** The draft-07 meta-schema with `format: regex` alone asserted, through the
 *  pattern seam — every other format it names stays unchecked, as AJV leaves it
 *  when it validates a schema. It walks every place a pattern may sit, so a
 *  pattern is judged whether or not a validator would ever compile it. */
let regexMeta: ((schema: unknown) => boolean) & { errors?: AjvErrorLike[] | null } | undefined;
function regexMetaValidator() {
  if (!regexMeta) {
    const meta = new Ajv({ strict: false, allErrors: true, code: { regExp: schemaPattern }, logger: false });
    const draft7 = meta.getSchema("http://json-schema.org/draft-07/schema")!.schema as Record<string, unknown>;
    for (const format of ["uri", "uri-reference", "iri", "iri-reference", "json-pointer", "relative-json-pointer"]) {
      meta.addFormat(format, true);
    }
    meta.addFormat("regex", SCHEMA_REGEX_FORMAT);
    regexMeta = meta.compile({ ...draft7, $id: "telo:schema-pattern-meta" });
  }
  return regexMeta!;
}

const judgedPatterns = new WeakMap<object, SchemaPatternError | null>();

/** The first pattern in `schema` RE2 refuses, at any place the draft-07
 *  meta-schema reads a pattern, with where it sits; null when there is none. */
export function schemaPatternRefusalIn(schema: unknown): SchemaPatternError | null {
  if (!schema || typeof schema !== "object") return null;
  const known = judgedPatterns.get(schema);
  if (known !== undefined) return known;
  const validate = regexMetaValidator();
  let refusal: SchemaPatternError | null = null;
  if (!validate(schema)) {
    for (const error of validate.errors ?? []) {
      if (error.keyword !== "format" || (error.params as { format?: unknown } | undefined)?.format !== "regex") continue;
      const key = (error as { propertyName?: string }).propertyName;
      const pointer = key === undefined ? error.instancePath! : `${error.instancePath}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
      const pattern = key ?? valueAt(schema, error.instancePath!);
      const reason = typeof pattern === "string" ? schemaPatternRefusal(pattern) : undefined;
      if (reason === undefined) continue;
      refusal = new SchemaPatternError(reason, pointer);
      break;
    }
  }
  judgedPatterns.set(schema, refusal);
  return refusal;
}

function valueAt(document: unknown, pointer: string): unknown {
  let at = document;
  for (const raw of pointer.split("/").slice(1)) {
    if (!at || typeof at !== "object") return undefined;
    at = (at as Record<string, unknown>)[raw.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return at;
}

/** An AJV instance of the named configuration. */
export function createAjv(
  configuration: SchemaValidationConfiguration = "analysis",
  options: CreateAjvOptions = {},
): SchemaAjv {
  const settings = CONFIGURATIONS[configuration];
  if (!settings) throw new Error(`unknown schema validation configuration '${configuration}'`);
  const instance = new Ajv({
    strict: false,
    allErrors: settings.allErrors,
    verbose: settings.verbose,
    useDefaults: settings.useDefaults,
    removeAdditional: settings.removeAdditional,
    code: { regExp: schemaPattern, ...(settings.source ? { source: true } : {}) },
  });
  ((addFormats as any).default ?? addFormats)(instance);
  // Every Telo keyword and format, `format: regex` as the pattern seam's verdict.
  registerTeloKeywords(instance, { assertLive: settings.assertLive });
  // This package's own constant, meta-validated once by its test rather than on
  // every instance.
  if (options.manifestRoot !== false) instance.addSchema(ManifestRootSchema, undefined, undefined, false);
  // Every pattern a compiled schema holds is judged, compiled or not.
  const prototype = Object.getPrototypeOf(instance) as { compile: SchemaAjv["compile"] };
  instance.compile = function (this: SchemaAjv, schema: unknown, meta?: boolean) {
    const refusal = schemaPatternRefusalIn(schema);
    if (refusal) throw refusal;
    return prototype.compile.call(this, schema as object, meta);
  } as SchemaAjv["compile"];
  return instance;
}

/** The verbose twin of each instance a failure is judged on, created by the first
 *  failure that has a union to decide. */
const judgeTwins = new WeakMap<object, SchemaNodeValidator>();

/** Issues for `errors`, raised by `host` validating `data` against `schema`, each
 *  union decided by the judge and each finding about a stand-in in `standIns`
 *  excused — or that judging them could not finish. `host` is an `analysis`
 *  instance. */
export function judgedSchemaIssues(
  host: SchemaAjv,
  errors: AjvErrorLike[] | null | undefined,
  data: unknown,
  schema: object,
  standIns?: StandIns,
): SchemaValidationOutcome {
  const twinOf = () => {
    let twin = judgeTwins.get(host);
    if (!twin) {
      twin = new SchemaNodeValidator(createAjv("analysis-verbose"), {
        resolveReference: (id) => registeredDocument(host, id),
        run: (check, value) => check(opaqueSchemaView(value)),
      });
      judgeTwins.set(host, twin);
    }
    return twin;
  };
  return unlessOverflow(() => {
    const judged = judgeSchemaFindings(errors, {
      value: data,
      schema,
      ...(standIns ? { standIns } : {}),
      validate: (node, value) => twinOf().findingsFor(schema)(node, value),
      reference: (node, ref) => twinOf().reference(node, ref),
    });
    return judged.finished ? finishedValidation(schemaIssues(judged.issues, data)) : judged;
  });
}

const ajv = createAjv("analysis");
const compiledSchemaValidators = new WeakMap<Record<string, any>, ReturnType<typeof ajv.compile>>();

/** Does `schema` compile as-authored? Tells a malformed module schema (the author's
 *  problem) apart from a fault introduced while normalizing it. */
function schemaCompiles(schema: Record<string, any>): boolean {
  try {
    ajv.compile(schema);
    return true;
  } catch {
    return false;
  }
}

/** A validation's outcome: its issues — none when the value is valid — or that it
 *  could not finish: the validation nested past the depth the engine's stack
 *  reaches, so it holds no verdict on the value. Every caller reads all three. */
export type SchemaValidationOutcome<I = SchemaIssue> =
  | { readonly finished: true; readonly issues: I[] }
  | ValidationUnfinished;

/** The outcome of a validation that could not finish. */
export interface ValidationUnfinished {
  readonly finished: false;
}

export const VALIDATION_UNFINISHED: ValidationUnfinished = Object.freeze({ finished: false as const });

/** The outcome of a validation that finished with `issues`. */
export function finishedValidation<I>(issues: I[]): SchemaValidationOutcome<I> {
  return { finished: true, issues };
}

/** The code a static check reports a validation that could not finish under. */
export const SCHEMA_NESTING_EXCEEDED = "SCHEMA_NESTING_EXCEEDED";

/** The sentence of a validation that could not finish: `label` is the
 *  declaration (`<Kind>/<name>`), `place` the value it validated (`the value at
 *  'handler'`). */
export function schemaNestingExceededMessage(label: string, place: string): string {
  return `${label}: ${schemaNestingExceededSentence(place)}`;
}

/** {@link schemaNestingExceededMessage} without its label, for a message that
 *  names the declaration itself. */
export function schemaNestingExceededSentence(place: string): string {
  return (
    `${place} cannot be validated — validating it nests past the depth a validation ` +
    `may reach. Either its schema refers to itself without descending into the value, or the ` +
    `value is nested deeper than a validation can follow: make each self-reference descend into ` +
    `the value at every step, or nest the value less deeply.`
  );
}

/** Validate a value against a JSON Schema: issues with path info, none when it is
 *  valid, or that the validation could not finish. An instance value is validated
 *  opaque. A schema that does not compile yields none. */
export function validateAgainstSchema(data: unknown, schema: Record<string, any>): SchemaValidationOutcome {
  let validate = compiledSchemaValidators.get(schema);
  if (!validate) {
    try {
      validate = ajv.compile(schema);
    } catch (err) {
      // A malformed original is the module author's, already reported once at the
      // definition as `SCHEMA_COMPILE_ERROR`; only a fault of ours is thrown.
      if (schemaCompiles(schema)) throw err;
      return finishedValidation([]);
    }
    compiledSchemaValidators.set(schema, validate);
  }
  const compiled = validate;
  return unlessOverflow(() =>
    compiled(opaqueSchemaView(data)) ? finishedValidation([]) : judgedSchemaIssues(ajv, compiled.errors, data, schema),
  );
}

/** `run`, with a validation nesting past the engine's stack answered as one that
 *  could not finish. Nothing else is caught. */
export function unlessOverflow<I>(run: () => SchemaValidationOutcome<I>): SchemaValidationOutcome<I> {
  try {
    return run();
  } catch (error) {
    if (isValidationOverflow(error)) return VALIDATION_UNFINISHED;
    throw error;
  }
}

/** The engine's own stack overflow: V8's `RangeError`, and JavaScriptCore's
 *  spelling of it under Bun. */
export function isValidationOverflow(error: unknown): boolean {
  return (
    error instanceof RangeError &&
    (error.message === "Maximum call stack size exceeded" || error.message === "Maximum call stack size exceeded.")
  );
}

const defaultFillingAjv = createAjv("analysis-defaults");
const defaultFillingValidators = new WeakMap<Record<string, any>, ReturnType<typeof ajv.compile>>();
const defaultFillers = new WeakMap<Record<string, any>, ((value: unknown) => void) | null>();

/** Validates `data` the way the kernel binds a contract: declared defaults are
 *  filled into a copy first — one at an instance-typed slot decoded as its literal
 *  is, then presented opaque — so a value a default completes is not reported. A
 *  schema that does not compile is the author's, reported elsewhere. */
export function validateAgainstSchemaWithDefaults(
  data: unknown,
  schema: Record<string, any>,
): SchemaValidationOutcome {
  let validate = defaultFillingValidators.get(schema);
  if (!validate) {
    try {
      validate = defaultFillingAjv.compile(schema);
    } catch (err) {
      if (schemaCompiles(schema)) throw err;
      return finishedValidation([]);
    }
    defaultFillingValidators.set(schema, validate);
  }
  const compiled = validate;
  let filler = defaultFillers.get(schema);
  if (filler === undefined) defaultFillers.set(schema, (filler = valueTypeDefaultFiller(schema) ?? null));
  const fill = filler;
  return unlessOverflow(() => {
    const copy = structuredClone(data);
    fill?.(copy);
    if (compiled(opaqueSchemaView(copy))) return finishedValidation([]);
    return finishedValidation(schemaIssues(compiled.errors, copy));
  });
}
