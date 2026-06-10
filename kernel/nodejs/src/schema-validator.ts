import { evaluate } from "@marcbachmann/cel-js";
import { DataValidator, isCompiledValue, RuntimeError, TypeRule } from "@telorun/sdk";
import AjvModule, { type ValidateFunction } from "ajv";
import standaloneCodeMod from "ajv/dist/standalone/index.js";
import addFormats from "ajv-formats";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { formatAjvErrors } from "./manifest-schemas.js";
import { isTaggedSentinel, ManifestRootSchema, normalizeRefSlots } from "@telorun/templating";

const Ajv = AjvModule.default ?? AjvModule;
// AJV's standalone subpath is CJS — the default export shows up as either
// the function itself or `.default` depending on how the bundler/loader
// rewrites it. Normalise once.
const standaloneCode: (...args: any[]) => string =
  (standaloneCodeMod as any).default ?? (standaloneCodeMod as any);

/** `require` resolved from this file's URL — used to satisfy `ajv/dist/...`
 *  / `ajv-formats/...` imports embedded in standalone-compiled validators
 *  loaded back off disk. Anchored here so it always resolves through the
 *  kernel package's node_modules, regardless of where the cache file
 *  lives on disk. */
const kernelRequire = createRequire(import.meta.url);

/** Resolved AJV + ajv-formats versions, baked into every cache key so a
 *  pnpm/npm install that upgrades either package invalidates all stale
 *  `<hash>.cjs` files automatically. Standalone-compiled validators
 *  embed `require("ajv/dist/runtime/...")` — running a validator built
 *  against an older AJV against the current runtime is undefined
 *  behaviour, so the version pin must be part of the hash, not a manual
 *  bump. Falls back to walking up from the package's main entry when
 *  the dependency restricts subpath access via `exports`. */
function readDepVersion(spec: string): string {
  try {
    const pkg = kernelRequire(`${spec}/package.json`);
    if (typeof pkg.version === "string") return pkg.version;
  } catch {
    // restricted exports — try the filesystem walk below
  }
  try {
    const entry = kernelRequire.resolve(spec);
    let dir = path.dirname(entry);
    while (dir !== path.dirname(dir)) {
      const candidate = path.join(dir, "package.json");
      try {
        const pkg = JSON.parse(fs.readFileSync(candidate, "utf-8"));
        const expectedName = spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");
        if (typeof pkg.name === "string" && pkg.name === expectedName) {
          return typeof pkg.version === "string" ? pkg.version : "unknown";
        }
      } catch {
        // keep walking — not at the package root yet
      }
      dir = path.dirname(dir);
    }
  } catch {
    // package not installed
  }
  return "unknown";
}
const AJV_VERSION = readDepVersion("ajv");
const AJV_FORMATS_VERSION = readDepVersion("ajv-formats");
const VALIDATOR_RUNTIME_TAG = `ajv@${AJV_VERSION}+ajv-formats@${AJV_FORMATS_VERSION}`;

const SHA256_HEADER_PATTERN = /^\/\/ sha256:([0-9a-f]{64})\n/;

/** Verify a cached validator file's SHA-256 integrity header and return
 *  the body when the digest matches. Returns `null` on any mismatch /
 *  malformed header — the caller treats that as a cache miss and
 *  recompiles + overwrites the file. */
function verifyAndExtractBody(text: string): string | null {
  const match = text.match(SHA256_HEADER_PATTERN);
  if (!match) return null;
  const body = text.slice(match[0].length);
  const actual = createHash("sha256").update(body).digest("hex");
  return actual === match[1] ? body : null;
}

/** Deep-clone `value` collapsing every CEL/template sentinel to its original
 *  `source` string, for use as the validator cache *key* only.
 *
 *  The same `Telo.Definition` schema reaches `compile()` in two forms: the
 *  build-time validator warm feeds the raw analysis graph (parse-time
 *  `{__tagged, engine, source}` sentinels, or plain `${{ }}` strings for inline
 *  templates), while the runtime feeds the compile-loader output (`{__compiled,
 *  source, parts}`). A `!cel` / `!sql` tag embedded anywhere in a schema — most
 *  commonly inside `examples` / `description`, but the loader rewrites them at
 *  any position — therefore serialises differently between the two, so without
 *  normalisation the same kind hashes differently and the runtime misses the
 *  warmed cache (and fails to persist it read-only). Both sentinel shapes carry
 *  the same original `source`, so collapsing each to that string converges them.
 *
 *  This rewrites only the hash key — AJV still compiles the full `injected`
 *  schema. Unlike dropping keys by name, it never removes a structural node, so
 *  a property literally named `description` / `examples` keeps its schema in the
 *  key and two genuinely different shapes never collide. */
