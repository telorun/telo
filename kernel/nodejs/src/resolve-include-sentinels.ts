import { readFile, stat } from "fs/promises";
import { fileURLToPath } from "url";
import { RuntimeError, type ResourceManifest } from "@telorun/sdk";
import {
  INCLUDE_BYTES_ENGINE,
  isIncludeSentinel,
  isTaggedSentinel,
  normalizeIncludePath,
  type TaggedSentinel,
} from "@telorun/templating";
import { resolveModuleFileUri, type ModuleArtifactLookup } from "./module-file-resolution.js";

/**
 * Ceiling on one embedded file.
 *
 * A resolved embed is an ordinary manifest value, retained for as long as the
 * resource holding it, so there is no point at which a large one is released.
 * Streaming a payload is a different primitive with a different lifetime, which
 * is what the error points at.
 */
export const MAX_INCLUDE_BYTES = 32 * 1024 * 1024;

/** Reads keyed by resolved URI. Two resources embedding the same font read it
 *  once — the values are retained by those resources anyway, so the cache adds
 *  deduplication rather than retention. */
export type IncludeCache = Map<string, Uint8Array>;

/** Manifest objects already walked. Keyed by identity and weakly held, so this
 *  is a gate on repeated work rather than a lifetime extension. */
const resolved = new WeakSet<object>();

async function readIncluded(
  uri: string,
  displayPath: string,
  cache: IncludeCache,
): Promise<Uint8Array> {
  const cached = cache.get(uri);
  if (cached) return cached;

  if (!uri.startsWith("file:")) {
    throw new RuntimeError(
      "ERR_INCLUDE_UNREADABLE",
      `Cannot embed '${displayPath}': it resolved to '${uri}', which this runtime cannot read ` +
        `as a file. An embedded file must ship inside the module's own artifact.`,
    );
  }
  const filePath = fileURLToPath(uri);

  // Size is checked before reading, so an oversized file is reported rather
  // than loaded to discover it was too big.
  let size: number;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      throw new RuntimeError(
        "ERR_INCLUDE_UNREADABLE",
        `Cannot embed '${displayPath}': '${filePath}' is not a file.`,
      );
    }
    size = info.size;
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError(
      "ERR_INCLUDE_FILE_NOT_FOUND",
      `Cannot embed '${displayPath}': no such file at '${filePath}'. The path is relative to ` +
        `the module root — the directory holding telo.yaml — not to the file the tag was ` +
        `written in.`,
    );
  }
  if (size > MAX_INCLUDE_BYTES) {
    // Megabytes, not raw bytes: the limit is a round number chosen for a human,
    // and this message is aimed at one.
    const mb = (n: number) => `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`;
    throw new RuntimeError(
      "ERR_INCLUDE_FILE_TOO_LARGE",
      `Cannot embed '${displayPath}': it is ${mb(size)}, over the ${mb(MAX_INCLUDE_BYTES)} ` +
        `limit for a file embedded into a manifest value. Read it at runtime with Fs.File ` +
        `instead, which does not retain it for the life of the resource.`,
    );
  }

  const bytes = new Uint8Array(await readFile(filePath));
  cache.set(uri, bytes);
  return bytes;
}

