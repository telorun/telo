import { DataValidator, isCompiledValue, NOOP_LOGGER, RuntimeError, TypeRule, type Logger } from "@telorun/sdk";
import AjvModule, { type ValidateFunction } from "ajv";
import standaloneCodeMod from "ajv/dist/standalone/index.js";
import addFormats from "ajv-formats";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import {
  ManifestRootSchema,
  registerTeloKeywords,
  schemaIssues,
  schemaWithTagsAsText,
  TELO_FORMATS,
  VALUE_TYPE_KEYWORD_VERSION,
  type SchemaIssue,
  type TeloFormatEntry,
} from "@telorun/analyzer";
import { CEL_SCALAR_FORMS, PLAIN_ENCODINGS, VALUE_TYPES, X_TELO_TYPE } from "@telorun/sdk";
import { bigIntView, mergeFilledDefaults } from "./bigint-schema-view.js";
import { realmRequire } from "./controller-loaders/realm.js";
import { readVersion, reportUndeterminableVersion } from "./runtime-versions.js";
import { formatAjvErrors } from "./manifest-schemas.js";
import { ruleCondition, stampRuleCallNames } from "./type-rule-condition.js";

/** Render a value for an error message without ever throwing — the offending
 *  data may be cyclic, and a throw here would REPLACE the validation failure
 *  with an unrelated error naming no field. */
export function describeValue(data: unknown): string {
  try {
    return JSON.stringify(data) ?? String(data);
  } catch {
    return String(data);
  }
}

/** A value its schema refuses, carrying the reduced, path-anchored issues the
 *  message was rendered from — so a caller answering someone outside Telo (an
 *  HTTP 400) can say where, not only what. */
export class SchemaValidationError extends RuntimeError {
  constructor(
    message: string,
    readonly issues: SchemaIssue[],
  ) {
    super("ERR_RESOURCE_SCHEMA_VALIDATION_FAILED", message);
  }
}
import {
  isTaggedSentinel,
} from "@telorun/templating";

const Ajv = AjvModule.default ?? AjvModule;
// AJV's standalone subpath is CJS — the default export shows up as either
// the function itself or `.default` depending on how the bundler/loader
// rewrites it. Normalise once.
const standaloneCode: (...args: any[]) => string =
  (standaloneCodeMod as any).default ?? (standaloneCodeMod as any);

/** How a standalone-compiled validator, read back off disk, gets the
 *  `ajv/dist/runtime/...` and `ajv-formats/...` modules it names.
 *
 *  The realm answers first, handing back the instances this kernel is already
 *  validating with — which is what makes a cached validator loadable where the
 *  kernel has no `node_modules` beside it to resolve through, a single-file
 *  executable above all. `createRequire` stays as the fallback for anything the
 *  realm does not carry, anchored at this file so it resolves through the kernel
 *  package rather than from wherever the cache file happens to live. */
const kernelRequire = createRequire(import.meta.url);
const cacheRequire = (specifier: string): unknown =>
  realmRequire(specifier) ?? kernelRequire(specifier);

/** Resolved AJV + ajv-formats versions, baked into every cache key so a
 *  pnpm/npm install that upgrades either package invalidates all stale
 *  `<hash>.cjs` files automatically. Standalone-compiled validators
 *  embed `require("ajv/dist/runtime/...")` — running a validator built
 *  against an older AJV against the current runtime is undefined
 *  behaviour, so the version pin must be part of the hash, not a manual
 *  bump.
 *
 *  Undeterminable is NOT a version: keyed on a placeholder, a validator built
 *  by one ajv is handed to another. So the disk cache is disabled instead
 *  (`validatorCacheKeyable`), which costs a compile per schema per run and
 *  cannot serve the wrong code. */
const AJV_VERSION = readVersion("ajv");
const AJV_FORMATS_VERSION = readVersion("ajv-formats");

/** The `x-telo-type` keyword emits code and messages from the value-type
 *  vocabulary, its codecs and its scalar ranges, so a cached validator built
 *  against another vocabulary would assert the wrong thing — or nothing. */
const VALUE_TYPE_DIGEST = createHash("sha256")
  .update(
    JSON.stringify({
      keyword: VALUE_TYPE_KEYWORD_VERSION,
      entries: [...VALUE_TYPES.values()],
      encodings: Object.entries(PLAIN_ENCODINGS).map(([name, codec]) => [name, codec.form]),
      scalars: Object.entries(CEL_SCALAR_FORMS).map(([name, row]) => [name, row.form, row.range?.describe]),
    }),
  )
  .digest("hex")
  .slice(0, 16);
/** The Telo format vocabulary decides which `format:` values a compiled
 *  validator checks at all — a name unknown when it was compiled is skipped —
 *  so a validator cached against another vocabulary may check nothing. */
