import {
  type ArgBinding,
  type DefResolver,
  describeArgBinding,
  effectiveAuthorSchema,
  readApplicationArguments,
  renderApplicationUsage,
  residualEntrySchema,
  withLiveValuesSkipped,
} from "@telorun/analyzer";
import type {
  ResourceContext,
  ResourceDefinition,
  ResourceManifest,
  TypeRule,
} from "@telorun/sdk";
import { RuntimeError } from "@telorun/sdk";
import { parseApplicationArguments } from "./application-arguments.js";
import { create as createJsonSchemaType } from "./controllers/type/json-schema-controller.js";
import { decodeHostValue } from "./host-paths.js";
import { SchemaValidator } from "./schema-validator.js";
import { resolveTypeFieldSchema } from "./type-field-schema.js";

type EntryType = "string" | "integer" | "number" | "boolean" | "object" | "array";

interface EnvEntry {
  env?: string;
  type: EntryType;
  items?: { type?: EntryType };
  default?: unknown;
  [key: string]: unknown;
}

interface PortEntry {
  env?: string;
  protocol?: "tcp" | "udp";
  default?: number;
}

export interface EnvResolutionResult {
  variables: Record<string, unknown>;
  secrets: Record<string, unknown>;
  ports: Record<string, number>;
  /** Set when the command line asked for `--help`: the application's usage,
   *  answered INSTEAD of resolving anything — nothing else in the result is
   *  populated, and the caller runs nothing. */
  help?: string;
}

/** What the command line supplied for one block, and how each entry is spelled
 *  there — for the value's source in a message. */
interface ArgumentChannel {
  values: Record<string, string | boolean | string[]>;
  bindings: Map<string, ArgBinding>;
}

/**
 * Values supplied for this application's declared inputs by whoever started it —
 * a parent application running it as a resource — keyed by DECLARATION name, not
 * by the environment variable the declaration binds.
 *
 * A supplied value replaces the env read for that name and is validated against
 * the same residual schema, so the child stays the authority on what it accepts.
 * A supplied name the application does not declare is an error rather than a
 * silent no-op: it is either a typo or a stale caller, and both read as "the
 * value I passed was ignored" at the far end.
 */
export interface ApplicationInputs {
  variables?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  ports?: Record<string, number>;
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
 * Populate the root Application's `variables` / `secrets` / `ports` namespaces
 * from the host — the command line through each entry's `arg:` binding, the
 * environment through its `env:` binding.
 *
 * For each entry the first source that has a value wins: a value supplied by
 * name (`inputs`), then the command line, then the environment, then
 * `default:`. The raw text is coerced per `entry.type`, validated against the
 * entry's residual schema, and every failure — including every command-line
 * token nothing declares — aggregates into a single
 * `ERR_MANIFEST_VALIDATION_FAILED` error so all problems surface before any
 * controller initializes. `--help` on the command line resolves nothing and
 * returns the usage instead. Argument grammar: `kernel/specs/application-arguments.md`.
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
  inputs?: ApplicationInputs,
  argv: readonly string[] = [],
): EnvResolutionResult {
  const errors: string[] = [];
  const declaredArguments = readApplicationArguments(manifest);
  for (const issue of declaredArguments.issues) errors.push(issue.message);
  const parsed = parseApplicationArguments(declaredArguments.bindings, argv);
  if (parsed.help && errors.length === 0) {
    return { variables: {}, secrets: {}, ports: {}, help: renderApplicationUsage(manifest) };
  }
  errors.push(...parsed.errors);
  const channel = (block: "variables" | "ports"): ArgumentChannel => ({
    values: parsed.values[block],
    bindings: new Map(
      declaredArguments.bindings.filter((b) => b.block === block).map((b) => [b.name, b]),
    ),
  });

  reportUndeclaredInputs(manifest, inputs, errors);
  const variables = resolveBlock(
    manifest.variables ?? {},
    env,
    validator,
    errors,
    false,
    inputs?.variables,
    channel("variables"),
  );
  const secrets = resolveBlock(
    manifest.secrets ?? {},
    env,
    validator,
    errors,
    true,
    inputs?.secrets,
  );
  const ports = resolvePorts(
    manifest.ports ?? {},
    env,
    validator,
    errors,
    inputs?.ports,
    channel("ports"),
  );
  if (errors.length > 0) {
    throw new RuntimeError(
      "ERR_MANIFEST_VALIDATION_FAILED",
      `Application input validation failed:\n` +
        errors.map((e) => `  - ${e}`).join("\n"),
    );
  }
  return { variables, secrets, ports };
}