function normalizeSentinelsForHash(value: unknown): unknown {
  if (isCompiledValue(value) || isTaggedSentinel(value)) {
    return typeof value.source === "string" ? value.source : { __teloSentinel: true };
  }
  if (Array.isArray(value)) return value.map(normalizeSentinelsForHash);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normalizeSentinelsForHash(v);
    }
    return out;
  }
  return value;
}

export class SchemaValidator {
  private ajv: InstanceType<typeof Ajv>;
  private typeRules = new Map<string, TypeRule[]>();
  private rawSchemas = new Map<string, object>();
  private compiledValidators = new WeakMap<object, DataValidator>();
  private cacheDir: string | undefined;
  /** Tracks (schema-hash → in-memory compiled validator) so two distinct
   *  but content-equal schema objects share one compile across the kernel
   *  process — `compiledValidators` is keyed by object identity and would
   *  miss those cases. */
  private hashCache = new Map<string, DataValidator>();

  constructor() {
    this.ajv = new Ajv({
      strict: false,
      removeAdditional: false,
      useDefaults: true,
      // Required for `standaloneCode` extraction — tells AJV to keep the
      // generated validator's source available rather than wrapping it
      // through `new Function`. The cost at compile time is negligible.
      code: { source: true },
    });
    addFormats.default(this.ajv);
    for (const kw of [
      "x-telo-ref",
      "x-telo-eval",
      "x-telo-scope",
      "x-telo-context",
      "x-telo-context-from",
      "x-telo-context-ref-from",
      "x-telo-schema-from",
      "x-telo-topology-role",
      "x-telo-step-context",
      "x-telo-widget",
      "x-telo-type",
    ]) {
      this.ajv.addKeyword(kw);
    }
    // Register the shared manifest root so module schemas can
    // `$ref: "telo://manifest#/$defs/ResourceRef"` without each manifest
    // bundling its own copy. Mirrors the analyzer's createAjv().
    this.ajv.addSchema(ManifestRootSchema);
  }

  addSchema(name: string, schema: object): void {
    if (!this.ajv.getSchema(name)) {
      this.ajv.addSchema(schema, name);
    }
    this.rawSchemas.set(name, schema);
  }

  getSchema(name: string): object | undefined {
    return this.rawSchemas.get(name);
  }

  addTypeRules(name: string, rules: TypeRule[]): void {
    this.typeRules.set(name, rules);
  }

  getTypeRules(name: string): TypeRule[] | undefined {
    return this.typeRules.get(name);
  }

  /** Enable the on-disk validator cache rooted at `dir`. Compiled AJV
   *  validators are written as standalone CJS modules keyed by content
   *  hash, so subsequent process invocations skip the ≈2–10 ms AJV
   *  codegen for each unseen schema. Safe to call before or after
   *  `compile()` — already-compiled in-memory entries are unaffected.
   *  The caller is responsible for choosing a writable directory; the
   *  kernel anchors this under `<entry-dir>/.telo/manifests/__validators/`
   *  so it lives next to the manifest cache and rides along in
   *  `COPY --from=build /srv /srv` Docker images. */
  setCacheDir(dir: string | undefined): void {
    this.cacheDir = dir;
  }