export function formatVocabularyDigest(entries: readonly TeloFormatEntry[]): string {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex").slice(0, 16);
}
const VALIDATOR_RUNTIME_TAG =
  `ajv@${AJV_VERSION}+ajv-formats@${AJV_FORMATS_VERSION}+value-types@${VALUE_TYPE_DIGEST}` +
  `+formats@${formatVocabularyDigest([...TELO_FORMATS.values()])}`;

/** Whether a compiled validator may be persisted or read back at all. */
function validatorCacheKeyable(report: (message: string) => void): boolean {
  if (AJV_VERSION && AJV_FORMATS_VERSION) return true;
  reportUndeterminableVersion("validator", ["ajv", "ajv-formats"], report);
  return false;
}

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

/** Schema keywords whose VALUE is a map keyed by author-chosen names rather
 *  than by keyword. A name may legitimately be `x-telo-…`, so the strip below
 *  must not treat a key in one of these maps as an annotation. */
const NAME_KEYED_SCHEMA_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  "dependentRequired",
  "$defs",
  "definitions",
]);

/** Schema keywords whose value is DATA, not a subschema. The strip must not
 *  descend into them at all: an `x-telo-…` key inside a `const` / `default` /
 *  `enum` member is part of the value being matched or filled, so removing it
 *  would change what the validator accepts and what it writes — and would make
 *  two schemas that differ only there hash alike. */
const DATA_VALUE_KEYWORDS = new Set(["const", "default", "enum", "examples"]);

/** Annotations that DO emit validation code, and so must survive the strip and stay
 *  in the cache key. `x-telo-type` is the only one: bytes have no JSON Schema type,
 *  so the keyword is the only thing standing between a byte slot and "accepts any
 *  object". Stripping it would silently reduce the slot to an empty schema — the
 *  precise regression the annotation was introduced to close — and, because the key
 *  is meant to describe the compiled validator, a keyword that changes the validator
 *  belongs in it.
 *
 *  Its names need no canonicalization to be safe in a key, unlike `x-telo-ref`'s:
 *  the vocabulary is closed and `Telo.`-qualified, so an author writes the
 *  canonical name or none, and a named SHAPE reaches the annotation as a `$ref`
 *  the loader already resolved. There is nothing here that the analyzer's baked
 *  view and the runtime could spell differently. */
const VALIDATING_ANNOTATIONS = new Set([X_TELO_TYPE]);

/** Deep-clone `schema` without its `x-telo-*` annotations — applied, like
 *  `schemaWithTagsAsText` (`@telorun/analyzer`), before both AJV compilation and cache
 *  hashing.
 *
 *  Almost every `x-telo-*` keyword is analyzer/editor metadata: AJV runs `strict:
 *  false` and registers the known ones as no-op keywords, so they emit no
 *  validation code. {@link VALIDATING_ANNOTATIONS} is the exception and is kept —
 *  see the note there. Leaving the rest in the hashed form makes the
 *  cache key sensitive to differences that cannot change what the validator
 *  does — and one such difference is real and systematic. The analyzer rewrites
 *  `x-telo-ref.kind` to its canonical `<module>.<Kind>` in the declaring scope
 *  (`resolveSchemaRefKinds`), and `telo install`'s warm pass bakes THAT view;
 *  the kernel's controller registry never runs the rewrite, so at runtime the
 *  same kind's schema still reads `Self.Connection`. Two keys, one validator:
 *  every kind whose schema declares an alias-qualified ref missed the baked
 *  cache on every boot and tried to rewrite it — the EACCES noise on a
 *  read-only image.
 *
 *  Stripping is what makes the key describe the compiled validator and nothing
 *  else, so the two views converge without either side having to agree on an
 *  annotation's spelling. */
function stripTeloAnnotations(value: unknown, nameKeyed = false): unknown {
  // An array's items are schema nodes (`allOf`, tuple `items`), never names.
  if (Array.isArray(value)) return value.map((item) => stripTeloAnnotations(item));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!nameKeyed && k.startsWith("x-telo-") && !VALIDATING_ANNOTATIONS.has(k)) continue;
    // A data-bearing keyword's value is carried over verbatim; a name-keyed
    // map's VALUES are schema nodes again, so only its keys are exempt.
    out[k] =
      !nameKeyed && DATA_VALUE_KEYWORDS.has(k)
        ? v
        : stripTeloAnnotations(v, !nameKeyed && NAME_KEYED_SCHEMA_KEYWORDS.has(k));
  }
  return out;
}