/**
 * Collect the host env-var *names* the root Application binds — the `env:` key
 * of every `variables` / `secrets` / `ports` entry. This is the denied set for
 * the controller `process.env` guardrail (see `host-env.ts`): a controller must
 * read these through `ctx.env` / the declared binding, never the raw env var.
 */
export function collectDeclaredEnvKeys(manifest: Record<string, any>): string[] {
  const keys: string[] = [];
  for (const block of [manifest.variables, manifest.secrets, manifest.ports]) {
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    for (const entry of Object.values(block as Record<string, { env?: unknown }>)) {
      if (entry && typeof entry === "object" && typeof entry.env === "string") {
        keys.push(entry.env);
      }
    }
  }
  return keys;
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
 * Register every `Telo.JsonSchema` resource's resolved schema into `validator`,
 * ahead of the contract warm below.
 *
 * A contract declared as `{kind: Telo.JsonSchema, schema: {$ref: "telo:m/X"}}`
 * — what `oauth-client` and `vector-store` write — is compiled at runtime from
 * the schema registered under that id, reached by following the alias. With no
 * types registered the warm follows it to the `$ref` wrapper itself, AJV refuses
 * the unresolvable reference, and the entry is silently not baked while the
 * runtime goes on compiling something else: a guaranteed miss for exactly the
 * modules that declare their shapes once and reference them.
 *
 * Runs the REAL type controller rather than re-deriving registration here. The
 * three names a type registers under, the canonical `telo:` id and the `extends`
 * merge are its rules; a second implementation would drift into baking schemas
 * under keys the runtime never asks for — the failure this whole pass exists to
 * remove. The loop mirrors the kernel's multi-pass init (`create` returns null
 * while a parent type is unregistered) and stops as soon as a pass registers
 * nothing new, so an unresolvable parent ends it instead of spinning.
 *
 * The deprecated `Type.JsonSchema` is not warmed: it is a module kind with its
 * own controller, and reaching for this one would be assuming the two stayed
 * identical.
 */
export async function precompileTypeSchemas(
  manifests: Array<Record<string, any>>,
  validator: SchemaValidator,
): Promise<void> {
  const ctx = {
    lookupSchema: (name: string) => validator.getSchema(name),
    registerSchema: (name: string, schema: object) => validator.addSchema(name, schema),
    // This validator only bakes compiled schemas; nothing evaluates a rule
    // through it, so the rules resolve no module call.
    registerTypeRules: (name: string, rules: TypeRule[]) =>
      validator.addTypeRules(name, rules, new Set()),
  } as unknown as ResourceContext;

  let pending = manifests.filter(
    (m) =>
      m?.kind === "Telo.JsonSchema" &&
      m.schema &&
      typeof m.metadata?.name === "string" &&
      typeof m.metadata?.module === "string",
  );
  while (pending.length > 0) {
    const deferred: Array<Record<string, any>> = [];
    for (const m of pending) {
      try {
        if ((await createJsonSchemaType(m as unknown as ResourceManifest, ctx)) === null) {
          deferred.push(m);
        }
      } catch {
        // A broken type surfaces through analysis / runtime, not the warm pass.
      }
    }
    if (deferred.length === pending.length) break;
    pending = deferred;
  }
}