async function resolveSentinel(
  sentinel: TaggedSentinel,
  moduleSource: string,
  lookup: ModuleArtifactLookup,
  cache: IncludeCache,
): Promise<string | Uint8Array> {
  // Re-checked here rather than trusted from `telo check`: the kernel does not
  // require that check to have run, and confinement is the one property whose
  // absence is a security question rather than a broken build.
  const { path: relative, diagnostic } = normalizeIncludePath(sentinel.source);
  if (!relative) {
    throw new RuntimeError(
      "ERR_INCLUDE_PATH_INVALID",
      `Invalid \`!${sentinel.engine}\` path: ${diagnostic?.message ?? "not a module-relative path."}`,
    );
  }

  const uri = await resolveModuleFileUri(relative, moduleSource, lookup);
  const bytes = await readIncluded(uri, relative, cache);
  if (sentinel.engine === INCLUDE_BYTES_ENGINE) return bytes;
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/**
 * Replace every `!include-text` / `!include-bytes` sentinel in a resource's
 * config with the file's contents, in place.
 *
 * Called at resource creation — the kernel's single instance-production site —
 * and NOT during manifest load. The artifact spec gives `telo.yaml` a layer of
 * its own precisely so that reading a manifest cannot pull the whole artifact;
 * resolving at load would defeat that just as thoroughly, because loading an app
 * loads every imported library's manifest and would fetch every library's assets
 * layer whether or not anything used it. Resolving here bounds the cost to
 * modules whose resources actually instantiate, and a `with:`-scoped resource
 * pays only when its scope runs.
 *
 * It runs BEFORE the resource's schema validation, so a resolved value is what
 * the schema sees: bytes reach an `x-telo-binary` slot as the `Uint8Array` that
 * annotation demands, and an unresolved marker never reaches a controller.
 *
 * In place, like `resolveRefSentinels` — which also makes it idempotent, so a
 * scoped resource created once per scope run reads its files once.
 */
export async function resolveIncludeSentinels(
  resource: ResourceManifest,
  moduleSource: string,
  lookup: ModuleArtifactLookup,
  cache: IncludeCache,
): Promise<void> {
  // A resource that defers across init passes reaches `create()` more than once,
  // and a `with:`-scoped one is created per scope run — the walk is idempotent
  // either way, so repeating it is pure cost on the init loop. One walk per
  // manifest object is enough: resolution rewrites it in place.
  if (resolved.has(resource)) return;

  const pending: Array<Promise<void>> = [];

  /** A nested resource DECLARATION — an inline `{ kind, … }`, whether it sits in
   *  a `with:` scope or in a step's `invoke:`. Its embeds belong to it, not to
   *  the resource that encloses it, and it reaches `create()` in its own right.
   *  Phase-5 injection draws the same line for `!ref`s inside a scope. */
  const isNestedDeclaration = (value: unknown): boolean =>
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { kind?: unknown }).kind === "string";

  const take = (item: unknown, assign: (resolved: string | Uint8Array) => void): void => {
    if (isIncludeSentinel(item)) {
      pending.push(resolveSentinel(item, moduleSource, lookup, cache).then(assign));
      return;
    }
    // Another engine's sentinel is opaque; a nested declaration is resolved when
    // that resource is created, which is what keeps a scoped resource's files
    // unread until its scope actually runs.
    if (!isTaggedSentinel(item) && !isNestedDeclaration(item)) walk(item);
  };

  const walk = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    // A compiled CEL node is opaque and carries no sentinels of its own.
    if ((value as { __compiled?: unknown }).__compiled) return;
    // Only PLAIN containers are descended into. A template kind expands
    // `${{ self.connection }}` to a LIVE ResourceInstance, whose object graph
    // reaches back into contexts and the kernel and contains cycles — walking it
    // overflows the stack, and nothing in it could be a manifest value anyway.
    // Same rule `compileWalker` and `precompileDoc` follow.
    if (!Array.isArray(value)) {
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const index = i;
        take(value[index], (resolved) => {
          value[index] = resolved;
        });
      }
      return;
    }
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      take(obj[key], (resolved) => {
        obj[key] = resolved;
      });
    }
  };

  // The resource being created is itself a `{ kind, … }` declaration, so the walk
  // starts INSIDE it rather than at it — only the ones nested below are deferred.
  walk(resource as Record<string, unknown>);
  // Reads run concurrently and every failure surfaces: one unreadable file must
  // not be hidden by another failing first.
  const settled = await Promise.allSettled(pending);
  const failures = settled.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
  resolved.add(resource);
  if (failures.length === 0) return;
  // The FIRST failure is rethrown, carrying its own code and its own cause.
  // Wrapping several into one generic error made the reported code depend on how
  // many files happened to fail — two missing files became ERR_INCLUDE_UNREADABLE
  // rather than ERR_INCLUDE_FILE_NOT_FOUND — so a caller matching on the code was
  // misled by an artefact of the batch, and the individual errors were flattened
  // into a string nothing could branch on. The rest are attached as `causes`, and
  // named in the message so none is hidden.
  const [first, ...rest] = failures as Error[];
  if (rest.length > 0 && first instanceof RuntimeError) {
    (first as RuntimeError & { causes?: unknown[] }).causes = rest;
    first.message += ` (${rest.length} more embed${rest.length === 1 ? "" : "s"} also failed: ${rest
      .map((f) => f.message)
      .join("; ")})`;
  }
  throw first;
}
