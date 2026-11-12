/**
 * **The display messages a kind declares for its codes** —
 * `throws.codes.<CODE>.displayMessage` — and the one rule that attaches them to
 * a failure.
 *
 * A kind's display messages are the analysis registry's answer for the kind
 * (`EffectiveKind.displayMessages`): the nearest declaration along `extends`
 * per code, each the record creation settled (`{ text, context, lang,
 * computed }`, in the declaring module's language).
 *
 * Where an error leaves a dispatch, a code the kind declares with a
 * `displayMessage` gets it unless the error already carries one, and its `data`
 * is held to the code's declared `data` schema first: a mismatch is
 * `ERR_OUTPUT_INVALID` naming the original code, so rendering the display
 * message can never fail. An ambient code the kind does not declare gets its
 * built-in one.
 */
import type { EffectiveKind } from "@telorun/analyzer";
import {
  attachDisplayMessage,
  builtinErrorCode,
  InvokeError,
  isTextRecord,
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

/** The display message `kind` declares for `code`, or — for an ambient code — the built-in one. */
export function declaredDisplayMessageOf(kind: EffectiveKind | undefined, code: string): DeclaredDisplayMessage | undefined {
  const declared = kind?.displayMessages[code];
  if (declared) {
    if (!isTextRecord(declared.displayMessage)) {
      throw new Error(
        `${declared.declarer}: throws.codes.${code}.displayMessage reached a dispatch unsettled — a ` +
          `definition's texts are settled into records when it is created.`,
      );
    }
    return {
      record: declared.displayMessage,
      ...(declared.data ? { data: declared.data } : {}),
      declarer: declared.declarer,
    };
  }
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
  kind: EffectiveKind | undefined,
  validate: ErrorDataValidator,
  where: string,
): InvokeError {
  const entry = declaredDisplayMessageOf(kind, err.code);
  if (!entry) return err;
  const refusal = errorDataRefusal(entry, err.code, err.data, validate, where);
  if (refusal) {
    const own = declaredDisplayMessageOf(kind, refusal.code);
    if (own) attachDisplayMessage(refusal, own.record);
    return refusal;
  }
  attachDisplayMessage(err, entry.record);
  return err;
}
