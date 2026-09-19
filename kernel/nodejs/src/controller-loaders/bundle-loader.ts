import {
  describeSelector,
  normalizeNativePath,
  selectorFromQualifiers,
  selectorMatches,
  type ArtifactSelector,
  type ModuleSources,
} from "@telorun/analyzer";
import {
  ArchiveContentError,
  ArchiveFetchError,
  describeStagingFailure,
  ensureStagedEntry,
  type EnsuredEntryState,
} from "../bundle/source-staging.js";
import { ControllerInstance, RuntimeError, type Logger } from "@telorun/sdk";
import * as fs from "fs/promises";
import { createRequire } from "module";
import { PackageURL } from "packageurl-js";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import {
  hostPlatformTarget,
  NODE_HOSTED_FORMATS,
  type ModuleArtifact,
} from "../bundle/module-artifact.js";
import type { ControllerResolveSource, ControllerWorkReporter } from "../controller-loader.js";
import { ControllerEnvMissingError, projectNapiController } from "./napi-loader.js";
import { ensureRealmShims } from "./realm.js";
import { isWritableShimSlot, shimPackageJson, writeIfChanged } from "./shim-package.js";

const requireFromHere = createRequire(import.meta.url);
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
 * stays single however many shims point at it. The realm collapse writes its own
 * packages into the same `node_modules/` (`realm.ts`), under the same slot rule.
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
 * marker this loader stamps (`shim-package.ts`, shared with the realm). A foreign
 * package in the slot already resolves the specifier to real code; what it costs
 * is the single-scope property, so it is reported rather than passed over in
 * silence.
 */
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
      shimPackageJson(specifier, "sibling-library-shim", "./index.mjs"),
    );
    // `export *` and nothing else: these entry points export named bindings, and
    // a re-exported `default` that does not exist is a hard syntax-level error at
    // import rather than an absent binding.
    await writeIfChanged(path.join(dir, "index.mjs"), `export * from ${JSON.stringify(target)};\n`);
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
  await ensureRealmShims(bundleDir, cacheRoot, log);
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

/**
 * Loads a `pkg:telo` controller — a controller delivered inside the module's own
 * artifact, not fetched from an external package registry. Every PURL segment
 * carries meaning:
 *
 *   pkg:telo / local / <format> ? path=./nodejs/x.mjs # export
 *      type     ns       name          qualifier        subpath
 *
 *  - `type=telo` — Telo-delivered (not npm/cargo).
 *  - `namespace=local` — the delivery sub-mode: bundled in the module artifact.
 *    The namespace is what leaves room for a future sub-mode (a controller
 *    fetched as its own artifact). A non-`local` namespace → env-missing here
 *    (a different mode another branch/kernel would handle).
 *  - `name=<format>` — the artifact format the loader dispatches on (`js` /
 *    `napi` / `wasm`). Bundling is the one delivery not tied to an ecosystem's
 *    runtime (npm ⇒ JS, cargo ⇒ Rust; a bundle is just files), so the format is
 *    explicit. `js` is `import()`ed directly, a `napi` addon is `require`d; a
 *    format this kernel can't host → `ControllerEnvMissingError`, so
 *    `[pkg:telo/local/dylib …, pkg:telo/local/js …]` (or `[pkg:telo …, pkg:npm …]`)
 *    falls through to a candidate this — or another runtime's — kernel can load.
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
 *    no node_modules, so `ensureRealmShims()` writes a generated package for each
 *    realm name into a `node_modules/` next to the bundle; standard resolution
 *    then finds it on every runtime. Authors write a normal
 *    `import { Stream } from "@telorun/sdk"`; nothing special.
 *  - *Identity* — the generated package re-exports the instance the running
 *    kernel published into the process, so `Stream`/`InvokeError` are the
 *    kernel's own however the kernel itself was delivered — including from
 *    inside a single-file executable, where there is no SDK on disk to point at.
 *    (The SDK's globalThis/Symbol singletons also keep identity correct even when
 *    a publish step inlines the SDK into the bundle instead of leaving it
 *    external.)
 *
 * A missing/remote/unparseable bundle is `ControllerEnvMissingError` (fall
 * through); a bundle that loads but is malformed is a hard `ERR_CONTROLLER_INVALID`.
 */
