import {
  codeLayerFor,
  matchCodeLayers,
  singletonLayer,
  splitIntegrity,
  describeSelector,
  type ArtifactLayer,
  type ArtifactSelector,
  type PlatformTarget,
} from "@telorun/analyzer";
import { NOOP_LOGGER, RuntimeError, type Logger } from "@telorun/sdk";
import { existsSync } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";

// Type-only: the loader that supplies this reporter imports the artifact, so
// the cycle is erased at compile time.
import type { ControllerWorkReporter } from "../controller-loader.js";
import { withDirectoryLock } from "../directory-lock.js";
import { cachePathForCanonical } from "../manifest-sources/local-manifest-cache-source.js";
import type { TransportRegistry } from "../transports/transport-registry.js";
import { computeFilesIntegrity, type PayloadFile } from "./files-integrity.js";

/** A materialized layer: the directory its files were extracted into (the
 *  module's cache directory) and the manifest-relative paths it wrote. */
export interface MaterializedLayer {
  dir: string;
  files: string[];
}

/** A materialized controller layer plus whether reaching it cost a transfer.
 *
 *  `transferred` is out of band rather than a field on `MaterializedLayer`
 *  because it describes THIS call, not the layer: the value is memoized and
 *  shared, so a flag on it would be meaningless to every other caller. Only the
 *  controller path reports progress, so only it asks. */
export interface ResolvedControllerLayer {
  layer: MaterializedLayer;
  transferred: boolean;
}

/**
 * Map Node's platform vocabulary onto the canonical OCI/GOOS names selectors are
 * published with. Node says `win32`/`x64`; OCI descriptors say
 * `windows`/`amd64`, and the published artifact is what has to be matched.
 */
const NODE_OS_TO_OCI: Readonly<Record<string, string>> = {
  win32: "windows",
  darwin: "darwin",
  linux: "linux",
  freebsd: "freebsd",
  openbsd: "openbsd",
  sunos: "solaris",
  aix: "aix",
};

const NODE_ARCH_TO_OCI: Readonly<Record<string, string>> = {
  x64: "amd64",
  ia32: "386",
  arm64: "arm64",
  arm: "arm",
  ppc64: "ppc64le",
  s390x: "s390x",
  riscv64: "riscv64",
  loong64: "loong64",
};

/**
 * Which libc this process is linked against, or `undefined` when it cannot be
 * determined. Undetermined is deliberately *not* guessed: a selector that
 * constrains `libc` then matches nothing, so a glibc binary is never handed to
 * an Alpine host on the assumption it will run. Node reports
 * `glibcVersionRuntime` in its process report only on a glibc build, which makes
 * its absence on Linux the musl signal.
 */
function detectLibc(): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const report = process.report?.getReport() as
      | { header?: { glibcVersionRuntime?: string } }
      | undefined;
    return report?.header?.glibcVersionRuntime ? "gnu" : "musl";
  } catch {
    return undefined;
  }
}

/**
 * The platform this kernel is running on, in the published vocabulary. An axis
 * Node cannot name is left absent rather than guessed.
 *
 * Computed once: the host cannot change mid-process, and `detectLibc` generates a
 * full Node diagnostic report (a heap and stack walk costing tens of milliseconds).
 * The controller loader asks per candidate per definition — oauth-client alone has
 * seventeen — so recomputing would put that squarely inside the init loop.
 */
let cachedHostTarget: PlatformTarget | undefined;

export function hostPlatformTarget(): PlatformTarget {
  cachedHostTarget ??= {
    os: NODE_OS_TO_OCI[process.platform],
    arch: NODE_ARCH_TO_OCI[process.arch],
    libc: detectLibc(),
  };
  return cachedHostTarget;
}

/**
 * A module's artifact, scoped to one loaded module.
 *
 * Built during module load, where the **pinned** import ref and the
 * already-verified manifest are both in hand — which is the whole reason this
 * exists as its own object rather than as logic inside a controller loader. A
 * loader is handed only the canonical base URI, which carries no `#sha256-`, so
 * a loader that fetched for itself would have to re-read the layer index off the
 * cache directory: verification silently downgraded from "anchored at the
 * importer's pin" to "trust whatever is already on disk".
 *
 * Materialization is per layer, memoized in-process, and guarded by the shared
 * cross-process directory lock — oauth-client alone has seventeen definitions
 * resolving concurrently against one controller layer, and several kernels may
 * populate one cache directory at once.
 *
 * Verification runs before extraction: the transport checks the transfer against
 * the layer's `blob` digest, and the extracted file set is checked against its
 * `integrity` content digest here. A per-layer marker keyed by the blob digest
 * records success, so a republish to different bytes re-extracts rather than
 * being mistaken for an already-populated layer.
 */