export class SchemaValidator {
  private ajv: InstanceType<typeof Ajv>;
  private typeRules = new Map<string, TypeRule[]>();
  private rawSchemas = new Map<string, object>();
  private compiledValidators = new WeakMap<object, DataValidator>();
  private cacheDir: string | undefined;
  /** When false, the disk cache is read-only: compiled validators are still
   *  loaded from `cacheDir` but never written back. `telo run --no-cache-write`
   *  sets this so an ephemeral, read-only session rootfs validates in-memory
   *  without touching (or failing to write) the baked cache. */
  private cacheWritable = true;
  /** Tracks (schema-hash → in-memory compiled validator) so two distinct
   *  but content-equal schema objects share one compile across the kernel
   *  process — `compiledValidators` is keyed by object identity and would
   *  miss those cases. */
  private hashCache = new Map<string, DataValidator>();
  /** Hashes whose compile went through the disk layer. A `persist: false`
   *  compile populates `hashCache` too — a repeat within the process should
   *  still collapse — but must not be mistaken for a baked entry: returning it
   *  to a persisting caller would suppress that caller's write permanently, so
   *  content shared with a warmable schema would never reach the cache. Such a
   *  caller falls through and compiles again, this time with the disk layer. */
  private persistedHashes = new Set<string>();
  /** Where cache-failure diagnostics go. Injected rather than reached for
   *  globally: this class is constructed outside the kernel's stdio scope, and
   *  §13.1 forbids the kernel writing to `process.stderr` directly. Defaults to
   *  a no-op so a standalone construction (tests, tooling) stays silent. */
  private log: Logger = NOOP_LOGGER;

  /** Route cache diagnostics through the kernel's logger. */
  setLogger(log: Logger): void {
    this.log = log;
  }

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
    // One registration site for every Telo keyword: the annotations as no-ops
    // and `x-telo-type` as the one that actually checks. `x-telo-type` is defined
    // as codegen in the analyzer so it inlines into the standalone validators
    // compiled and cached below, rather than needing the implementation present
    // at load.
    registerTeloKeywords(this.ajv);
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