  compile(schema: any): DataValidator {
    if (schema && typeof schema === "object") {
      const cached = this.compiledValidators.get(schema as object);
      if (cached) return cached;
    }

    const isFullSchema =
      ("type" in schema && typeof schema.type === "string") ||
      "allOf" in schema ||
      "anyOf" in schema ||
      "oneOf" in schema ||
      "$ref" in schema;
    const normalized = isFullSchema
      ? schema
      : {
          type: "object",
          properties: schema,
          required: Object.keys(schema),
          additionalProperties: false,
        };
    const withImplicit =
      normalized.additionalProperties === false
        ? {
            ...normalized,
            properties: {
              kind: { type: "string" },
              metadata: { type: "object" },
              ...normalized.properties,
            },
          }
        : normalized;

    // Drop the legacy scalar `type` an older published module may still pin on
    // its `x-telo-ref` slots. Schema validation runs in create() before Phase 5
    // injection, so a ref slot holds the resolved `{kind, name, alias?}` object
    // (or an unresolved sentinel) — both objects the stale `type: "string"`
    // would otherwise reject.
    const injected = normalizeRefSlots(withImplicit) as typeof withImplicit;

    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          runtime: VALIDATOR_RUNTIME_TAG,
          schema: normalizeSentinelsForHash(injected),
        }),
      )
      .digest("hex")
      .slice(0, 32);
    const cachedByHash = this.hashCache.get(hash);
    if (cachedByHash) {
      if (schema && typeof schema === "object") {
        this.compiledValidators.set(schema as object, cachedByHash);
      }
      return cachedByHash;
    }

    const validate = this.compileAjvOrLoadCached(injected, hash);

    const validator = {
      validate: (data: any) => {
        const isValid = validate(data);
        if (!isValid) {
          throw new RuntimeError(
            "ERR_RESOURCE_SCHEMA_VALIDATION_FAILED",
            `Invalid value passed: ${JSON.stringify(data)}. Error: ${formatAjvErrors(validate.errors)}`,
          );
        }
      },
      isValid: (data: any) => {
        return validate(data);
      },
    };

    this.hashCache.set(hash, validator);
    if (schema && typeof schema === "object") {
      this.compiledValidators.set(schema as object, validator);
    }

    return validator;
  }

  /** Load `<cacheDir>/<hash>.cjs` if present, else compile via AJV and
   *  persist as standalone CJS. Cached files start with a
   *  `// sha256:<hex>\n` header covering the rest of the file; a
   *  mismatch (truncated write, FS corruption, tampering inside a baked
   *  Docker image) is treated as a cache miss and the validator is
   *  recompiled — and overwritten — so the cache self-heals. The cached
   *  body is wrapped so its embedded `require("ajv/...")` /
   *  `require("ajv-formats/...")` calls resolve against the kernel
   *  package; the cache file lives outside any `node_modules` tree, so a
   *  bare `require()` from its own path would fail. Read/write failures
   *  surface to stderr but never abort compilation. */
  private compileAjvOrLoadCached(
    schema: any,
    hash: string,
  ): ValidateFunction {
    const cacheDir = this.cacheDir;
    if (cacheDir) {
      const cachePath = path.join(cacheDir, `${hash}.cjs`);
      try {
        const text = fs.readFileSync(cachePath, "utf-8");
        const body = verifyAndExtractBody(text);
        if (body !== null) {
          const factory = new Function(
            "require",
            "module",
            "exports",
            `${body}\nreturn module.exports;`,
          );
          const mod: { exports: any } = { exports: {} };
          const loaded = factory(kernelRequire, mod, mod.exports);
          if (typeof loaded === "function") {
            return loaded as ValidateFunction;
          }
        }
        // Header missing / mismatched / non-function export — fall
        // through and recompile. The write step below overwrites the
        // stale file with a fresh hash header.
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
          process.stderr.write(
            `[telo:kernel] validator cache load failed (${hash}): ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
    }

    const validate = this.ajv.compile(schema) as ValidateFunction;
    if (cacheDir) {
      try {
        const body = standaloneCode(this.ajv, validate);
        const integrity = createHash("sha256").update(body).digest("hex");
        const payload = `// sha256:${integrity}\n${body}`;
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(path.join(cacheDir, `${hash}.cjs`), payload, "utf-8");
      } catch (err) {
        process.stderr.write(
          `[telo:kernel] validator cache write failed (${hash}): ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
    return validate;
  }

  composeWithRules(base: DataValidator, typeName: string, rules: TypeRule[]): DataValidator {
    return {
      validate: (data: any) => {
        base.validate(data);
        for (const rule of rules) {
          let result: unknown;
          try {
            result = evaluate(rule.condition, { this: data });
          } catch (err) {
            throw new RuntimeError(
              "ERR_TYPE_VALIDATION_FAILED",
              `Type "${typeName}" rule evaluation failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          if (result !== true) {
            throw new RuntimeError(
              rule.code ?? "ERR_TYPE_VALIDATION_FAILED",
              rule.message ?? `Type "${typeName}" validation failed: rule "${rule.code}" not satisfied`,
            );
          }
        }
      },
      isValid: (data: any) => {
        if (!base.isValid(data)) return false;
        for (const rule of rules) {
          try {
            if (evaluate(rule.condition, { this: data }) !== true) return false;
          } catch {
            return false;
          }
        }
        return true;
      },
    };
  }
}
