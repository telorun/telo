import { residualEntrySchema } from "@telorun/analyzer";
import { RuntimeError } from "@telorun/sdk";
import { SchemaValidator } from "./schema-validator.js";

type EntryType = "string" | "integer" | "number" | "boolean" | "object" | "array";

interface EnvEntry {
  env: string;
  type: EntryType;
  default?: unknown;
  [key: string]: unknown;
}

export interface EnvResolutionResult {
  variables: Record<string, unknown>;
  secrets: Record<string, unknown>;
}

/**
 * Populate the root Application's `variables` / `secrets` namespaces from
 * host environment variables, per the per-field `env:` mapping declared on
 * each entry.
 *
 * Implements the polyglot env-resolution spec from
 * kernel/nodejs/plans/application-env-variables.md: read the env var, coerce
 * per `entry.type`, validate the coerced value (or the declared default, when
 * the env var is unset) against the entry's residual schema, and aggregate
 * every failure into a single `ERR_MANIFEST_VALIDATION_FAILED` error so all
 * problems surface before any controller initializes.
 *
 * This must run BEFORE any Telo.Import controller initializes — imports may
 * pass `${{ variables.X }}` as their `variables:` inputs, so the root scope
 * has to be populated by the time the import controller evaluates those
 * expressions.
 */
export function resolveApplicationEnv(
  manifest: Record<string, any>,
  env: Record<string, string | undefined>,
  validator: SchemaValidator,
): EnvResolutionResult {
  const errors: string[] = [];
  const variables = resolveBlock(
    manifest.variables ?? {},
    env,
    validator,
    errors,
    false,
  );
  const secrets = resolveBlock(
    manifest.secrets ?? {},
    env,
    validator,
    errors,
    true,
  );
  if (errors.length > 0) {
    throw new RuntimeError(
      "ERR_MANIFEST_VALIDATION_FAILED",
      `Application environment validation failed:\n` +
        errors.map((e) => `  - ${e}`).join("\n"),
    );
  }
  return { variables, secrets };
}

function resolveBlock(
  block: Record<string, EnvEntry> | unknown,
  env: Record<string, string | undefined>,
  validator: SchemaValidator,
  errors: string[],
  isSecret: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    return out;
  }
  for (const [name, entry] of Object.entries(block as Record<string, EnvEntry>)) {
    if (!entry || typeof entry !== "object") continue;
    const envKey = entry.env;
    const raw = env[envKey];
    const residual = residualEntrySchema(entry as Record<string, unknown>);

    if (raw === undefined || raw === null) {
      if (entry.default !== undefined) {
        const validation = validateResidual(entry.default, residual, validator);
        if (validation) {
          errors.push(`${name}: ${validation}`);
        } else {
          out[name] = entry.default;
        }
        continue;
      }
      errors.push(`${name}: environment variable ${envKey} is not set (no default)`);
      continue;
    }

    let coerced: unknown;
    try {
      coerced = coerce(raw, entry.type, envKey, isSecret);
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message}`);
      continue;
    }

    const validation = validateResidual(coerced, residual, validator);
    if (validation) {
      errors.push(`${name}: ${validation}`);
      continue;
    }

    out[name] = coerced;
  }
  return out;
}

/** Render a raw env value for inclusion in an error message. Secret values
 *  are masked so coercion / schema diagnostics don't leak secret material
 *  into logs (the env-var name and the failure reason still surface). */
function renderRawForError(raw: string, isSecret: boolean): string {
  return isSecret ? "<redacted>" : `"${raw}"`;
}

function coerce(
  raw: string,
  type: EntryType,
  envKey: string,
  isSecret: boolean,
): unknown {
  switch (type) {
    case "string":
      return raw;
    case "integer": {
      const trimmed = raw.trim();
      if (!/^-?\d+$/.test(trimmed)) {
        throw new Error(
          `environment variable ${envKey}: value ${renderRawForError(raw, isSecret)} is not a valid integer`,
        );
      }
      return parseInt(trimmed, 10);
    }
    case "number": {
      const n = parseFloat(raw);
      if (Number.isNaN(n)) {
        throw new Error(
          `environment variable ${envKey}: value ${renderRawForError(raw, isSecret)} is not a valid number`,
        );
      }
      return n;
    }
    case "boolean":
      if (raw === "true") return true;
      if (raw === "false") return false;
      throw new Error(
        `environment variable ${envKey}: value ${renderRawForError(raw, isSecret)} is not a valid boolean (expected "true" or "false")`,
      );
    case "object": {
      const parsed = parseJson(raw, envKey, isSecret);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(
          `environment variable ${envKey}: expected JSON object, got ${describeJsonType(parsed)}`,
        );
      }
      return parsed;
    }
    case "array": {
      const parsed = parseJson(raw, envKey, isSecret);
      if (!Array.isArray(parsed)) {
        throw new Error(
          `environment variable ${envKey}: expected JSON array, got ${describeJsonType(parsed)}`,
        );
      }
      return parsed;
    }
  }
}

function parseJson(raw: string, envKey: string, isSecret: boolean): unknown {
  try {
    return JSON.parse(raw);
  } catch (e) {
    // Node's JSON.parse error embeds the offending character / position; for
    // secrets, swallow the parser detail and surface only the env var name.
    const detail = isSecret ? "value is not valid JSON" : (e as Error).message;
    throw new Error(`environment variable ${envKey}: ${isSecret ? detail : `value is not valid JSON: ${detail}`}`);
  }
}

function describeJsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function validateResidual(
  value: unknown,
  residual: Record<string, unknown>,
  validator: SchemaValidator,
): string | null {
  try {
    validator.compile(residual as any).validate(value);
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Strip SchemaValidator's "Invalid value passed: <JSON>. Error: " prefix
    // so the JSON-stringified value (which can be secret material for entries
    // under `secrets:`) never reaches the caller. The split is anchored on
    // the literal ". Error: " delimiter — a `[^.]*` regex would have leaked
    // any value containing a dot (URLs, versions, paths).
    const sentinel = ". Error: ";
    const idx = msg.indexOf(sentinel);
    if (msg.startsWith("Invalid value passed:") && idx !== -1) {
      return msg.slice(idx + sentinel.length);
    }
    return msg;
  }
}
