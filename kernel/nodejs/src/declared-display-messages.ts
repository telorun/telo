/**
 * **The display messages a kind declares for its codes** —
 * `throws.codes.<CODE>.displayMessage` — and the one rule that attaches them to
 * a failure.
 *
 * A kind's display messages are resolved once, when the kind registers, in the scope that
 * declared it: the nearest declaration along `extends` wins per code, and each is
 * the record creation settled (`{ text, context, lang, computed }`, in the
 * declaring module's language). They are stamped on the definition as
 * `declaredDisplayMessages`, a derived field no manifest writes, so a dispatch exit —
 * which holds the kind and no declaring scope — reads them with one lookup.
 *
 * Where an error leaves a dispatch, a code the kind declares with a
 * `displayMessage` gets it unless the error already carries one, and its `data`
 * is held to the code's declared `data` schema first: a mismatch is
 * `ERR_OUTPUT_INVALID` naming the original code, so rendering the display
 * message can never fail. An ambient code the kind does not declare gets its
 * built-in one.
 */
import type { DefResolver } from "@telorun/analyzer";
import {
  attachDisplayMessage,
  builtinErrorCode,
  InvokeError,
  isTextRecord,
  type ResourceDefinition,
  type TextRecord,
} from "@telorun/sdk";
import { SchemaValidationError, type SchemaValidator } from "./schema-validator.js";

export interface DeclaredDisplayMessage {
  readonly record: TextRecord;
  /** The code's declared `data` schema, when it declares one. */
  readonly data?: Record<string, unknown>;
  /** `<module>.<Name>` of the definition declaring it, for messages. */
  readonly declarer: string;
}

type Stamped = ResourceDefinition & { declaredDisplayMessages?: Readonly<Record<string, DeclaredDisplayMessage>> };

const declarerName = (def: ResourceDefinition): string => {
  const module = (def.metadata as { module?: string } | undefined)?.module;
  return module ? `${module}.${def.metadata?.name}` : String(def.metadata?.name);
};

/**
 * The display messages `def` declares, its parent's (already registered, so already
 * stamped) beneath its own. Stamped on `def`, which is the object the kind
 * registers.
 */
export function stampDeclaredDisplayMessages(def: ResourceDefinition, resolveDef: DefResolver): void {
  const parent = typeof def.extends === "string" ? (resolveDef(def.extends, def) as Stamped | undefined) : undefined;
  const out: Record<string, DeclaredDisplayMessage> = { ...(parent?.declaredDisplayMessages ?? {}) };
  const codes = (def as { throws?: { codes?: Record<string, { displayMessage?: unknown; data?: unknown }> } }).throws?.codes ?? {};
  for (const [code, entry] of Object.entries(codes)) {
    if (!entry || entry.displayMessage === undefined) continue;
    if (!isTextRecord(entry.displayMessage)) {
      throw new Error(
        `${declarerName(def)}: throws.codes.${code}.displayMessage reached registration unsettled — a ` +
          `definition's texts are settled into records when it is created.`,
      );
    }
    out[code] = {
      record: entry.displayMessage,
      ...(entry.data && typeof entry.data === "object" ? { data: entry.data as Record<string, unknown> } : {}),
      declarer: declarerName(def),
    };
  }
  if (Object.keys(out).length > 0) (def as Stamped).declaredDisplayMessages = out;
}

/** The display message `def` declares for `code`, or — for an ambient code — the built-in one. */
export function declaredDisplayMessageOf(def: ResourceDefinition | undefined, code: string): DeclaredDisplayMessage | undefined {
  const declared = (def as Stamped | undefined)?.declaredDisplayMessages?.[code];
  if (declared) return declared;
  const builtin = builtinErrorCode(code);
  return builtin ? { record: builtin.record, ...(builtin.data ? { data: builtin.data } : {}), declarer: "Telo" } : undefined;
}

/** Validates `data` against a JSON Schema; the issues, empty when it holds. */
export type ErrorDataValidator = (schema: Record<string, unknown>, data: unknown) => readonly string[];

/** The kernel's validator as an {@link ErrorDataValidator}: one engine in the
 *  process, its named shapes and keywords included. */
export function errorDataValidatorOver(validator: SchemaValidator): ErrorDataValidator {
  return (schema, data) => {
    const compiled = validator.compile(schema, { persist: false });
    try {
      compiled.validate(data);
      return [];
    } catch (error) {
      if (error instanceof SchemaValidationError) {
        return error.issues.map((issue) => issue.message);
      }
      throw error;
    }
  };
}

/**
 * The refusal of `data` that does not satisfy what `entry` declares, or
 * undefined when it does. The original code and its data ride the refusal.
 */
export function errorDataRefusal(
  entry: DeclaredDisplayMessage,
  code: string,
  data: unknown,
  validate: ErrorDataValidator,
  where: string,
): InvokeError | undefined {
  if (!entry.data) return undefined;
  const issues = validate(entry.data, data === undefined ? null : data);
  if (issues.length === 0) return undefined;
  return new InvokeError(
    "ERR_OUTPUT_INVALID",
    `${where}: the error '${code}' carries data its kind does not declare (declared by ${entry.declarer}): ${issues.join("; ")}`,
    { code, data: data ?? null, issues },
  );
}

/**
 * The rule at a dispatch exit: hold the error's data to the declared schema and
 * give the error its display message. Returns the error to raise — `err` itself, or the
 * `ERR_OUTPUT_INVALID` refusing its data.
 */
export function settleDisplayMessage(
  err: InvokeError,
  def: ResourceDefinition | undefined,
  validate: ErrorDataValidator,
  where: string,
): InvokeError {
  const entry = declaredDisplayMessageOf(def, err.code);
  if (!entry) return err;
  const refusal = errorDataRefusal(entry, err.code, err.data, validate, where);
  if (refusal) {
    const own = declaredDisplayMessageOf(def, refusal.code);
    if (own) attachDisplayMessage(refusal, own.record);
    return refusal;
  }
  attachDisplayMessage(err, entry.record);
  return err;
}
