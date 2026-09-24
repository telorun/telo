import {
  Loader,
  collectModuleFileClaims,
  flattenForAnalyzer,
  readAssetPatterns,
  readNativeEntries,
  selectorMatches,
  type LoadedGraph,
  type LoadedModule,
  type ModuleFileClaim,
  type PlatformTarget,
} from "@telorun/analyzer";
import {
  Kernel,
  LocalFileSource,
  LocalManifestCacheSource,
  buildControllerBundle,
  buildSiblingLibraries,
  createArchiveReader,
  defaultTransportRegistry,
  moduleArtifactFor,
  moduleDirectoryFor,
  readOwnerManifest,
  resolveEntryDir,
  writeManifestCache,
  type ModuleArtifact,
  type OwnerManifest,
  type SiblingLibrary,
  type SiblingLibraryMap,
} from "@telorun/kernel";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { selectFiles } from "../bundle/select-files.js";
import { expandDirectoryClaims } from "../bundle/module-path-claims.js";
import { cliVersion } from "../distribution-versions.js";
import { stageModule } from "../release/stage.js";
import { describeGaps, warmModuleLayers } from "../bundle/warm-layers.js";
import {
  APP_PREFIX,
  CACHE_PREFIX,
  PAYLOAD_INDEX,
  analysisKeyFor,
  directoryEntries,
  packPayload,
  type AppIndex,
  type AppModuleRecord,
} from "./app-payload.js";
import { describeRefusals, unportableKinds } from "./portability.js";

/**
 * Assemble everything a packaged application needs, for one platform.
 *
 * **The payload is a pure function of the closure**: the tar's framing is pinned
 * by the kernel's own writer and nothing here records when it ran, so packaging
 * the same application twice produces the same bytes and the same digest — which
 * is what lets a rebuilt-but-unchanged binary reuse the unpack directory already
 * on the machine instead of leaving a second copy of the same tree behind. A
 * build timestamp in the index would be one field that quietly undoes that.
 *
 * Three things distinguish this from `telo install`, and all three are the same
 * fact: a packaged app has no lazy path. The warm must be complete (which
 * `telo install` now enforces for everyone), every local module must be carried
 * BUILT rather than as source (nothing compiles on the target machine, and the
 * payload has no bundler to compile with), and the analysis verdict must be
 * keyed by something that survives being unpacked somewhere else.
 */

export interface PackageBuildOptions {
  readonly manifestPath: string;
  readonly platform: PlatformTarget;
  /** One line per step, on stderr through the caller's seam. */
  readonly report: (message: string) => void;
}

export interface PackageBuildResult {
  readonly payload: Buffer;
  readonly index: AppIndex;
}