export class BundleControllerLoader {
  /** The pin check of each staged addon, by absolute path: every kind a module
   *  selects out of one addon resolves it, and the file is hashed once. A check
   *  that failed or could not fetch is dropped, so the next resolution tries again. */
  private readonly stagedAddons = new Map<string, Promise<string | undefined>>();

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
    await ensureRealmShims(dir, this.cacheRoot, this.log);
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
        undefined,
        this.log,
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
    sources?: ModuleSources,
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
    // (`local`) controllers. Anything else (a future sub-mode) is env-missing
    // so the candidate list falls through.
    if (parsed.namespace !== "local") {
      throw new ControllerEnvMissingError(
        `pkg:telo controller "${purl}" must use the "local" namespace (pkg:telo/local/<format>); got "${parsed.namespace ?? "(none)"}"`,
      );
    }

    // Format is the PURL name. The Node kernel hosts `js` bundles and `napi`
    // addons; any other format (`dylib`, which only the Rust kernel opens, `wasm`,
    // a future one) is env-missing so the list falls through to a sibling this —
    // or another runtime's — kernel can load.
    const format = parsed.name;
    if (!NODE_HOSTED_FORMATS.has(format)) {
      throw new ControllerEnvMissingError(
        `pkg:telo controller "${purl}": format "${format}" is not hostable by the Node bundle loader ` +
          `(supports ${[...NODE_HOSTED_FORMATS].map((f) => `"${f}"`).join(", ")})`,
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
          `${host.libc ? `/${host.libc}` : ""}${host.abi ? `, abi ${host.abi}` : ""})`,
      );
    }

    const fragment = parsed.subpath;

    // A prebuilt addon: nothing to build, no bundle directory to prepare — an
    // N-API module imports nothing by bare specifier.
    if (format === "napi") {
      return this.resolveNapi(purl, relPath, selector, fragment, baseUri, artifact, report, sources);
    }

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
              this.log,
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