export class ModuleArtifact {
  /** The importer's pinned ref — what the transport verifies the manifest layer
   *  against, and what keeps the Merkle chain anchored. */
  private readonly pinnedRef: string;
  private readonly layers: readonly ArtifactLayer[];
  private readonly dir: string;
  private readonly transports: TransportRegistry;
  private readonly log: Logger;
  /** In-flight / completed materializations, keyed by blob digest. Rejections
   *  are dropped so a transient fetch failure retries on the next ask. Each
   *  records whether the work it wraps transferred the layer or read it off
   *  disk — the memoized entry is shared, so a joining caller reads the flag
   *  but never claims it. */
  private readonly inFlight = new Map<string, Promise<ResolvedControllerLayer>>();

  constructor(opts: {
    pinnedRef: string;
    layers: readonly ArtifactLayer[];
    dir: string;
    transports: TransportRegistry;
    log?: Logger;
  }) {
    this.pinnedRef = opts.pinnedRef;
    this.layers = opts.layers;
    this.dir = opts.dir;
    this.transports = opts.transports;
    this.log = opts.log ?? NOOP_LOGGER;
  }

  /** The module's local directory — where every materialized layer lands, and
   *  what a module-relative path resolves against. */
  get directory(): string {
    return this.dir;
  }

  /**
   * Materialize the code layers carrying `selector` exactly — `controller` and
   * `library` both — plus the `common` layer.
   *
   * Looked up by exact selector key rather than by re-matching the host: the
   * candidate being resolved already *is* one selector, and it is by construction
   * the key of the layer that carries it. Re-matching would take the first layer
   * in declaration order that the host satisfies, so a module shipping both a
   * platform-neutral and a platform-constrained layer of one format would fetch
   * whichever came first regardless of which candidate asked — materializing the
   * wrong layer and then reporting "bundle not found".
   *
   * **Both code roles**, because a module's controller entry points and its
   * library entry point are one file whenever it declares both: the file lands in
   * the `library` layer (the weaker precondition — a consumer must reach it
   * without loading this module's controllers), so a controller resolution that
   * fetched only its own role would find nothing. Which of the two holds a given
   * `path=` is not the loader's business; both being on disk is.
   *
   * The `common` layer rides along because it is the sink for files no candidate
   * claimed — an undeclared sidecar an entry point loads at runtime. Pulling it
   * with any code layer is what makes a forgotten declaration cost bytes
   * instead of a module-not-found at import.
   *
   * Returns `undefined` when the artifact ships no code layer for this selector,
   * which is how a loader learns to fall through to the next candidate.
   */
  async materializeController(
    selector: ArtifactSelector,
    report?: ControllerWorkReporter,
  ): Promise<ResolvedControllerLayer | undefined> {
    return this.materializeCode(selector, ["controller", "library"], report);
  }

  /**
   * Materialize the `library` layer for `selector`, plus `common`.
   *
   * What a *consumer's* bundle loader calls when it resolves a sibling module's
   * declared specifier: the sibling's controllers are irrelevant there — only its
   * library entry point is being imported — so this asks for exactly one role.
   */
  async materializeLibrary(
    selector: ArtifactSelector,
  ): Promise<ResolvedControllerLayer | undefined> {
    return this.materializeCode(selector, ["library"]);
  }

  private async materializeCode(
    selector: ArtifactSelector,
    roles: ReadonlyArray<"controller" | "library">,
    report?: ControllerWorkReporter,
  ): Promise<ResolvedControllerLayer | undefined> {
    const wanted = roles
      .map((role) => codeLayerFor(this.layers, role, selector))
      .filter((l): l is ArtifactLayer => l !== undefined);
    if (wanted.length === 0) return undefined;
    const common = await this.materializeCommonTracked(report);
    let transferred = common?.transferred ?? false;
    const files: string[] = [];
    for (const layer of wanted) {
      // Every half is a transfer the caller waited on: the common layer's bytes
      // come down on this call too, so they are as much of a wait as the code
      // layer's.
      const resolved = await this.materializeTracked(layer, report);
      transferred = resolved.transferred || transferred;
      files.push(...resolved.layer.files);
    }
    return { layer: { dir: this.dir, files: files.sort() }, transferred };
  }

  /**
   * Materialize everything a module-relative file read could need: the `assets`
   * layer **and** the `common` layer.
   *
   * Both, because `common` is where the sink rule puts a file the author did not
   * claim via `assets:` — and a module that ships static files but has no bundled
   * controller has no other path to its own payload. Assets alone would leave such
   * a module's `Http.Static` root resolving into an empty directory, which is the
   * exact silent failure this design promises not to have.
   */
  async materializeModuleFiles(): Promise<void> {
    await Promise.all([this.materializeAssets(), this.materializeCommon()]);
  }

