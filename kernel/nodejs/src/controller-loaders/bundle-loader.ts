import { describeSelector, selectorFromQualifiers, selectorMatches } from "@telorun/analyzer";
import { ControllerInstance, RuntimeError, type Logger } from "@telorun/sdk";
import { existsSync, readFileSync } from "fs";
import * as fs from "fs/promises";
import { createRequire } from "module";
import { PackageURL } from "packageurl-js";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { hostPlatformTarget, type ModuleArtifact } from "../bundle/module-artifact.js";
import type { ControllerResolveSource, ControllerWorkReporter } from "../controller-loader.js";
import { ControllerEnvMissingError } from "./napi-loader.js";
import { REALM_COLLAPSE_NAMES } from "./realm.js";
import {
  buildControllerFromSource,
  canBuildFromSource,
  type SiblingLibrary,
} from "./source-bundle-builder.js";
import {
  NO_SIBLING_LIBRARIES,
  type ResolvedSiblingLibrary,
  type SiblingLibraryMap,
} from "./sibling-libraries.js";

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
  await linkRealmNames(bundleDir);
  realmLinkedDirs.add(bundleDir);
}

async function linkRealmNames(bundleDir: string): Promise<void> {
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
}

/**
 * Make each sibling module's declared specifier resolve, from this bundle, to
 * that module's own library entry point.
 *
 * The realm collapse above points a closed, kernel-owned name at the kernel's own
 * copy. This is the same move one step out: the name is declared by the library
 * (`library: [pkg:telo/local/js?…&specifier=@telorun/sql]`), and the copy comes
 * from that module's artifact rather than from the kernel. What it buys is the
 * same thing — resolution *and* identity — which here means one module scope for
 * `@telorun/sql` across its own six controllers and every dependent, instead of
 * one copy per bundle.
 *
 * A **synthesized package** rather than a symlink to the module's directory: a
 * published artifact ships files, not a `package.json`, so there is nothing to
 * link to that standard resolution would accept. The generated shim re-exports
 * the materialized entry by absolute URL, and every consumer's shim re-exports
 * the *same* file — Node keys its module registry by resolved URL, so the scope
 * stays single however many shims point at it.
 *
 * Written into `node_modules/` beside the bundle, which is per module for a
 * published artifact and per content-addressed build for a working copy, so two
 * dependents that legitimately resolve different versions of one library never
 * write over each other.
 *
 * **A slot something else owns is never written.** The bundle directory is not
 * always the loader's: the prebuilt-`path=` branch imports out of a working copy,
 * where `node_modules/@telorun/sql` is a package manager's symlink INTO the
 * library's own source tree — writing through it would replace that package's
 * real `package.json`. So a slot is written only when it is absent or carries the
 * marker this loader stamps, which is the posture `linkRealmNames` already takes
 * ("a real file/dir in the slot is left untouched"). A foreign package in the slot
 * already resolves the specifier to real code; what it costs is the single-scope
 * property, so it is reported rather than passed over in silence.
 */
const SHIM_MARKER = "x-telo-generated";

async function ensureLibraryShims(
  bundleDir: string,
  entries: ReadonlyArray<{ specifier: string; entryFile: string }>,
  cacheRoot: string | undefined,
  log?: Logger,
): Promise<void> {
  for (const { specifier, entryFile } of entries) {
    const dir = path.join(bundleDir, "node_modules", ...specifier.split("/"));
    if (!(await isWritableShimSlot(dir, cacheRoot))) {
      log?.debug("left an existing package in a sibling-library slot", {
        "telo.library.specifier": specifier,
        "telo.library.slot": dir,
        "telo.library.entry": entryFile,
      });
      continue;
    }
    const target = pathToFileURL(entryFile).href;
    await writeIfChanged(
      path.join(dir, "package.json"),
      `${JSON.stringify(
        {
          name: specifier,
          version: "0.0.0",
          type: "module",
          exports: { ".": "./index.mjs" },
          [SHIM_MARKER]: "sibling-library-shim",
        },
        null,
        2,
      )}\n`,
    );
    // `export *` and nothing else: these entry points export named bindings, and
    // a re-exported `default` that does not exist is a hard syntax-level error at
    // import rather than an absent binding.
    await writeIfChanged(path.join(dir, "index.mjs"), `export * from ${JSON.stringify(target)};\n`);
  }
}

/**
 * Whether this loader may write the shim slot at `dir`.
 *
 * **Location first.** Every legitimate write site is inside the loader's own
 * cache root — a bundle built from source lives under `<cache>/controller-src/`,
 * and a published module's layers extract under `<cache>/manifests/` — so a slot
 * there is ours whatever it currently holds. That is what keeps a shim written by
 * an earlier kernel version (before the marker existed, or with different
 * contents) updatable rather than mistaken for someone else's package.
 *
 * **Marker second**, for a slot outside the cache: the prebuilt-`path=` branch
 * imports out of a working copy, where `node_modules/@telorun/sql` is a package
 * manager's symlink straight into the sibling's own source tree. Reading the
 * `package.json` **through** whatever is there settles it — a symlink resolves to
 * the target's, which carries no marker — so one read covers both a link and a
 * real installed package without caring which it was.
 */
