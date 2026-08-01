import { describeSelector, selectorFromQualifiers, selectorMatches } from "@telorun/analyzer";
import { ControllerInstance, RuntimeError } from "@telorun/sdk";
import { existsSync, readFileSync } from "fs";
import * as fs from "fs/promises";
import { createRequire } from "module";
import { PackageURL } from "packageurl-js";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { hostPlatformTarget, type ModuleArtifact } from "../bundle/module-artifact.js";
import type { ControllerResolveSource } from "../controller-loader.js";
import { ControllerEnvMissingError } from "./napi-loader.js";
import { REALM_COLLAPSE_NAMES } from "./realm.js";
import { buildControllerFromSource, canBuildFromSource } from "./source-bundle-builder.js";

/** A base URI whose files are already on disk: a `file://` URL or a bare
 *  absolute path. Everything else (`oci://`, `http(s)://`, `memory://`) names a
 *  module whose payload only exists inside an artifact. */
function isLocalBase(baseUri: string): boolean {
  return baseUri.startsWith("file://") || path.isAbsolute(baseUri);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * A bundled controller imports `@telorun/sdk` (and any realm-collapse sibling) as
 * a normal bare specifier, but it lives in a cache/extract dir with no
 * node_modules path to the SDK. Make those names resolve to the kernel's own copy
 * by symlinking them into a `node_modules/` next to the bundle — standard module
 * resolution then finds them on every runtime. (Node ESM resolve hooks aren't
 * honoured by Bun, and Bun's own plugins don't intercept runtime imports, so a
 * symlink is the one portable mechanism — verified on Node + Bun.) Authors write
 * a plain `import { Stream } from "@telorun/sdk"`; nothing special.
 *
 * Idempotent, cached per directory. On a read-only mount (k8s run) the link must
 * already exist from the extract phase; a failed create just leaves the import to
 * surface a normal module-not-found.
 */
const realmLinkedDirs = new Set<string>();
async function ensureRealmSymlinks(bundleDir: string): Promise<void> {
  if (realmLinkedDirs.has(bundleDir)) return;
  const req = createRequire(import.meta.url);
  for (const name of REALM_COLLAPSE_NAMES) {
    let pkgRoot: string | null = null;
    try {
      pkgRoot = findPackageRoot(req.resolve(name), name);
    } catch {
      // Kernel can't resolve this realm name — skip; the bundle's import then
      // fails normally rather than being silently misdirected.
    }
    if (!pkgRoot) continue;
    const linkPath = path.join(bundleDir, "node_modules", ...name.split("/"));
    // Reuse an existing link only when it already points at this kernel's copy. A
    // link a run in another environment left behind — e.g. the host symlink a
    // local run writes, then bind-mounts into a container where its target path is
    // absent — is dangling/wrong here; replace it rather than leaving the bundle's
    // import broken (`existsSync` follows the link, so it can't tell the two
    // apart). A real file/dir in the slot is left untouched.
    let stale = false;
    try {
      const stat = await fs.lstat(linkPath);
      if (stat.isSymbolicLink()) {
        const target = await fs.readlink(linkPath);
        if (path.resolve(path.dirname(linkPath), target) === path.resolve(pkgRoot)) continue;
        stale = true;
      } else {
        continue;
      }
    } catch {
      // Nothing at linkPath — fall through to create it.
    }
    try {
      if (stale) await fs.rm(linkPath, { force: true });
      await fs.mkdir(path.dirname(linkPath), { recursive: true });
      await fs.symlink(pkgRoot, linkPath, process.platform === "win32" ? "junction" : "dir");
    } catch {
      // EEXIST race or read-only FS — fine if it now resolves; otherwise the
      // import surfaces the resolution failure.
    }
  }
  realmLinkedDirs.add(bundleDir);
}

/**
 * Walk up from a resolved entry file to the directory whose package.json `name`
 * matches — the package root to symlink (so the symlinked package.json `exports`
 * drive per-runtime entry selection, e.g. Bun `src` vs Node `dist`).
 */
function findPackageRoot(entryFile: string, name: string): string | null {
  let dir = path.dirname(entryFile);
  for (let i = 0; i < 24; i++) {
    const pj = path.join(dir, "package.json");
    if (existsSync(pj)) {
      try {
        if ((JSON.parse(readFileSync(pj, "utf8")) as { name?: string }).name === name) return dir;
      } catch {
        // unreadable / invalid package.json — keep walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Loads a `pkg:telo` controller — a controller delivered inside the module's own
 * bundle (the Telo registry artifact), not fetched from an external package
 * registry. Every PURL segment carries meaning:
 *
 *   pkg:telo / local / <format> ? path=./nodejs/x.mjs # export
 *      type     ns       name          qualifier        subpath
 *
 *  - `type=telo` — Telo-delivered (not npm/cargo).
 *  - `namespace=local` — the delivery sub-mode: bundled in the module artifact.
 *    Reserves `pkg:telo/registry/…` for a future "controller fetched from the
 *    Telo registry as its own artifact". A non-`local` namespace → env-missing
 *    here (a different mode another branch/kernel would handle).
 *  - `name=<format>` — the artifact format the loader dispatches on (`js` /
 *    `napi` / `wasm`). Bundling is the one delivery not tied to an ecosystem's
 *    runtime (npm ⇒ JS, cargo ⇒ Rust; a bundle is just files), so the format is
 *    explicit. `js` is `import()`ed directly; a format this kernel can't host →
 *    `ControllerEnvMissingError`, so `[pkg:telo/local/napi …, pkg:telo/local/js …]`
 *    (or `[pkg:telo …, pkg:npm …]`) falls through to a candidate this — or
 *    another runtime's — kernel can load.
 *  - `path` — the file in the bundle; `#export` — the named export.
 *  - `local_path` — the TypeScript source `path=` was built from. Present only
 *    while the module is a working copy; a published artifact ships no `src/`.
 *    When the module arrives with **no artifact handle** and the source resolves
 *    on disk, the loader builds it (see `source-bundle-builder.ts`) rather than
 *    importing `path=`, so editing a controller and re-running picks the edit up
 *    with no build step. The guard is the absence of an artifact, not the shape
 *    of the base URI: a published module served from the on-disk manifest cache
 *    has a local base too, and its payload is the layer regardless.
 *

 * Two separate concerns for `js` bundles importing `@telorun/sdk`:
 *  - *Resolution* — the bare specifier must point at a real file. The bundle has
 *    no node_modules, so `ensureRealmSymlinks()` symlinks the realm-collapse
 *    names into a `node_modules/` next to the bundle, pointing at the kernel's
 *    own copy; standard resolution then finds them on both Node and Bun. Authors
 *    write a normal `import { Stream } from "@telorun/sdk"`; nothing special.
 *  - *Identity* — once resolved to the kernel's copy it's the same module, so
 *    `Stream`/`InvokeError` are trivially identical. (The SDK's globalThis/Symbol
 *    singletons also keep identity correct even when a publish step inlines the
 *    SDK into the bundle instead of leaving it external.)
 *
 * A missing/remote/unparseable bundle is `ControllerEnvMissingError` (fall
 * through); a bundle that loads but is malformed is a hard `ERR_CONTROLLER_INVALID`.
 */
export class BundleControllerLoader {
  /** Where a dev build from `local_path` is cached (`<cache-root>/controller-src`).
   *  Absent for callers that resolved no cache root, which simply disables the
   *  source path — a prebuilt `path=` still loads. */
  constructor(private readonly cacheRoot?: string) {}

  async load(
    purl: string,
    baseUri: string,
    artifact?: ModuleArtifact,
  ): Promise<{ instance: ControllerInstance; source: ControllerResolveSource }> {
    const { source, importInstance } = await this.resolve(purl, baseUri, artifact);
    return { instance: await importInstance(), source };
  }

  /**
   * Resolve without importing: parse + validate the PURL, reject a candidate this
   * host cannot run, materialize the layer that carries it, confirm the file
   * exists, and ensure the realm symlinks — all fail-fast checks — but defer the
   * bundle `import()` (the eval cost) into the returned `importInstance` thunk.
   * Used by lazy controller loading.
   */
  async resolve(
    purl: string,
    baseUri: string,
    artifact?: ModuleArtifact,
  ): Promise<{ source: ControllerResolveSource; importInstance: () => Promise<ControllerInstance> }> {
    let parsed: PackageURL;
    try {
      parsed = PackageURL.fromString(purl);
    } catch (err) {
      throw new ControllerEnvMissingError(
        `Unparseable pkg:telo PURL "${purl}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Delivery sub-mode lives in the namespace; this loader handles bundled
    // (`local`) controllers. Anything else (e.g. a future `registry` mode) is
    // env-missing so the candidate list falls through.
    if (parsed.namespace !== "local") {
      throw new ControllerEnvMissingError(
        `pkg:telo controller "${purl}" must use the "local" namespace (pkg:telo/local/<format>); got "${parsed.namespace ?? "(none)"}"`,
      );
    }

    // Format is the PURL name. Only `js` is hostable by the Node kernel today;
    // any other format (napi/wasm/future) is env-missing so the list falls
    // through to a sibling this — or another runtime's — kernel can load.
    const format = parsed.name;
    if (format !== "js") {
      throw new ControllerEnvMissingError(
        `pkg:telo controller "${purl}": format "${format}" is not hostable by the Node bundle loader (supports "js" today)`,
      );
    }

    const relPath = parsed.qualifiers?.path;
    if (!relPath) {
      throw new ControllerEnvMissingError(
        `pkg:telo controller "${purl}" is missing a "path" qualifier`,
      );
    }

    // Platform gate, BEFORE any materialization. A candidate list names one
    // binary per platform, so checking the host first is what keeps a fallthrough
    // from downloading every platform's layer on the way to the right one.
    const selector = selectorFromQualifiers(format, parsed.qualifiers, `controller "${purl}"`);
    const host = hostPlatformTarget();
    if (!selectorMatches(selector, host)) {
      throw new ControllerEnvMissingError(
        `pkg:telo controller "${purl}" targets ${describeSelector(selector)}, which does not ` +
          `match this host (${host.os ?? "unknown os"}/${host.arch ?? "unknown arch"}` +
          `${host.libc ? `/${host.libc}` : ""})`,
      );
    }

    const fragment = parsed.subpath;

    // Dev path: a module that is a working copy — no artifact behind it — with a
    // `local_path` source on disk is built from that source, because the source
    // is what is authoritative there. An artifact means the payload IS the layer,
    // so this never fires for a published module, including one served from the
    // on-disk manifest cache (whose base is local but whose payload is a layer).
    //
    // esbuild is probed HERE rather than inside the build. It is an optional
    // dependency so that an install skipping optionals still runs published
    // artifacts — and a working copy that has run its build script has the same
    // prebuilt file on disk. Deciding it lazily would turn "no bundler" into a
    // hard failure standing next to a perfectly good bundle, and the candidate
    // list could not rescue it: the fallback belongs to this same PURL, not to a
    // sibling candidate.
    const cacheRoot = this.cacheRoot;
    const sourceFile = artifact ? undefined : this.localSourceFile(parsed, baseUri);
    const buildFromSource =
      sourceFile !== undefined &&
      cacheRoot !== undefined &&
      (await pathExists(sourceFile)) &&
      (await canBuildFromSource());
    if (buildFromSource) {
      // The same file the prebuilt branch would import, kept as the fallback for
      // an environment that stops being able to build between resolve and first
      // instantiation.
      const prebuilt = path.resolve(this.moduleDir(baseUri), relPath);
      return {
        source: "local",
        // Deferred like every other branch: the build is paid on the kind's
        // first instantiation, so a manifest pays only for the kinds it uses.
        // A build FAILURE is user code and propagates unchanged; only a missing
        // *environment* falls back, and only to a file that is actually there.
        importInstance: async () => {
          let built: string;
          try {
            built = await buildControllerFromSource(sourceFile!, cacheRoot!);
          } catch (err) {
            if (!(err instanceof ControllerEnvMissingError)) throw err;
            if (!(await pathExists(prebuilt))) throw err;
            await ensureRealmSymlinks(path.dirname(prebuilt));
            return importControllerModule(prebuilt, purl, fragment);
          }
          await ensureRealmSymlinks(path.dirname(built));
          return importControllerModule(built, purl, fragment);
        },
      };
    }

    // A published module's payload lives in its artifact, so materialize the one
    // layer carrying this candidate and resolve `path=` inside it. Nothing is
    // fetched here: the artifact handle owns the pinned ref and the verified
    // layer index, so an `oci://` module ref never reaches this loader as a path.
    let bundleDir: string;
    // What this resolve actually cost. A module already on disk is `local`; an
    // artifact layer found extracted is `cache`; only a layer this call pulled
    // down reports `bundle`, the branch that made the user wait.
    let source: ControllerResolveSource = "local";
    if (artifact) {
      // By its own selector, not by re-matching the host: this candidate IS one
      // selector, and it is exactly the key of the layer that carries it.
      const resolved = await artifact.materializeController(selector);
      if (!resolved) {
        throw new ControllerEnvMissingError(
          `pkg:telo controller "${purl}": the module artifact ships no layer for ` +
            `${describeSelector(selector)} (has: ${artifact.describeLayers()})`,
        );
      }
      bundleDir = resolved.layer.dir;
      source = resolved.transferred ? "bundle" : "cache";
    } else {
      // No artifact: a module already on disk (local development, or a manifest
      // served from the on-disk cache). Its files sit next to the manifest.
      if (!isLocalBase(baseUri)) {
        throw new ControllerEnvMissingError(
          `pkg:telo controller "${purl}" cannot be located: the declaring module resolved from ` +
            `"${baseUri}", which is neither a local path nor an artifact with a layer index. ` +
            `A bundled controller ships in its module's artifact — republish the module, or ` +
            `import it from a local path during development.`,
        );
      }
      bundleDir = path.dirname(baseUri.startsWith("file://") ? fileURLToPath(baseUri) : baseUri);
    }

    const absFile = path.resolve(bundleDir, relPath);
    if (!(await pathExists(absFile))) {
      throw new ControllerEnvMissingError(
        `pkg:telo controller bundle not found at "${absFile}" (from "${purl}")`,
      );
    }

    // Make bare `@telorun/sdk` (etc.) resolve to the kernel's copy before
    // importing the bundle, so authors write normal imports.
    await ensureRealmSymlinks(path.dirname(absFile));

    return {
      source,
      importInstance: () => importControllerModule(absFile, purl, fragment),
    };
  }

  /** The `local_path` source this candidate names, resolved against the declaring
   *  module's directory — or `undefined` when the candidate declares none, or the
   *  module is not on disk to resolve it against. */
  private localSourceFile(parsed: PackageURL, baseUri: string): string | undefined {
    const localPath = parsed.qualifiers?.local_path;
    if (!localPath || !isLocalBase(baseUri)) return undefined;
    return path.resolve(this.moduleDir(baseUri), localPath);
  }

  /** Directory of the declaring module's manifest. Only meaningful for a local
   *  base; callers gate on {@link isLocalBase} first. */
  private moduleDir(baseUri: string): string {
    return path.dirname(baseUri.startsWith("file://") ? fileURLToPath(baseUri) : baseUri);
  }
}

/** Import a built bundle and project out the controller the fragment names. A
 *  broken bundle (syntax error, failed import) is a real user-code failure and
 *  propagates; it is never masked as env-missing. */
async function importControllerModule(
  absFile: string,
  purl: string,
  fragment: string | undefined,
): Promise<ControllerInstance> {
  const mod = (await import(pathToFileURL(absFile).href)) as Record<string, ControllerInstance>;
  // Distinguish "no such export" from "export isn't a controller" so the error
  // points at the actual problem (mirrors the napi loader's project()).
  if (fragment && !(fragment in mod)) {
    throw new RuntimeError(
      "ERR_CONTROLLER_INVALID",
      `Bundled controller "${purl}": module "${absFile}" has no export named "${fragment}"`,
    );
  }
  const instance = fragment ? mod[fragment] : (mod as unknown as ControllerInstance);
  if (!instance || (!instance.create && !instance.register)) {
    throw new RuntimeError(
      "ERR_CONTROLLER_INVALID",
      `Bundled controller "${purl}" exports neither create() nor register()` +
        (fragment ? ` at fragment "#${fragment}"` : ""),
    );
  }
  return instance;
}