  /** Materialize the lazily-fetched `assets` layer, if the module ships one. */
  async materializeAssets(): Promise<MaterializedLayer | undefined> {
    const layer = singletonLayer(this.layers, "assets");
    return layer ? this.materialize(layer) : undefined;
  }

  /** Materialize the `common` layer, if the module ships one. */
  async materializeCommon(): Promise<MaterializedLayer | undefined> {
    return (await this.materializeCommonTracked())?.layer;
  }

  /** As `materializeCommon`, reporting whether this call transferred it — the
   *  controller path rides the common layer along and has to count its bytes as
   *  part of the wait. One lookup, so "common comes too" is encoded once. */
  private async materializeCommonTracked(
    report?: ControllerWorkReporter,
  ): Promise<ResolvedControllerLayer | undefined> {
    const layer = singletonLayer(this.layers, "common");
    return layer ? this.materializeTracked(layer, report) : undefined;
  }

  /**
   * Materialize every layer a `target` platform could need — both singletons and
   * each controller layer matching it. `telo install`'s make-this-offline pass,
   * where being exhaustive for one platform is the point.
   */
  async materializeAll(target: PlatformTarget): Promise<MaterializedLayer[]> {
    const wanted = [
      ...matchCodeLayers(this.layers, target),
      singletonLayer(this.layers, "assets"),
      singletonLayer(this.layers, "common"),
    ].filter((l): l is ArtifactLayer => l !== undefined);
    const out: MaterializedLayer[] = [];
    for (const layer of wanted) out.push(await this.materialize(layer));
    return out;
  }

  /** Human-facing description of what this artifact ships, for diagnostics that
   *  have to explain why no layer matched. */
  describeLayers(): string {
    if (this.layers.length === 0) return "(no payload layers)";
    return this.layers
      .map((l) => (l.selector ? `${l.role} ${describeSelector(l.selector)}` : l.role))
      .join(", ");
  }

  private async materialize(layer: ArtifactLayer): Promise<MaterializedLayer> {
    return (await this.materializeTracked(layer)).layer;
  }

  /**
   * As `materialize`, but also reporting whether THIS call transferred the layer.
   *
   * A caller that joins work already in flight reports `false`: several
   * controller candidates of one module share a layer, and attributing the
   * transfer to all of them would print one progress line per candidate for a
   * single download. The call that started the work owns the report.
   */
  private materializeTracked(
    layer: ArtifactLayer,
    report?: ControllerWorkReporter,
  ): Promise<ResolvedControllerLayer> {
    const pending = this.inFlight.get(layer.blob);
    if (pending) return pending.then((r) => ({ layer: r.layer, transferred: false }));
    const work = this.materializeUncached(layer, report).catch((err) => {
      // Drop the rejection so a transient fetch failure is retried rather than
      // cached for the lifetime of the module.
      this.inFlight.delete(layer.blob);
      throw err;
    });
    this.inFlight.set(layer.blob, work);
    return work;
  }

  private markerPath(layer: ArtifactLayer): string {
    // Keyed by the blob digest, so a republish to different bytes gets a new
    // marker and re-extracts instead of being read as already-populated. The
    // role is in the name purely so a human can tell the markers apart.
    const short = layer.blob.replace(/^sha256:/, "").slice(0, 16);
    return path.join(this.dir, `.telo-layer-${layer.role}-${short}`);
  }

  private async materializeUncached(
    layer: ArtifactLayer,
    report?: ControllerWorkReporter,
  ): Promise<ResolvedControllerLayer> {
    const marker = this.markerPath(layer);
    if (existsSync(marker)) {
      return { layer: { dir: this.dir, files: await readMarker(marker) }, transferred: false };
    }

    return withDirectoryLock(
      this.dir,
      "module layer",
      async () => {
        // Re-check inside the lock: a peer may have extracted this layer between
        // the fast-path miss and our acquisition.
        if (existsSync(marker)) {
          return { layer: { dir: this.dir, files: await readMarker(marker) }, transferred: false };
        }

        // Both re-checks are behind us, so this call really does go to the
        // network — the one point at which a transfer is a fact rather than a
        // possibility, and the same place `transferred: true` is decided.
        await report?.("layer-fetch");
        const files = await this.transports.fetchLayer(this.pinnedRef, layer.blob);
        const actual = await computeFilesIntegrity(files);
        if (actual !== layer.integrity) {
          throw new RuntimeError(
            "ERR_MODULE_LAYER_INTEGRITY",
            `Integrity check failed for the ${layer.role} layer of ${this.pinnedRef}: ` +
              `expected ${layer.integrity}, got ${actual}. The layer's contents do not match ` +
              `the digest recorded in the module's pinned telo.yaml — it may have been ` +
              `tampered with or republished.`,
          );
        }

        const written = await this.extract(files, layer);
        // Marker last, so a partial extraction leaves none and re-runs.
        await fs.writeFile(marker, `${written.join("\n")}\n`, "utf-8");
        this.log.debug("materialized module layer", {
          "telo.module.ref": this.pinnedRef,
          "telo.layer.role": layer.role,
          "telo.layer.files": written.length,
        });
        return { layer: { dir: this.dir, files: written }, transferred: true };
      },
      this.log,
    );
  }