  /** `callNames` are the names the module declaring the rules resolves CEL calls
   *  through (see `type-rule-condition.ts`). */
  addTypeRules(name: string, rules: TypeRule[], callNames: ReadonlySet<string>): void {
    stampRuleCallNames(rules, callNames);
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
  setCacheDir(dir: string | undefined, opts?: { write?: boolean }): void {
    this.cacheDir = dir;
    this.cacheWritable = opts?.write ?? true;
  }

  /** Compile `schema` to a validator, reusing the in-memory and on-disk caches.
   *
   *  `persist: false` keeps the compile in memory only — no disk read, no disk
   *  write. It is for a schema the build-time warm cannot see: an author-written
   *  JSON Schema sitting in a RESOURCE field (`ctx.createSchemaValidator`),
   *  rather than a kind's config schema or an invocation contract. Those are
   *  baked by `precompileDefinitionSchemas`; a resource-field schema never was,
   *  so persisting it only ever produced a miss-then-write on every boot — the
   *  EACCES noise on a read-only image. Declining to own what it cannot warm is
   *  the cache being honest, not a capability given up: the in-memory layers
   *  still collapse a repeat compile within the process. */
  compile(schema: any, options?: { persist?: boolean }): DataValidator {
    if (schema && typeof schema === "object") {
      const cached = this.compiledValidators.get(schema as object);
      if (cached) return cached;
    }

    // A value type is a whole schema too: an instance has no JSON `type`, and no
    // property map can name a property `x-telo-type`.
    const isFullSchema =
      ("type" in schema && typeof schema.type === "string") ||
      "allOf" in schema ||
      "anyOf" in schema ||
      "oneOf" in schema ||
      "$ref" in schema ||
      X_TELO_TYPE in schema;
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

    const injected = withImplicit;

    // Canonicalize tagged carriers (an `!interpolate` in a `description`, a
    // `!cel` tag, …) to their bare source text so AJV can
    // meta-validate the schema it compiles, and so the raw (warm-pass) and
    // precompiled (runtime) views of one schema land on the same cache key. The
    // hashed and the compiled schema are this same canonical form. See
    // `schemaWithTagsAsText`.
    const sanitized = schemaWithTagsAsText(stripTeloAnnotations(injected));

    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          runtime: VALIDATOR_RUNTIME_TAG,
          schema: sanitized,
        }),
      )
      .digest("hex")
      .slice(0, 32);
    const persist = options?.persist ?? true;
    const cachedByHash = this.hashCache.get(hash);
    if (cachedByHash && (!persist || this.persistedHashes.has(hash))) {
      if (schema && typeof schema === "object") {
        this.compiledValidators.set(schema as object, cachedByHash);
      }
      return cachedByHash;
    }

    const validate = this.compileAjvOrLoadCached(sanitized, hash, persist);
    if (persist) this.persistedHashes.add(hash);

    // AJV's type check is `typeof data == "number"`, so a CEL integer — a BigInt —
    // is rejected at an `integer` slot no matter what the author writes. Check a
    // normalized VIEW instead and merge the `useDefaults` fills back, so the value
    // that reaches the controller keeps its 64-bit range. The view is the same
    // reference when there was nothing to normalize, which is what keeps the
    // BigInt-free path identical to a plain `validate(data)`; its context locates
    // the root, so a range check can tell a rendered wide integer from a written one.
    const check = (data: any): boolean => {
      const { view, context } = bigIntView(data);
      const ok = validate(view, context);
      if (ok && view !== data) mergeFilledDefaults(data, view);
      return ok;
    };

    const validator = {
      validate: (data: any) => {
        if (!check(data)) {
          // Reports `data`, not the normalized view: the view renders a wide
          // integer through a double, so the digits it prints for the offending
          // value would not be the ones the author wrote.
          throw new SchemaValidationError(
            `Invalid value passed: ${describeValue(data)}. Error: ${formatAjvErrors(validate.errors, data)}`,
            schemaIssues(validate.errors, data),
          );
        }
      },
      isValid: (data: any) => check(data),
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
   *  bare `require()` from its own path would fail.
   *
   *  **A miss and a failure are different outcomes.** An absent file, or one
   *  whose integrity header does not match, is an ordinary miss: rewriting it is
   *  the designed recovery, so it stays silent. A file that is present and
   *  intact and still cannot be LOADED means the cache is unusable in this
   *  environment — every entry will fail the same way — so it is reported with
   *  the path and the reason rather than logged per entry and lost in the noise.
   *  Neither outcome aborts compilation. */
  private compileAjvOrLoadCached(
    schema: any,
    hash: string,
    persist: boolean,
  ): ValidateFunction {
    // `persist: false` drops the whole disk layer — the read too, not just the
    // write. Nothing bakes these entries, so a lookup is an ENOENT probe whose
    // only possible hit is one this process wrote on an earlier run.
    const cacheDir =
      persist && validatorCacheKeyable((message) => this.log.error(message))
        ? this.cacheDir
        : undefined;
    if (cacheDir) {
      const cachePath = path.join(cacheDir, `${hash}.cjs`);
      let text: string | undefined;
      try {
        text = fs.readFileSync(cachePath, "utf-8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
          this.reportUnusableCache(cachePath, err);
        }
      }
      const body = text === undefined ? null : verifyAndExtractBody(text);
      // Header missing or mismatched: a truncated write or a tampered file. The
      // write step below overwrites it with a fresh hash header.
      if (body !== null) {
        try {
          const factory = new Function(
            "require",
            "module",
            "exports",
            `${body}\nreturn module.exports;`,
          );
          const mod: { exports: any } = { exports: {} };
          const loaded = factory(cacheRequire, mod, mod.exports);
          if (typeof loaded === "function") {
            return loaded as ValidateFunction;
          }
          this.reportUnusableCache(
            cachePath,
            new Error(`cached validator exported ${typeof loaded}, not a function`),
          );
        } catch (err) {
          this.reportUnusableCache(cachePath, err);
        }
      }
    }

    const validate = this.ajv.compile(schema) as ValidateFunction;
    if (cacheDir && this.cacheWritable) {
      try {
        const body = standaloneCode(this.ajv, validate);
        const integrity = createHash("sha256").update(body).digest("hex");
        const payload = `// sha256:${integrity}\n${body}`;
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(path.join(cacheDir, `${hash}.cjs`), payload, "utf-8");
      } catch (err) {
        this.log.warn(
          "validator cache write failed",
          { "telo.validator.hash": hash },
          { error: err },
        );
      }
    }
    return validate;
  }

  /** Say once that the validator cache cannot be read here, and why.
   *
   *  Once per process: the cause is a property of the installation — a missing
   *  ajv runtime, an unreadable directory — so one report per compiled schema
   *  would be the same sentence a hundred times, which is how a cache that never
   *  hit went unnoticed. */
  private reportedUnusableCache = false;
  private reportUnusableCache(cachePath: string, err: unknown): void {
    if (this.reportedUnusableCache) return;
    this.reportedUnusableCache = true;
    this.log.error(
      "compiled validator cache is unusable; every schema will be recompiled on every run",
      { "telo.validator.cache": cachePath },
      { error: err },
    );
  }

  composeWithRules(base: DataValidator, typeName: string, rules: TypeRule[]): DataValidator {
    return {
      validate: (data: any) => {
        base.validate(data);
        for (const rule of rules) {
          let result: unknown;
          try {
            result = ruleCondition(rule)(data);
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
            if (ruleCondition(rule)(data) !== true) return false;
          } catch {
            return false;
          }
        }
        return true;
      },
    };
  }
}