async function isWritableShimSlot(dir: string, cacheRoot: string | undefined): Promise<boolean> {
  if (cacheRoot) {
    const root = path.resolve(cacheRoot) + path.sep;
    if (path.resolve(dir).startsWith(root)) return true;
  }
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    return parsed[SHIM_MARKER] !== undefined;
  } catch {
    // Nothing readable there. A symlink with no package.json behind it is still
    // someone else's, so refuse that too rather than writing through it.
    try {
      return !(await fs.lstat(dir)).isSymbolicLink();
    } catch {
      return true;
    }
  }
}

/** Everything a bundle's directory needs before the bundle is imported: the
 *  kernel-owned realm names, and one shim per sibling library. */
async function prepareBundleDir(
  bundleDir: string,
  shims: ReadonlyArray<{ specifier: string; entryFile: string }>,
  cacheRoot: string | undefined,
  log?: Logger,
): Promise<void> {
  await ensureRealmSymlinks(bundleDir);
  await ensureLibraryShims(bundleDir, shims, cacheRoot, log);
}

/** The externals a build of `format` code takes from a sibling-library map: the
 *  specifier esbuild must not inline, and the source tree the post-build check
 *  proves was not reached by another route. A published sibling ships no sources,
 *  so it is externalized with no tree to check — there is nothing there to
 *  inline. */
function buildExternals(libraries: SiblingLibraryMap, format: string): SiblingLibrary[] {
  const out: SiblingLibrary[] = [];
  for (const library of libraries.values()) {
    if (library.selector.format !== format) continue;
    const sourceDir =
      library.moduleDir && library.localPath
        ? path.dirname(path.resolve(library.moduleDir, library.localPath))
        : undefined;
    out.push({ specifier: library.specifier, ...(sourceDir ? { sourceDir } : {}) });
  }
  return out;
}

/** Write a generated file only when its content would change, through a private
 *  temp file and an atomic rename — several kernels may populate one cache
 *  directory at once, and a reader must see a whole file or none. */