  private async extract(files: PayloadFile[], layer: ArtifactLayer): Promise<string[]> {
    const root = path.resolve(this.dir) + path.sep;
    const written: string[] = [];
    for (const entry of files) {
      const dest = path.resolve(this.dir, entry.name);
      if (!dest.startsWith(root)) {
        throw new RuntimeError(
          "ERR_MODULE_LAYER_INVALID",
          `The ${layer.role} layer of ${this.pinnedRef} contains entry '${entry.name}', which ` +
            `resolves outside the module's cache directory.`,
        );
      }
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, entry.content);
      written.push(entry.name);
    }
    return written.sort();
  }
}

async function readMarker(marker: string): Promise<string[]> {
  const text = await fs.readFile(marker, "utf-8");
  return text.split("\n").filter((line) => line !== "");
}

/**
 * The directory a module's layers live in.
 *
 * Derived from the **pinned** `requestedUrl`, not the canonical `source`, because
 * those diverge exactly when the manifest cache is warm: a cache hit is served as
 * a `file://` URL into `.telo/manifests/`, which no transport claims, so a
 * `source`-derived path is `null` on every run after the first. The pinned ref is
 * what the importer wrote and survives the hit, so it places the module
 * identically cold and warm. A genuinely local `source` (development, or a module
 * loaded straight off disk) resolves to its own directory.
 *
 * A module's LAYERS extract beside its cached `telo.yaml`, so this has to follow
 * the manifest cache's own fallback to the pre-workspace-anchor root: when the
 * manifest resolved from `<entry-dir>/.telo/manifests/` because the workspace root
 * is cold, its already-materialized controller layers are there too. Deriving the
 * directory from the new root alone left an offline hermetic upgrade resolving
 * `telo.yaml` from disk and then going to the network for every bundled
 * controller — the fallback covering half a module.
 *
 * The legacy root is chosen only when it HOLDS the manifest and the current root
 * does not; a cold cache still places the module under the current root, so a
 * fresh materialization is never diverted to the old location.
 *
 * Returns `null` when neither route yields a directory — a `memory://` module, or
 * a ref this cache has no coordinates for.
 */
export function moduleDirectoryFor(
  requestedUrl: string,
  source: string,
  entryDir: string,
  registryUrl: string | undefined,
  manifestsDir: string | undefined,
  legacyDir?: string | null,
): string | null {
  const pinned = splitIntegrity(requestedUrl).base;
  const cacheFile = cachePathForCanonical(pinned, entryDir, registryUrl, manifestsDir);
  if (cacheFile) {
    if (legacyDir && !existsSync(cacheFile)) {
      const legacyFile = cachePathForCanonical(pinned, entryDir, registryUrl, legacyDir);
      if (legacyFile && existsSync(legacyFile)) return path.dirname(legacyFile);
    }
    return path.dirname(cacheFile);
  }
  if (source.startsWith("file://")) return path.dirname(fileURLToPath(source));
  if (path.isAbsolute(source)) return path.dirname(source);
  return null;
}

/**
 * Build the artifact handle for a loaded module, or `undefined` when the module
 * has no payload to materialize.
 *
 * The trigger is the presence of a `layers:` index — a module that ships nothing
 * needs no handle. `pinnedRef` is the ref **as the importer wrote it**, integrity
 * fragment included, which is what keeps verification anchored to the importer's
 * pin; `moduleDir` is where its layers extract to (see {@link moduleDirectoryFor}).
 */
export function moduleArtifactFor(opts: {
  pinnedRef: string;
  layers: readonly ArtifactLayer[] | undefined;
  moduleDir: string | null;
  transports: TransportRegistry;
  log?: Logger;
}): ModuleArtifact | undefined {
  if (!opts.layers || opts.layers.length === 0) return undefined;
  if (!opts.moduleDir) return undefined;
  return new ModuleArtifact({
    pinnedRef: opts.pinnedRef,
    layers: opts.layers,
    dir: opts.moduleDir,
    transports: opts.transports,
    log: opts.log,
  });
}