/**
 * Build-time cache warm for resource-config validators. The runtime
 * `_createInstance` compiles the declaring `Telo.Definition`'s `schema` to
 * validate every resource's config, then validates inputs/outputs against
 * `inputType` / `outputType`. The analyze-only warm pass stops before
 * instantiation, so without this those validators are absent from the
 * `__validators` cache and the runtime recompiles (and, on a read-only image,
 * fails to persist) them on every boot.
 *
 * Compiling each definition's `schema` (plus any inline `inputType` /
 * `outputType` object schemas) here writes them into the same content-addressed
 * cache the runtime reads, keyed identically because the same schema object is
 * fed to the same `validator.compile`. Every kind is bakeable now that the
 * manifest is the sole config contract — a controller can no longer supply a
 * schema the warm cannot see. Compile failures are swallowed; a genuinely
 * broken schema surfaces through analysis / runtime, not here.
 *
 * `resolverFor` bakes the INHERITANCE-RESOLVED schema too. A `base:`-less
 * `extends` child is validated at runtime against `merge(parent, own)` — a
 * different object than its raw `schema:`, so a different cache key. Without
 * this the warm bakes a schema the runtime never asks for and every inheriting
 * kind misses on every boot, recompiling (and, on a read-only image, failing to
 * persist) forever. Both forms are compiled — the raw one still backs
 * definitions that don't inherit.
 *
 * It is a factory, not a single resolver, because `extends` aliases are scoped
 * to the DECLARING module — `Cache.Store` reads against that library's import
 * map, `Self.Host` against its own name. A global resolver silently fails to
 * resolve those, yielding the un-merged schema and reintroducing the very miss
 * this exists to prevent.
 */
export function precompileDefinitionSchemas(
  manifests: Array<Record<string, any>>,
  validator: SchemaValidator,
  resolverFor?: (def: Record<string, any>) => DefResolver,
): void {
  const compile = (schema: unknown): void => {
    if (!schema || typeof schema !== "object") return;
    try {
      validator.compile(schema as any);
    } catch {
      // Broken schemas are reported by analysis / runtime, not the warm pass.
    }
  };
  const lookup = (name: string) => validator.getSchema(name);
  // A contract validator is compiled from the RESOLVED schema with its
  // `x-telo-stream` properties stripped, never from the declaration — see
  // `resolveBoundContract`. Baking the declaration instead bakes a validator for
  // `{kind, schema}`, which no dispatch asks for. A declaration that needs the
  // runtime type registry (a bare name, a `{kind, name}` ref) resolves to
  // nothing here — named types register when their resources initialize, long
  // after the warm — so it is skipped rather than baked wrong.
  const compileContract = (declared: unknown): void => {
    if (declared === undefined || declared === null) return;
    try {
      const schema = resolveTypeFieldSchema(declared, lookup);
      if (!schema) return;
      compile(withLiveValuesSkipped(schema, (ref) => lookup(ref) as any));
    } catch {
      // An unresolvable contract is a dispatch-time error, not a warm failure.
    }
  };
  for (const m of manifests) {
    // A per-instance contract overrides the kind's, so a resource declaring its
    // own narrowing is what the runtime compiles for that instance.
    compileContract(m?.inputType);
    compileContract(m?.outputType);
    if (m?.kind !== "Telo.Definition") continue;
    compile(m.schema);
    if (resolverFor && m.extends) {
      // Mirrors the runtime stamp in `resource-definition-controller`; sharing
      // `effectiveAuthorSchema` is what keeps the two keys identical.
      try {
        compile(effectiveAuthorSchema(m as unknown as ResourceDefinition, resolverFor(m)));
      } catch {
        // An unresolvable parent is a diagnostic elsewhere; the warm just skips.
      }
    }
  }
}

/**
 * Populate the root Application's `ports` namespace. Mirrors `resolveBlock` but
 * fixes the value type to a port integer (1–65535): the host text — from the
 * command line, else `entry.env` — is coerced as an integer and validated
 * against `PORT_RESIDUAL_SCHEMA`, falling back to `entry.default`. Failures
 * aggregate into the shared `errors` list so they surface alongside
 * variable/secret problems.
 */
