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

interface PortEntry {
  env: string;
  protocol?: "tcp" | "udp";
  default?: number;
}

export interface EnvResolutionResult {
  variables: Record<string, unknown>;
  secrets: Record<string, unknown>;
  ports: Record<string, number>;
}

/** Residual schema every resolved port value is validated against. Ports are
 *  implicitly integers in the IANA range; `protocol` selects transport and
 *  carries no validation. */
const PORT_RESIDUAL_SCHEMA: Record<string, unknown> = {
  type: "integer",
  minimum: 1,
  maximum: 65535,
};

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
  const ports = resolvePorts(manifest.ports ?? {}, env, validator, errors);
  if (errors.length > 0) {
    throw new RuntimeError(
      "ERR_MANIFEST_VALIDATION_FAILED",
      `Application environment validation failed:\n` +
        errors.map((e) => `  - ${e}`).join("\n"),
    );
  }
  return { variables, secrets, ports };
}

/**
 * Build-time cache warm: compile — but do NOT validate — the residual schema
 * for every `variables` / `secrets` / `ports` entry the runtime
 * `resolveApplicationEnv` would, so each standalone validator lands in the
 * on-disk `__validators` cache. Schema *compilation* is value-independent, so
 * this needs none of the host env vars / secrets `resolveApplicationEnv`
 * requires — it can run during `telo install`. At run time on a read-only
 * session rootfs `resolveApplicationEnv` then hits the cache instead of
 * recompiling and failing to persist (ENOENT / EROFS).
 *
 * Mirrors `resolveApplicationEnv` exactly: same `residualEntrySchema` per
 * variable/secret and the same `PORT_RESIDUAL_SCHEMA`, so the cache keys
 * match byte-for-byte. Compile failures are swallowed — a genuinely broken
 * schema surfaces through the normal analysis/runtime path, not here.
 */
export function precompileApplicationEnvSchemas(
  manifest: Record<string, any>,
  validator: SchemaValidator,
): void {
  const compile = (schema: Record<string, unknown>): void => {
    try {
      validator.compile(schema as any);
    } catch {
      // Broken schemas are reported by analysis / runtime, not the warm pass.
    }
  };
  for (const block of [manifest.variables, manifest.secrets]) {
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    for (const entry of Object.values(block as Record<string, EnvEntry>)) {
      if (!entry || typeof entry !== "object") continue;
      compile(residualEntrySchema(entry as Record<string, unknown>));
    }
  }
  const ports = manifest.ports;
  if (
    ports &&
    typeof ports === "object" &&
    !Array.isArray(ports) &&
    Object.keys(ports).length > 0
  ) {
    compile(PORT_RESIDUAL_SCHEMA);
  }
}

/**
 * Build-time cache warm for resource-config validators. The runtime
 * `_createInstance` compiles `controller.schema` — which falls back to the
 * declaring `Telo.Definition`'s own `schema` — to validate every resource's
 * config, then validates inputs/outputs against `inputType` / `outputType`.
 * The analyze-only warm pass stops before instantiation, so without this those
 * validators are absent from the `__validators` cache and the runtime
 * recompiles (and, on a read-only image, fails to persist) them on every boot.
 *
 * Compiling each definition's `schema` (plus any inline `inputType` /
 * `outputType` object schemas) here writes them into the same content-addressed
 * cache the runtime reads, keyed identically because the same schema object is
 * fed to the same `validator.compile`. Definitions whose controller exports its
 * own `schema` (rare) still recompile at runtime — that needs the controller
 * loaded, which the warm pass does not do. Compile failures are swallowed; a
 * genuinely broken schema surfaces through analysis / runtime, not here.
 */
export function precompileDefinitionSchemas(
  manifests: Array<Record<string, any>>,
  validator: SchemaValidator,
): void {
  const compile = (schema: unknown): void => {
    if (!schema || typeof schema !== "object") return;
    try {
      validator.compile(schema as any);
    } catch {
      // Broken schemas are reported by analysis / runtime, not the warm pass.
    }
  };
  for (const m of manifests) {
    if (m?.kind !== "Telo.Definition") continue;
    compile(m.schema);
    compile(m.inputType);
    compile(m.outputType);
  }
}

/**
 * Populate the root Application's `ports` namespace from host environment
 * variables. Mirrors `resolveBlock` but fixes the value type to a port integer
 * (1–65535): read `entry.env`, coerce the raw value as an integer, validate it
 * against `PORT_RESIDUAL_SCHEMA`, and fall back to `entry.default` when the env
 * var is unset. Failures aggregate into the shared `errors` list so they
 * surface alongside variable/secret problems.
 */
function resolvePorts(
  block: Record<string, PortEntry> | unknown,
  env: Record<string, string | undefined>,
  validator: SchemaValidator,
  errors: string[],
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    return out;
  }
  for (const [name, entry] of Object.entries(block as Record<string, PortEntry>)) {
    if (!entry || typeof entry !== "object") continue;
    const envKey = entry.env;
    const raw = env[envKey];

    if (raw === undefined || raw === null) {
      if (entry.default !== undefined) {
        const validation = validateResidual(entry.default, PORT_RESIDUAL_SCHEMA, validator);
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
      coerced = coerce(raw, "integer", envKey, false);
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message}`);
      continue;
    }

    const validation = validateResidual(coerced, PORT_RESIDUAL_SCHEMA, validator);
    if (validation) {
      errors.push(`${name}: ${validation}`);
      continue;
    }

    out[name] = coerced as number;
  }
  return out;
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