  /**
   * Resolve a `napi` candidate: the addon at `path=`, out of the controller layer
   * carrying its selector for a published module, beside the manifest for a
   * source checkout. A missing file is env-missing like a missing bundle. The
   * addon has no ESM shape, so it is opened through `createRequire` and the
   * fragment names a property of its exports object.
   *
   * In a source checkout an addon a `sources:` entry stages is staged when missing
   * or stale and checked against its pin first — the rule `ctx.resolveNativeFile`
   * applies. An archive that could not be fetched is env-missing, like any addon
   * not on disk, so the next candidate (a source build) still gets its turn; bytes
   * that do not match the pin are a hard `ERR_STAGED_FILE_INVALID`.
   */
  private async resolveNapi(
    purl: string,
    relPath: string,
    selector: ArtifactSelector,
    fragment: string | undefined,
    baseUri: string,
    artifact: ModuleArtifact | undefined,
    report: ControllerWorkReporter | undefined,
    sources: ModuleSources | undefined,
  ): Promise<{ source: ControllerResolveSource; importInstance: () => Promise<ControllerInstance> }> {
    let dir: string;
    let source: ControllerResolveSource = "local";
    if (artifact) {
      const resolved = await artifact.materializeController(selector, report);
      if (!resolved) {
        throw new ControllerEnvMissingError(
          `pkg:telo controller "${purl}": the module artifact ships no layer for ` +
            `${describeSelector(selector)} (has: ${artifact.describeLayers()})`,
        );
      }
      dir = resolved.layer.dir;
      source = resolved.transferred ? "bundle" : "cache";
    } else if (isLocalBase(baseUri)) {
      dir = this.moduleDir(baseUri);
      const key = path.resolve(dir, relPath);
      let check = this.stagedAddons.get(key);
      if (!check) {
        check = assertStagedAddon(purl, dir, relPath, sources, this.log);
        this.stagedAddons.set(key, check);
        check.then(
          (reason) => reason !== undefined && this.stagedAddons.delete(key),
          () => this.stagedAddons.delete(key),
        );
      }
      const unstaged = await check;
      // A stale addon may still be on disk, and it is never the one loaded.
      if (unstaged !== undefined) {
        throw new ControllerEnvMissingError(
          `pkg:telo controller "${purl}": the addon '${relPath}' is not available — ${unstaged}`,
        );
      }
    } else {
      throw new ControllerEnvMissingError(
        `pkg:telo controller "${purl}" cannot be located: the declaring module resolved from ` +
          `"${baseUri}", which is neither a local path nor an artifact with a layer index.`,
      );
    }
    const absFile = path.resolve(dir, relPath);
    if (!(await pathExists(absFile))) {
      throw new ControllerEnvMissingError(`pkg:telo controller addon not found at "${absFile}" (from "${purl}")`);
    }
    return {
      source,
      importInstance: async () => {
        let exports: unknown;
        try {
          exports = requireFromHere(absFile);
        } catch (err) {
          throw new RuntimeError(
            "ERR_CONTROLLER_INVALID",
            `pkg:telo controller "${purl}": failed to load the addon at "${absFile}": ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return projectNapiController(exports, fragment, absFile, `pkg:telo controller "${purl}"`);
      },
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

/**
 * Stage an addon a `sources:` entry stages, and refuse one that is unpinned or
 * does not match its pin, or whose staging cannot be known because the block does
 * not read. Resolves to why the addon could not be fetched — left to the
 * missing-file fallthrough — or `undefined` when it is on disk and verified. Any
 * other staging failure (a lock, a write) is `ERR_STAGING_FAILED`.
 */
async function assertStagedAddon(
  purl: string,
  moduleDir: string,
  relPath: string,
  sources: ModuleSources | undefined,
  log: Logger | undefined,
): Promise<string | undefined> {
  const verdict = normalizeNativePath(relPath.trim());
  if (!("path" in verdict) || !sources) return undefined;
  for (const source of sources.sources) {
    const entry = source.entries.find((candidate) => candidate.path === verdict.path);
    if (!entry) continue;
    const by = `pkg:telo controller "${purl}": the addon '${verdict.path}' is staged by source '${source.name}'`;
    let state: EnsuredEntryState;
    try {
      state = await ensureStagedEntry(moduleDir, source, entry, { log });
    } catch (err) {
      if (err instanceof ArchiveFetchError) return `it is staged by source '${source.name}': ${err.message}`;
      throw new RuntimeError(
        err instanceof ArchiveContentError ? "ERR_STAGED_FILE_INVALID" : "ERR_STAGING_FAILED",
        `${by}, ${describeStagingFailure(err)}`,
      );
    }
    if (state.state === "match") return undefined;
    throw new RuntimeError(
      "ERR_STAGED_FILE_INVALID",
      `${by}, which carries no pin to verify it against — run \`telo release stage --pin\`.`,
    );
  }
  // No readable source stages it; one that could not be read might, so the addon
  // is not loaded unverified — the rule `ctx.resolveNativeFile` applies.
  if (sources.problems.length > 0) {
    throw new RuntimeError(
      "ERR_STAGED_FILE_INVALID",
      `pkg:telo controller "${purl}": the module's sources: block cannot be read, so whether ` +
        `the addon '${verdict.path}' is staged — and what it must hash to — is unknown:\n` +
        sources.problems.map((problem) => `  ${problem.message}`).join("\n") +
        `\nRun \`telo check\` on the module.`,
    );
  }
  return undefined;
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