export async function buildAppPayload(options: PackageBuildOptions): Promise<PackageBuildResult> {
  const { platform, report } = options;
  const entryPath = path.resolve(process.cwd(), options.manifestPath);
  const entryDir = resolveEntryDir(entryPath);
  if (!entryDir) throw new Error(`${options.manifestPath} is not a local manifest`);

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "telo-package-"));
  try {
    const loader = new Loader([new LocalFileSource(), ...defaultTransportRegistry().sources()]);
    const graph = await loader.loadGraph(entryPath, { desugarImports: true, migrate: true });
    if (graph.errors.length > 0) {
      // Every one of them: `telo check` reports the whole set, and packaging
      // refusing on the first would send an author round the loop once per
      // broken import.
      throw new Error(
        [
          `${options.manifestPath} could not be loaded:`,
          ...graph.errors.map(
            (entry) => `  ${entry.error instanceof Error ? entry.error.message : String(entry.error)}`,
          ),
        ].join("\n"),
      );
    }
    const manifests = flattenForAnalyzer(graph);

    const application = manifests.find((manifest) => manifest.kind === "Telo.Application");
    if (!application) {
      throw new Error(
        `${options.manifestPath} declares no Telo.Application. A library is imported, never packaged — ` +
          `package the application that imports it.`,
      );
    }

    const refusals = unportableKinds(manifests);
    if (refusals.length > 0) throw new Error(describeRefusals(refusals));

    const cacheRoot = path.join(staging, CACHE_PREFIX);
    const manifestsDir = path.join(cacheRoot, "manifests");
    fs.mkdirSync(manifestsDir, { recursive: true });
    await writeManifestCache(graph, entryDir, manifestsDir);

    const warmed = await warmModuleLayers(graph, entryDir, manifestsDir, platform);
    if (warmed.gaps.length > 0) throw new Error(describeGaps(warmed.gaps));
    report(`materialized ${warmed.materialized} module layer${warmed.materialized === 1 ? "" : "s"}`);

    const appRoot = path.join(staging, APP_PREFIX);
    const local = await stageLocalModules({
      graph,
      warmed,
      appRoot,
      entryPath,
      platform,
      cacheRoot,
      report,
    });

    // The analysis verdict, warmed under the key the packaged app will ask with.
    // Runs against the source tree rather than the staged copy: the stamp's key
    // and signature are the payload's, so where the load happened does not enter
    // into it, and the validators it compiles are keyed by schema content.
    const entries = [
      ...directoryEntries(appRoot, APP_PREFIX),
      ...directoryEntries(cacheRoot, CACHE_PREFIX),
    ];
    const analysisKey = analysisKeyFor(entries);
    await warmAnalysis(entryPath, entryDir, cacheRoot, manifestsDir, analysisKey, report);

    const metadata = (application.metadata ?? {}) as Record<string, unknown>;
    const index: AppIndex = {
      format: 1,
      app: {
        name: typeof metadata.name === "string" ? metadata.name : "app",
        ...(typeof metadata.version === "string" ? { version: metadata.version } : {}),
      },
      entry: local.entryRelative ? `${APP_PREFIX}/${local.entryRelative}` : APP_PREFIX,
      platform: {
        os: platform.os ?? "unknown",
        arch: platform.arch ?? "unknown",
        ...(platform.libc ? { libc: platform.libc } : {}),
        ...(platform.abi ? { abi: platform.abi } : {}),
      },
      telo: cliVersion() ?? "unversioned",
      analysisKey,
      modules: local.modules,
    };

    const payload = await packPayload([
      { name: PAYLOAD_INDEX, content: `${JSON.stringify(index, null, 2)}\n` },
      ...directoryEntries(appRoot, APP_PREFIX),
      ...directoryEntries(cacheRoot, CACHE_PREFIX),
    ]);
    return { payload, index };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** The analysis walk, warmed into the payload's cache under the payload's own
 *  key. `analyzeOnly` stops before instantiation, so no application code runs
 *  and no port is bound. */
async function warmAnalysis(
  entryPath: string,
  entryDir: string,
  cacheRoot: string,
  manifestsDir: string,
  analysisKey: string,
  report: (message: string) => void,
): Promise<void> {
  const kernel = new Kernel({
    sources: [new LocalFileSource(), new LocalManifestCacheSource(entryDir, manifestsDir)],
  });
  await kernel.load(entryPath, { analyzeOnly: true, cacheDir: cacheRoot, analysisKey });
  report("warmed the analysis verdict");
}

interface LocalStaging {
  readonly entryRelative: string;
  readonly modules: AppModuleRecord[];
}

/**
 * Bring every LOCAL module in the closure into the payload, built.
 *
 * A module reached by a relative `source:` — including the application itself —
 * has no artifact, so nothing warms it and its controller is normally compiled
 * from TypeScript at load. Here each `pkg:telo/local/js` candidate and each
 * `exports.code:` entry point is built through the same builder publish and
 * release share, written at the `path=` the manifest already names, and the
 * sources are left behind: with no source on disk the kernel's dev branch does
 * not fire, so the prebuilt file is what loads and nothing compiles on the
 * target machine.
 */
async function stageLocalModules(options: {
  graph: LoadedGraph;
  warmed: { artifacts: Map<string, ModuleArtifact>; libraries: Map<string, SiblingLibraryMap> };
  appRoot: string;
  entryPath: string;
  platform: PlatformTarget;
  cacheRoot: string;
  report: (message: string) => void;
}): Promise<LocalStaging> {
  const { graph, warmed, appRoot, entryPath, platform, cacheRoot, report } = options;

  const locals: { module: LoadedModule; dir: string }[] = [];
  const records: AppModuleRecord[] = [];
  for (const module of graph.modules.values()) {
    const file = localPathOf(module.owner.source);
    if (!file) {
      records.push({
        source: module.owner.requestedUrl ?? module.owner.source,
        delivery: "artifact",
      });
      continue;
    }
    locals.push({ module, dir: path.dirname(file) });
  }

  const relative = payloadLayout(
    locals.map((entry) => entry.dir),
    resolveEntryDir(entryPath) ?? path.dirname(entryPath),
  );

  const archives = createArchiveReader();
  for (const { module, dir } of locals) {
    const owner = readOwnerManifest(module.owner.text);
    // Every `sources:` entry first, so a native file or a platform-qualified
    // controller is at its pin before anything copies it.
    if (hasSources(owner)) {
      const result = await stageModule(
        { key: relative(dir) || ".", dir, manifestPath: localPathOf(module.owner.source)! },
        { pin: false, archives },
      );
      if (result.failures.length > 0) {
        const failure = result.failures[0];
        throw new Error(
          `could not stage ${failure.source}/${failure.path} of ${relative(dir) || "the application"}: ${failure.message}`,
        );
      }
    }

    const label = relative(dir) || "the application";
    const copied = new Set<string>();
    // **A file the manifest names and that is not there is a REFUSAL.** Skipping
    // it silently is the failure class §1.1 closed for warmed layers, reopened on
    // the local half: an unbuilt controller, an unstaged native entry or a
    // missing `!include-text` would leave a payload that is quietly incomplete
    // and fails on first boot, on someone else's machine.
    const copy = (rel: string, why: string): void => {
      if (copied.has(rel)) return;
      const from = path.join(dir, rel);
      if (!fs.existsSync(from)) {
        throw new Error(
          `${label} names '${rel}' (${why}) but there is no such file, so it cannot travel ` +
            `inside the executable. A packaged application carries every file its manifest names.`,
        );
      }
      const to = path.join(appRoot, relative(dir), rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      copied.add(rel);
    };

    // The manifest and its partials.
    for (const file of [module.owner, ...module.partials]) {
      const local = localPathOf(file.source);
      if (local) copy(path.relative(dir, local).split(path.sep).join("/"), "a manifest file");
    }

    // Everything the manifest NAMES: embedded files, assets, controller and
    // library entry points, native files.
    const claims = expandDirectoryClaims(dir, collectModuleFileClaims(module.owner.text), []);
    for (const claim of claims) {
      if (claim.role === "controller" || claim.role === "library") continue;
      copy(claim.path, claim.origin);
    }
    for (const rel of selectFiles(dir, readAssetPatterns(owner))) copy(rel, "an assets: pattern");
    for (const entry of readNativeEntries(owner).entries) {
      if (!selectorMatches(entry.selector, platform)) continue;
      copy(entry.path, entry.origin);
    }

    await buildCode({
      claims,
      dir,
      appDir: path.join(appRoot, relative(dir)),
      platform,
      cacheRoot,
      libraries: warmed.libraries.get(module.owner.source),
      copy,
      report,
    });

    records.push({
      source: relative(dir) || ".",
      ...(owner.name ? { name: owner.name } : {}),
      ...(owner.version ? { version: owner.version } : {}),
      delivery: "local",
    });
  }

  // `.env` files are configuration, they frequently hold secrets, and a packaged
  // binary is extractable by anyone holding it — so they never travel, and a
  // packaged app reads them from the working directory instead.
  dropEnvFiles(appRoot);

  return { entryRelative: relative(entryPath), modules: records };
}

/** Build (or carry) the code entry points one module's claims name. */
async function buildCode(options: {
  claims: readonly ModuleFileClaim[];
  dir: string;
  appDir: string;
  platform: PlatformTarget;
  cacheRoot: string;
  libraries: SiblingLibraryMap | undefined;
  copy: (rel: string, why: string) => void;
  report: (message: string) => void;
}): Promise<void> {
  const { claims, dir, appDir, platform, cacheRoot, libraries, copy, report } = options;
  const externals = externalLibraries(libraries);
  for (const claim of claims) {
    if (claim.role !== "controller" && claim.role !== "library") continue;
    if (!selectorMatches(claim.selector, platform)) continue;
    if (!claim.localPath) {
      copy(claim.path, claim.origin);
      continue;
    }
    const source = path.join(dir, claim.localPath);
    if (!fs.existsSync(source)) {
      // No source to build from: the prebuilt file must be there, and `copy`
      // refuses when it is not — a controller that is neither built nor
      // buildable cannot travel, and finding that out on the target machine is
      // what this refuses.
      copy(claim.path, claim.origin);
      continue;
    }
    report(`building ${path.basename(dir)}/${claim.path}`);
    const built = await buildControllerBundle(source, cacheRoot, externals);
    const target = path.join(appDir, claim.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(built.path, target);
  }
}

/** The bare specifiers a module's bundles import, with a local sibling's source
 *  directory — the same externals the kernel's own dev build passes. */
function externalLibraries(libraries: SiblingLibraryMap | undefined): SiblingLibrary[] {
  if (!libraries) return [];
  return [...libraries.values()].map((library) => ({
    specifier: library.specifier,
    ...(library.moduleDir && library.localPath
      ? { sourceDir: path.dirname(path.resolve(library.moduleDir, library.localPath)) }
      : {}),
  }));
}

function hasSources(owner: OwnerManifest): boolean {
  return (owner as unknown as { sources?: unknown }).sources !== undefined;
}

/** An on-disk path for a loader source URL, or `null` for a remote one. */
function localPathOf(source: string | undefined): string | null {
  if (!source) return null;
  if (source.startsWith("file://")) return fileURLToPath(source);
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(source) ? null : source;
}

/**
 * Where each local module sits INSIDE the payload.
 *
 * Two properties have to hold at once. Relative imports must keep resolving —
 * `source: ../shared` has to find the same module in the payload as on disk — so
 * the offsets BETWEEN modules are preserved exactly. And the layout must be a
 * function of the manifests rather than of the machine: taking the deepest
 * common directory did preserve the offsets, but the segments between it and
 * each module are the builder's own directory names, so the payload disclosed
 * where it was built AND the same application packaged from two checkouts
 * produced different bytes — losing the reproducibility the unpack cache rests
 * on.
 *
 * So the entry's directory is the anchor, every module is placed at its path
 * RELATIVE to it, and the whole layout is pushed down by as many anonymous
 * levels as the deepest `..` needs — `../shared` under an entry one level down
 * resolves inside the payload exactly as it did on disk, with nothing above the
 * topmost module named after anything on the packaging machine.
 */
function payloadLayout(
  moduleDirs: readonly string[],
  entryDir: string,
): (file: string) => string {
  const anchor = path.resolve(entryDir);
  const upward = (dir: string): number => {
    const rel = path.relative(anchor, path.resolve(dir)).split(path.sep);
    let up = 0;
    while (up < rel.length && rel[up] === "..") up++;
    return up;
  };
  const depth = Math.max(0, ...moduleDirs.map(upward));
  const pad = Array.from({ length: depth }, () => "_").join("/");
  return (file: string): string => {
    const rel = path.relative(anchor, path.resolve(file)).split(path.sep).join("/");
    const joined = pad ? `${pad}/${rel || "."}` : rel;
    const normalized = path.posix.normalize(joined);
    return normalized === "." ? "" : normalized;
  };
}

function dropEnvFiles(root: string): void {
  if (!fs.existsSync(root)) return;
  for (const found of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!found.isFile() || !found.name.startsWith(".env")) continue;
    fs.rmSync(path.join(found.parentPath, found.name), { force: true });
  }
}