async function writeIfChanged(file: string, content: string): Promise<void> {
  try {
    if ((await fs.readFile(file, "utf8")) === content) return;
  } catch {
    // Absent or unreadable — write it.
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${shimCounter++}.tmp`;
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, file);
}

let shimCounter = 0;

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
  constructor(
    private readonly cacheRoot?: string,
    /** Reports what resolution had to leave alone — a sibling-library slot an
     *  installer already owns, which resolves but not to this module's own copy. */
    private readonly log?: Logger,
  ) {}

  async load(
    purl: string,
    baseUri: string,
    artifact?: ModuleArtifact,
    libraries: SiblingLibraryMap = NO_SIBLING_LIBRARIES,
  ): Promise<{ instance: ControllerInstance; source: ControllerResolveSource }> {
    const { source, importInstance } = await this.resolve(purl, baseUri, artifact, libraries);
    return { instance: await importInstance(), source };
  }

  /**
   * Resolve every sibling library this bundle imports to a file on disk, and
   * prepare the module scope each one will run in.
   *
   * Filtered to the candidate's own format: a `js` bundle imports the `js` entry
   * point, and a Rust crate of the same module — a different specifier entirely —
   * is not its business. The host platform gate is the same one the candidate
   * itself passed, since a library layer is selected exactly as a controller
   * layer is.
   */
  private async libraryEntries(
    libraries: SiblingLibraryMap,
    format: string,
    purl: string,
    seen: Set<string>,
  ): Promise<Array<{ specifier: string; entryFile: string }>> {
    const host = hostPlatformTarget();
    const out: Array<{ specifier: string; entryFile: string }> = [];
    for (const library of libraries.values()) {
      if (library.selector.format !== format) continue;
      if (!selectorMatches(library.selector, host)) continue;
      out.push({
        specifier: library.specifier,
        entryFile: await this.prepareLibrary(library, format, purl, seen),
      });
    }
    return out;
  }

  /**
   * The file a sibling's specifier resolves to, with that file's own imports made
   * resolvable in turn.
   *
   * A library is delivered exactly as a controller is, so it takes the same two
   * routes: a published module's entry point comes out of its `library` layer,
   * and a working copy's is built from `local_path` so an edit is picked up with
   * no build step. The recursion is real — a library that imports another library
   * needs its own shims beside it — and `seen` bounds it at one visit per module.
   */
  private async prepareLibrary(
    library: ResolvedSiblingLibrary,
    format: string,
    purl: string,
    seen: Set<string>,
  ): Promise<string> {
    const entryFile = await this.libraryEntryFile(library, format, purl);
    const dir = path.dirname(entryFile);
    if (!seen.has(library.moduleSource)) {
      seen.add(library.moduleSource);
      const nested = await this.libraryEntries(library.libraries, format, purl, seen);
      await ensureLibraryShims(dir, nested, this.cacheRoot, this.log);
    }
    // A library entry imports `@telorun/sdk` like any controller does.
    await ensureRealmSymlinks(dir);
    return entryFile;
  }

  /**
   * The file a library's specifier resolves to.
   *
   * Every failure here is `ControllerEnvMissingError`, and that is a choice worth
   * defending: it is not "this host lacks an environment" in the ordinary sense.
   * But a library is resolved **per format**, so a failure is scoped to ONE
   * candidate — the `js` library being absent says nothing about whether a
   * `napi` candidate of the same kind can run, and the candidate list is exactly
   * the mechanism for trying it. Failing hard would abort a list a sibling
   * candidate could still satisfy. It also matches how the controller path
   * already treats the same shapes: a missing bundle file and a selector the
   * artifact ships no layer for are both env-missing there. What must never be
   * masked this way is a *build* failure or a malformed bundle, and neither is
   * reachable from here — those keep their hard codes. Each message names the
   * sibling module and the action, and the aggregated
   * `ERR_CONTROLLER_NOT_FOUND` carries every one of them.
   */
  private async libraryEntryFile(
    library: ResolvedSiblingLibrary,
    format: string,
    purl: string,
  ): Promise<string> {
    if (library.artifact) {
      const resolved = await library.artifact.materializeLibrary(library.selector);
      if (!resolved) {
        throw new ControllerEnvMissingError(
          `pkg:telo controller "${purl}" imports "${library.specifier}", but module ` +
            `${library.moduleSource} ships no ${format} library layer for it ` +
            `(has: ${library.artifact.describeLayers()}). Republish that module.`,
        );
      }
      return path.resolve(resolved.layer.dir, library.path);
    }

    if (!library.moduleDir) {
      throw new ControllerEnvMissingError(
        `pkg:telo controller "${purl}" imports "${library.specifier}", but module ` +
          `${library.moduleSource} has no local directory to resolve its library entry point in.`,
      );
    }

    // Working copy: the source is authoritative, exactly as it is for a
    // controller — a stale checked-in bundle would otherwise shadow the edit.
    const source = library.localPath
      ? path.resolve(library.moduleDir, library.localPath)
      : undefined;
    if (
      source !== undefined &&
      this.cacheRoot !== undefined &&
      (await pathExists(source)) &&
      (await canBuildFromSource())
    ) {
      return buildControllerFromSource(
        source,
        this.cacheRoot,
        buildExternals(library.libraries, format),
      );
    }

    const prebuilt = path.resolve(library.moduleDir, library.path);
    if (await pathExists(prebuilt)) return prebuilt;
    throw new ControllerEnvMissingError(
      `pkg:telo controller "${purl}" imports "${library.specifier}", whose entry point is not at ` +
        `"${prebuilt}"${source ? ` and whose source "${source}" cannot be built here` : ""}.`,
    );
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
    libraries: SiblingLibraryMap = NO_SIBLING_LIBRARIES,
    report?: ControllerWorkReporter,
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
    // Every sibling library this bundle imports, resolved before the bundle is:
    // its `import { KeyedClaim } from "@telorun/kv-store"` has to have a file
    // behind it, and which file that is depends on the import graph rather than
    // on anything inside the bundle. Done at resolve time with the other
    // fail-fast checks, so an unresolvable library reports itself as a candidate
    // this host cannot run rather than as an opaque module-not-found at import.
    const shims = await this.libraryEntries(libraries, format, purl, new Set());

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
            // A dev build is a compile the caller waits on, and it is paid here
            // rather than at resolve — which is why the work signal is not tied
            // to the resolve phase. The reporter goes INTO the builder rather
            // than wrapping the call: only the builder knows whether its
            // content-addressed cache answered, and reporting a cache hit would
            // put a line on screen for work nobody waited for.
            built = await buildControllerFromSource(
              sourceFile!,
              cacheRoot!,
              buildExternals(libraries, format),
              report,
            );
          } catch (err) {
            if (!(err instanceof ControllerEnvMissingError)) throw err;
            if (!(await pathExists(prebuilt))) throw err;
            await prepareBundleDir(path.dirname(prebuilt), shims, this.cacheRoot, this.log);
            return importControllerModule(prebuilt, purl, fragment);
          }
          await prepareBundleDir(path.dirname(built), shims, this.cacheRoot, this.log);
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
      const resolved = await artifact.materializeController(selector, report);
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

    // Make bare `@telorun/sdk` (etc.) and every sibling library resolve before
    // importing the bundle, so authors write normal imports.
    await prepareBundleDir(path.dirname(absFile), shims, this.cacheRoot, this.log);

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