function resolvePorts(
  block: Record<string, PortEntry> | unknown,
  env: Record<string, string | undefined>,
  validator: SchemaValidator,
  errors: string[],
  supplied: Record<string, number> | undefined,
  args: ArgumentChannel,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    return out;
  }
  for (const [name, entry] of Object.entries(block as Record<string, PortEntry>)) {
    if (!entry || typeof entry !== "object") continue;
    // A supplied value is already in the value domain — it came from a parent
    // manifest, not from host text — so it is validated but never coerced.
    if (supplied && Object.hasOwn(supplied, name)) {
      const validation = validateResidual(supplied[name], PORT_RESIDUAL_SCHEMA, validator);
      if (validation) errors.push(`${name}: ${validation}`);
      else out[name] = supplied[name];
      continue;
    }
    const host = hostText(name, entry, env, args);
    if (host === undefined) {
      if (entry.default !== undefined) {
        const validation = validateResidual(entry.default, PORT_RESIDUAL_SCHEMA, validator);
        if (validation) {
          errors.push(`${name}: ${validation}`);
        } else {
          out[name] = entry.default;
        }
        continue;
      }
      errors.push(`${name}: ${describeMissing(name, entry, args)}`);
      continue;
    }

    let coerced: unknown;
    try {
      coerced = coerce(host.raw as string, "integer", host.source, false);
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
  supplied?: Record<string, unknown>,
  args?: ArgumentChannel,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    return out;
  }
  for (const [name, entry] of Object.entries(block as Record<string, EnvEntry>)) {
    if (!entry || typeof entry !== "object") continue;
    const residual = residualEntrySchema(entry as Record<string, unknown>);
    // See the note in `resolvePorts`: a supplied value is a value, not text, so
    // it is validated against the same residual schema but never coerced.
    if (supplied && Object.hasOwn(supplied, name)) {
      const validation = validateResidual(supplied[name], residual, validator);
      if (validation) errors.push(`${name}: ${validation}`);
      else out[name] = supplied[name];
      continue;
    }
    const host = hostText(name, entry, env, args);
    if (host === undefined) {
      if (entry.default !== undefined) {
        // Decoded on a copy: the default is the manifest's own literal.
        const fallback = decodeFromOutside(structuredClone(entry.default), residual, validator);
        const validation = validateResidual(fallback, residual, validator);
        if (validation) {
          errors.push(`${name}: ${validation}`);
        } else {
          out[name] = fallback;
        }
        continue;
      }
      errors.push(`${name}: ${describeMissing(name, entry, args)}`);
      continue;
    }

    let coerced: unknown;
    try {
      coerced = decodeFromOutside(coerceHostText(host, entry, isSecret), residual, validator);
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

/** The host text an entry receives and where it came from — the command line
 *  first, then the environment — or `undefined` when neither supplies one. A
 *  boolean flag arrives already read; a repeated flag as its list of tokens. */
interface HostText {
  raw: string | boolean | string[];
  source: string;
}

function hostText(
  name: string,
  entry: { env?: string },
  env: Record<string, string | undefined>,
  args: ArgumentChannel | undefined,
): HostText | undefined {
  const binding = args?.bindings.get(name);
  if (binding && args && Object.hasOwn(args.values, name)) {
    return { raw: args.values[name]!, source: `argument ${describeArgBinding(binding)}` };
  }
  if (typeof entry.env === "string") {
    const raw = env[entry.env];
    if (raw !== undefined && raw !== null) {
      return { raw, source: `environment variable ${entry.env}` };
    }
  }
  return undefined;
}

/** A command-line value is read per token — each element of a repeated flag by
 *  `items.type` — where an environment value of an array or object type is one
 *  JSON document. */
function coerceHostText(host: HostText, entry: EnvEntry, isSecret: boolean): unknown {
  if (typeof host.raw === "boolean") return host.raw;
  if (Array.isArray(host.raw)) {
    const itemType = (entry.items?.type ?? "string") as EntryType;
    return host.raw.map((token) => coerce(token, itemType, host.source, isSecret));
  }
  return coerce(host.raw, entry.type, host.source, isSecret);
}

function describeMissing(
  name: string,
  entry: { env?: string },
  args: ArgumentChannel | undefined,
): string {
  const binding = args?.bindings.get(name);
  const channels = [
    ...(binding ? [`argument ${describeArgBinding(binding)} was not given`] : []),
    ...(typeof entry.env === "string" ? [`environment variable ${entry.env} is not set`] : []),
  ];
  return `${channels.join(" and ")} (no default)`;
}

/**
 * Refuse every supplied name the application does not declare, before any of
 * them is resolved, so a caller sees the whole list at once rather than the
 * first one.
 *
 * The declared names are named back: a caller that misspelled one is looking at
 * the spelling it should have used, and a caller written against an older
 * version of the child sees what the child accepts now.
 */
function reportUndeclaredInputs(
  manifest: Record<string, any>,
  inputs: ApplicationInputs | undefined,
  errors: string[],
): void {
  if (!inputs) return;
  for (const block of ["variables", "secrets", "ports"] as const) {
    const supplied = inputs[block];
    if (!supplied) continue;
    const declared = manifest[block];
    const names =
      declared && typeof declared === "object" && !Array.isArray(declared)
        ? Object.keys(declared)
        : [];
    for (const name of Object.keys(supplied)) {
      if (names.includes(name)) continue;
      errors.push(
        `${name}: this application declares no \`${block}\` entry by that name` +
          (names.length > 0 ? ` (it declares: ${names.join(", ")})` : ` (it declares none)`),
      );
    }
  }
}

/** An env value arrives from outside Telo, so every instance-typed slot in it is
 *  read from its plain encoding — the whole value (`x-telo-type: Telo.Timestamp`)
 *  or a field of a JSON-decoded one — and every host path in it is resolved
 *  against its anchor. Text the encoding refuses is left for validation to
 *  report. */
function decodeFromOutside(
  value: unknown,
  residual: Record<string, unknown>,
  validator: SchemaValidator,
): unknown {
  return decodeHostValue(
    value,
    residual as Record<string, any>,
    (ref) => validator.getSchema(ref) as Record<string, any> | undefined,
  );
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
  source: string,
  isSecret: boolean,
): unknown {
  switch (type) {
    case "string":
      return raw;
    case "integer": {
      const trimmed = raw.trim();
      if (!/^-?\d+$/.test(trimmed)) {
        throw new Error(
          `${source}: value ${renderRawForError(raw, isSecret)} is not a valid integer`,
        );
      }
      return parseInt(trimmed, 10);
    }
    case "number": {
      const n = parseFloat(raw);
      if (Number.isNaN(n)) {
        throw new Error(
          `${source}: value ${renderRawForError(raw, isSecret)} is not a valid number`,
        );
      }
      return n;
    }
    case "boolean":
      if (raw === "true") return true;
      if (raw === "false") return false;
      throw new Error(
        `${source}: value ${renderRawForError(raw, isSecret)} is not a valid boolean (expected "true" or "false")`,
      );
    case "object": {
      const parsed = parseJson(raw, source, isSecret);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(
          `${source}: expected JSON object, got ${describeJsonType(parsed)}`,
        );
      }
      return parsed;
    }
    case "array": {
      const parsed = parseJson(raw, source, isSecret);
      if (!Array.isArray(parsed)) {
        throw new Error(
          `${source}: expected JSON array, got ${describeJsonType(parsed)}`,
        );
      }
      return parsed;
    }
  }
}

function parseJson(raw: string, source: string, isSecret: boolean): unknown {
  try {
    return JSON.parse(raw);
  } catch (e) {
    // Node's JSON.parse error embeds the offending character / position; for
    // secrets, swallow the parser detail and surface only the env var name.
    const detail = isSecret ? "value is not valid JSON" : (e as Error).message;
    throw new Error(`${source}: ${isSecret ? detail : `value is not valid JSON: ${detail}`}`);
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
