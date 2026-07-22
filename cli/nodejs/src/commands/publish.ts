import * as fs from "fs";
import { PackageURL } from "packageurl-js";
import * as path from "path";
import { pathToFileURL } from "url";
import { DEFAULT_MANIFEST_FILENAME, Loader, StaticAnalyzer, flattenForAnalyzer, splitIntegrity } from "@telorun/analyzer";
import { LocalFileSource, defaultTransportRegistry } from "@telorun/kernel";
import { fetchManifestHash } from "../registry-hash.js";
import { defaultCustomTags } from "@telorun/templating";
import { parseAllDocuments } from "yaml";
import type { Argv } from "yargs";
import { selectFiles } from "../bundle/select-files.js";
import { createLogger, formatAnalysisDiagnostics, type Logger } from "../logger.js";
import type { BumpLevel, ParsedController } from "../publishers/interface.js";
import { getPublisher } from "../publishers/registry.js";
import { findModuleDoc, importSourceRefs } from "./manifest-imports.js";

// ---------------------------------------------------------------------------
// PURL parsing
// ---------------------------------------------------------------------------

function parsePurl(purl: string, manifestDir: string): ParsedController | null {
  let parsed: ReturnType<typeof PackageURL.parseString>;
  try {
    parsed = PackageURL.parseString(purl);
  } catch {
    return null;
  }

  const [type, namespace, name, versionSpec, qualifiers] = parsed;
  const entry = parsed[5] ?? "";

  const localPathRel = (qualifiers as any)?.get("local_path");
  if (!localPathRel) return null;
  if (!type || !name) return null;

  // Reconstruct the package name as it appears in the PURL (e.g. "@telorun/run")
  const packageName = namespace ? `${namespace}/${name}` : name;

  return {
    purl,
    type,
    packageName,
    versionSpec: versionSpec ?? "",
    localPath: path.resolve(manifestDir, localPathRel),
    entry,
  };
}

/** Extract every unique local_path controller from all YAML documents in the file */
function extractControllers(content: string, manifestDir: string): ParsedController[] {
  const seen = new Set<string>();
  const result: ParsedController[] = [];

  for (const m of content.matchAll(/^\s*-\s+(pkg:[^\s]+)/gm)) {
    const purl = m[1].trim();
    if (seen.has(purl)) continue;
    seen.add(purl);
    const parsed = parsePurl(purl, manifestDir);
    if (parsed) result.push(parsed);
  }

  return result;
}

/** Bump the version field in the first YAML document's metadata block */
function bumpModuleVersion(
  content: string,
  level: BumpLevel,
): { content: string; from: string; to: string } | null {
  const match = content.match(/^(\s{2,4}version:\s*)(\d+\.\d+\.\d+)/m);
  if (!match) return null;

  const parts = match[2].split(".").map(Number) as [number, number, number];
  if (level === "major") {
    parts[0]++;
    parts[1] = 0;
    parts[2] = 0;
  } else if (level === "minor") {
    parts[1]++;
    parts[2] = 0;
  } else {
    parts[2]++;
  }

  const newVersion = parts.join(".");
  return {
    content: content.replace(match[0], `${match[1]}${newVersion}`),
    from: match[2],
    to: newVersion,
  };
}

/** Rewrite all PURL version specs for a given packageName to an exact static version */
function rewritePurls(content: string, packageName: string, newVersion: string): string {
  // Escape special regex chars in the package name (handles @scope/name)
  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content.replace(
    new RegExp(`(pkg:[^/]+/${escapedName}@)[^?#]+(\\?[^#]*)?(#[^\\s]*)?`, "g"),
    (_, prefix, qs, frag) => `${prefix}${newVersion}${qs ?? ""}${frag ?? ""}`,
  );
}

// ---------------------------------------------------------------------------
// Include expansion — resolve globs and inline partial file contents
// ---------------------------------------------------------------------------

export function expandAndInlineIncludes(content: string, manifestDir: string): string {
  // Parse the first YAML document to extract include patterns
  const docs = parseAllDocuments(content, { customTags: defaultCustomTags() });
  const firstParsed = docs[0]?.toJSON();
  if (!firstParsed || !Array.isArray(firstParsed.include) || firstParsed.include.length === 0) {
    return content;
  }

  const patterns: string[] = firstParsed.include.filter(
    (p: unknown): p is string => typeof p === "string",
  );
  if (patterns.length === 0) return content;

  // Expand globs against the manifest directory. A glob entry is matched with
  // the shared `ignore` engine (gitignore semantics); a plain path is taken
  // verbatim and validated to exist (an explicit `include:` of a missing file
  // is an error, unlike a glob that simply matches nothing).
  const hasGlobs = patterns.some((p) => /[*?{}\[\]!]/.test(p));
  let resolvedFiles: string[];

  if (hasGlobs) {
    resolvedFiles = selectFiles(manifestDir, patterns, { applyDefaultIgnore: false }).map((rel) =>
      path.resolve(manifestDir, rel),
    );
  } else {
    resolvedFiles = [...new Set(patterns.map((p) => path.resolve(manifestDir, p)))];

    // Validate explicit paths exist and stay within the module directory.
    const realManifestDir = fs.realpathSync(manifestDir) + path.sep;
    for (const filePath of resolvedFiles) {
      if (!fs.existsSync(filePath)) {
        throw new Error(`Included file not found: ${filePath}`);
      }
      const realPath = fs.realpathSync(filePath);
      if (!realPath.startsWith(realManifestDir)) {
        throw new Error(
          `Include path '${filePath}' resolves outside the module directory. ` +
            `Publishing files from outside the module root is not allowed.`,
        );
      }
    }
  }

  // Remove include from the first document via AST (preserves formatting/comments)
  docs[0].deleteIn(["include"]);

  // Inline partial file contents as additional YAML documents
  let inlined = "";
  for (const filePath of resolvedFiles) {
    const partialContent = fs.readFileSync(filePath, "utf-8").trim();
    if (!partialContent) continue;
    inlined += "\n---\n" + partialContent + "\n";
  }

  // Re-serialize all original documents + inlined partials
  const serialized = docs.map((d) => d.toString()).join("---\n");
  return serialized + inlined;
}

/** Read the first doc's `files:` glob patterns (empty when none declared). */
export function readFilesPatterns(content: string): string[] {
  const docs = parseAllDocuments(content, { customTags: defaultCustomTags() });
  const first = docs[0]?.toJSON();
  if (!first || !Array.isArray(first.files)) return [];
  return first.files.filter((p: unknown): p is string => typeof p === "string");
}

// ---------------------------------------------------------------------------
// Relative import canonicalization — turn an `imports:` entry's relative
// `../sibling` source into an absolute ref so the published manifest is
// self-contained. A relative path is only meaningful on the publisher's disk;
// a published artifact (an OCI blob, or a registry version URL) cannot resolve
// `..`. The sibling's **location** comes from the publish destination (identity
// is the ref) — for OCI via the destination transport's `resolveRelative`, for
// an HTTP registry the path defaults to the sibling's `<namespace>/<name>`. The
// **version** always comes from the sibling's own authoritative metadata.
// ---------------------------------------------------------------------------

export async function canonicalizeRelativeImports(
  content: string,
  manifestPath: string,
  destination: string,
  loader: Loader,
  localFileSource: LocalFileSource,
): Promise<{ content: string; refs: string[] }> {
  const baseUrl = pathToFileURL(manifestPath).href;
  const docs = parseAllDocuments(content, { customTags: defaultCustomTags() });
  const moduleDoc = findModuleDoc(docs);
  const refs: string[] = [];
  if (!moduleDoc) return { content, refs };

  // The destination's transport owns the scheme-specific "where does a sibling
  // land" rule — publish never branches on transport shape.
  const transport = defaultTransportRegistry().forRef(destination);
  if (!transport) {
    throw new Error(`no transport owns publish destination '${destination}'`);
  }

  for (const importRef of importSourceRefs(moduleDoc)) {
    const source = importRef.source;
    if (!source.startsWith(".") && !source.startsWith("/")) continue;

    const targetUrl = localFileSource.resolveRelative(baseUrl, source);
    const targetLoaded = await loader.loadModule(targetUrl);
    const lib = targetLoaded.owner.manifests.find((m) => m?.kind === "Telo.Library");
    if (!lib) {
      throw new Error(
        `import source '${source}' (resolved: '${targetUrl}') has no Telo.Library doc — only libraries can be canonicalized.`,
      );
    }
    const { namespace, name, version } = (lib.metadata ?? {}) as {
      namespace?: string;
      name?: string;
      version?: string;
    };
    if (!version) {
      throw new Error(
        `import source '${source}' (resolved: '${targetUrl}') is missing metadata.version, required for canonicalization.`,
      );
    }

    const ref = transport.canonicalizeSiblingRef(destination, source, { namespace, name, version });
    moduleDoc.setIn(importRef.path, ref);
    refs.push(ref);
  }

  if (refs.length === 0) return { content, refs };
  return { content: docs.map((d) => d.toString()).join("---\n"), refs };
}

// ---------------------------------------------------------------------------
// Import integrity pinning — rewrite each remote `imports:` ref to carry a
// `#sha256-...` hash of the dependency's published telo.yaml, so an importer's
// hash over THIS manifest transitively pins its dependencies (Merkle chain).
//
// Best-effort by default: an import that cannot be resolved (dependency not
// published yet, network error) is warned and left unpinned — publish is never
// blocked. `frozen` flips that to a hard error. An import the author already
// pinned is left untouched. Relative/path imports are exempt (not fetched).
// ---------------------------------------------------------------------------

export async function pinImports(
  content: string,
  registry: string,
  frozen: boolean,
  log: Logger,
): Promise<{ content: string; pinned: number; unresolved: string[] }> {
  const docs = parseAllDocuments(content, { customTags: defaultCustomTags() });
  const moduleDoc = findModuleDoc(docs);
  const unresolved: string[] = [];
  let pinned = 0;
  if (!moduleDoc) return { content, pinned, unresolved };

  for (const importRef of importSourceRefs(moduleDoc)) {
    const source = importRef.source;
    if (source.startsWith(".") || source.startsWith("/")) continue; // local, exempt
    // Author already pinned — via a `#sha256-...` fragment on the source, or an
    // object-form `integrity:` sibling. Never overwrite an explicit pin.
    if (splitIntegrity(source).integrity || importRef.integrity) continue;

    let hash: string;
    try {
      hash = await fetchManifestHash(registry, source);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (frozen) {
        throw new Error(`--frozen: could not pin import '${source}': ${message}`);
      }
      unresolved.push(source);
      stepWarn(log, "pin", `${source} — left unpinned (${message})`);
      continue;
    }

    moduleDoc.setIn(importRef.path, `${source}#${hash}`);
    pinned++;
  }

  return {
    content: pinned > 0 ? docs.map((d) => d.toString()).join("---\n") : content,
    pinned,
    unresolved,
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const STEP_WIDTH = 9; // "publish  " column width

function step(log: Logger, label: string, status: string) {
  console.log(`    ${label.padEnd(STEP_WIDTH)}${status}`);
}

function stepOk(log: Logger, label: string, detail?: string) {
  step(log, label, log.ok("✓") + (detail ? `  ${detail}` : ""));
}

function stepWarn(log: Logger, label: string, detail: string) {
  step(log, label, log.warn("skipped") + `  ${detail}`);
}

function stepDry(log: Logger, label: string, detail: string) {
  step(log, label, log.dim(`dry-run  ${detail}`));
}

// ---------------------------------------------------------------------------
// Main per-manifest publish
// ---------------------------------------------------------------------------

async function publishOne(
  filePath: string,
  destination: string,
  registry: string,
  bump: BumpLevel | undefined,
  dryRun: boolean,
  skipControllers: boolean,
  frozen: boolean,
  log: Logger,
): Promise<boolean> {
  // A directory argument resolves to its telo.yaml — standard Telo path
  // resolution, matching `run` / `check` (LocalFileSource stats a dir → telo.yaml).
  try {
    if (fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, DEFAULT_MANIFEST_FILENAME);
    }
  } catch {
    console.error(log.error("error") + `  Cannot read file: ${filePath}`);
    return false;
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    console.error(log.error("error") + `  Cannot read file: ${filePath}`);
    return false;
  }

  const manifestDir = path.dirname(filePath);
  const controllers = extractControllers(content, manifestDir);

  // Deduplicate by resolved localPath so each package is processed once
  const byLocalPath = new Map<string, ParsedController>();
  for (const c of controllers) {
    if (!byLocalPath.has(c.localPath)) byLocalPath.set(c.localPath, c);
  }

  const uniqueControllers = skipControllers ? [] : Array.from(byLocalPath.values());

  // --- Controller packages ---
  for (const ctrl of uniqueControllers) {
    const publisher = getPublisher(ctrl.type);

    console.log(`\n  ${log.dim(ctrl.packageName)}`);

    if (!publisher) {
      step(log, "publish", log.warn("skipped") + `  no publisher for type "${ctrl.type}"`);
      continue;
    }

    if (!fs.existsSync(ctrl.localPath)) {
      step(log, "publish", log.error("error") + `  local_path not found: ${ctrl.localPath}`);
      return false;
    }

    // Bump
    if (bump) {
      if (dryRun) {
        const current = await publisher.readVersion(ctrl.localPath);
        stepDry(log, "bump", `${current} → ? (${bump})`);
      } else {
        const before = await publisher.readVersion(ctrl.localPath);
        const after = await publisher.bumpVersion(ctrl.localPath, bump);
        stepOk(log, "bump", `${before} → ${after}`);
      }
    }

    const version = await publisher.readVersion(ctrl.localPath);

    // Build
    if (dryRun) {
      stepDry(log, "build", `${ctrl.packageName}@${version}`);
    } else {
      try {
        await publisher.build(ctrl.localPath);
        stepOk(log, "build");
      } catch (err) {
        step(log, "build", log.error("error"));
        console.error(
          (err instanceof Error ? err.message : String(err))
            .split("\n")
            .map((l) => `      ${l}`)
            .join("\n"),
        );
        return false;
      }
    }

    // Publish to code registry
    if (dryRun) {
      stepDry(log, "publish", `${ctrl.packageName}@${version} → ${ctrl.type}`);
    } else {
      const published = await publisher.publish(ctrl.localPath, version);
      if (!published) {
        stepWarn(log, "publish", `${version} already exists on ${ctrl.type}`);
      } else {
        stepOk(log, "publish", `${ctrl.packageName}@${version}`);
      }
    }

    // Rewrite PURLs
    if (dryRun) {
      stepDry(log, "purl", `→ @${version}`);
    } else {
      const oldSpec = ctrl.versionSpec;
      content = rewritePurls(content, ctrl.packageName, version);
      stepOk(log, "purl", `@${oldSpec} → @${version}`);
    }
  }

  // Bump the module's own metadata.version when --bump is set
  let bumpedVersion: { from: string; to: string } | null = null;
  if (bump) {
    const bumped = bumpModuleVersion(content, bump);
    if (bumped) {
      content = bumped.content;
      bumpedVersion = { from: bumped.from, to: bumped.to };
    }
  }

  // Write updated telo.yaml back to disk
  const dirty = uniqueControllers.length > 0 || bump != null;
  if (!dryRun && dirty) {
    fs.writeFileSync(filePath, content, "utf-8");
  }

  // --- Manifest ---
  console.log(`\n  ${log.dim("manifest")}`);

  if (bumpedVersion) {
    if (dryRun) {
      stepDry(log, "version", `${bumpedVersion.from} → ${bumpedVersion.to}`);
    } else {
      stepOk(log, "version", `${bumpedVersion.from} → ${bumpedVersion.to}`);
    }
  }

  // Static analysis pre-flight: validate the manifest (with includes) before publishing.
  // This catches schema errors, bad references, CEL issues, and system-kind violations
  // in partial files — all before the artifact reaches the registry.
  const localFileSource = new LocalFileSource();
  // Same source chain as `telo check`: the kernel's transport sources resolve
  // every scheme install/run do — `oci://` included — direct-to-origin. The
  // analyzer's `defaultSources()` (HTTP + registry only) cannot resolve an OCI
  // import, so an `oci://` dependency (pinned or not) fails to load for analysis.
  const analysisLoader = new Loader([localFileSource, ...defaultTransportRegistry(registry).sources()]);
  let analysisGraph;
  try {
    // `desugarImports` so inline `imports:` maps expand into synthetic
    // Telo.Import manifests and the imported kinds resolve during analysis.
    analysisGraph = await analysisLoader.loadGraph(filePath, { desugarImports: true });
    if (analysisGraph.errors.length > 0) throw analysisGraph.errors[0].error;
  } catch (err) {
    console.error(
      log.error("error") +
        `  Failed to load manifest for analysis: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
  // A parse failure yields a mangled manifest tree; analyzing it would drown the
  // real error under spurious schema violations. Report the parse diagnostics
  // and stop before analysis — mirrors the kernel's load-time short-circuit.
  if (analysisGraph.parseDiagnostics.length > 0) {
    formatAnalysisDiagnostics(analysisGraph.parseDiagnostics, analysisGraph, log, filePath);
    return false;
  }
  const analysisManifests = flattenForAnalyzer(analysisGraph);
  const diagnostics = new StaticAnalyzer().analyze(analysisManifests);
  const { errorCount } = formatAnalysisDiagnostics(diagnostics, analysisGraph, log, filePath);
  if (errorCount > 0) {
    return false;
  }
  stepOk(log, "check", "static analysis passed");

  // Canonicalize relative `imports:` sources to an absolute ref (destination
  // repo + sibling version) so the published artifact is portable. Done after
  // analysis so the dev's on-disk manifest (with relative paths) is validated.
  let canonicalizedRefs: string[] = [];
  try {
    const canon = await canonicalizeRelativeImports(content, filePath, destination, analysisLoader, localFileSource);
    content = canon.content;
    canonicalizedRefs = canon.refs;
  } catch (err) {
    console.error(
      log.error("error") +
        `  Failed to canonicalize relative imports: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }

  // Strict: a published app does not publish its siblings, so every ref derived
  // from a relative import must already resolve at its published location — a
  // dangling one is a hard error (publish the sibling first, or earlier in this
  // invocation). Skipped on --dry-run (nothing is published yet).
  if (!dryRun) {
    const transports = defaultTransportRegistry(registry);
    for (const ref of canonicalizedRefs) {
      try {
        const transport = transports.forRef(ref);
        if (!transport) throw new Error(`no transport owns '${ref}'`);
        await transport.source.read(ref);
      } catch (err) {
        console.error(
          log.error("error") +
            `  relative import canonicalized to '${ref}', which does not resolve at its published ` +
            `location — publish the sibling first. Cause: ${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      }
    }
  }

  // Pin each remote import to its dependency's telo.yaml hash. Best-effort:
  // unresolved imports are warned and left unpinned unless --frozen. Runs after
  // canonicalization so relative siblings are already registry refs.
  if (!dryRun) {
    try {
      const result = await pinImports(content, registry, frozen, log);
      content = result.content;
      if (result.pinned > 0 || result.unresolved.length > 0) {
        stepOk(log, "pin", `${result.pinned} import(s) pinned, ${result.unresolved.length} unresolved`);
      }
    } catch (err) {
      console.error(
        log.error("error") + `  ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  // Expand include globs and inline partial file contents before pushing
  content = expandAndInlineIncludes(content, manifestDir);

  // Resolve the `files:` asset set. When present, the artifact is a
  // `module.tar.gz` (telo.yaml + assets) instead of a bare YAML body.
  let bundledFiles: string[];
  try {
    bundledFiles = selectFiles(manifestDir, readFilesPatterns(content));
  } catch (err) {
    console.error(
      log.error("error") + `  ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }

  if (dryRun) {
    if (bundledFiles.length > 0) {
      stepDry(log, "bundle", `${bundledFiles.length} file(s) + telo.yaml → module.tar.gz`);
    }
    stepDry(log, "push", destination);
    return true;
  }

  const payload = bundledFiles.map((rel) => ({
    name: rel,
    content: fs.readFileSync(path.resolve(manifestDir, rel)),
  }));
  if (bundledFiles.length > 0) {
    stepOk(log, "bundle", `${bundledFiles.length} file(s) + telo.yaml`);
  }

  // The transport its scheme selects owns the artifact shape (HTTP: telo.yaml +
  // module.tar.gz; OCI: one blob), payload pinning, and retry.
  let result;
  try {
    result = await defaultTransportRegistry(registry).publish(
      destination,
      { manifest: content, files: payload },
      {
        token: process.env.TELO_REGISTRY_TOKEN,
        onRetry: ({ reason, attempt, maxAttempts, delayMs }) =>
          console.error(
            `    ${"retry".padEnd(STEP_WIDTH)}${log.warn(reason)}  attempt ${attempt}/${maxAttempts - 1}, ` +
              `waiting ${Math.round(delayMs / 100) / 10}s`,
          ),
      },
    );
  } catch (err) {
    console.error(log.error("error") + `  ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }

  stepOk(log, "push", `${result.label} → ${result.url}`);
  return true;
}

// ---------------------------------------------------------------------------
// Destination-first positional — `telo publish <destination> <paths…>`. The
// destination is an OCI repo (`oci://host/repo`); publishing to the HTTP Telo
// registry has been removed. A leading positional is classified so an old-style
// registry destination gets a clear error rather than being read as a path.
// ---------------------------------------------------------------------------

type DestinationKind = "oci" | "http" | null;

function classifyDestination(arg: string): DestinationKind {
  if (arg.startsWith("oci://")) return "oci";
  if (arg.startsWith("http://") || arg.startsWith("https://")) return "http";
  if (arg.startsWith(".") || arg.startsWith("/")) return null;
  if (fs.existsSync(arg)) return null; // a real local file/dir wins
  if (arg.endsWith(".yaml") || arg.endsWith(".yml")) return null;
  // Host-like bare destination (the old HTTP-registry form, e.g. ghcr.io is
  // written `oci://…`). First path segment carries a dot.
  return arg.split("/")[0].includes(".") ? "http" : null;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function publish(argv: {
  paths: string[];
  registry: string;
  bump?: BumpLevel;
  dryRun: boolean;
  skipControllers: boolean;
  frozen: boolean;
}): Promise<void> {
  if (argv.bump && argv.skipControllers) {
    console.error("error: --bump and --skip-controllers are mutually exclusive");
    process.exit(1);
  }

  // The push destination is the leading positional, an OCI repo. `registry`
  // stays the (read-only, still-deployed) origin used to resolve/pin deps.
  let paths = argv.paths;
  let destination: string | undefined;
  if (paths.length > 0) {
    const kind = classifyDestination(paths[0]);
    if (kind === "http") {
      console.error(
        "error: publishing to the HTTP Telo registry has been removed. " +
          "Publish to an OCI registry, e.g. `telo publish oci://ghcr.io/<org>/<name> ./telo.yaml`.",
      );
      process.exit(1);
    }
    if (kind === "oci") {
      destination = paths[0];
      paths = paths.slice(1);
    }
  }
  if (!destination) {
    console.error(
      "error: no publish destination — pass an OCI repo as the first argument, " +
        "e.g. `telo publish oci://ghcr.io/<org>/<name> ./telo.yaml`.",
    );
    process.exit(1);
  }
  if (paths.length === 0) {
    console.error("error: no manifest paths to publish");
    process.exit(1);
  }

  const log = createLogger(false);
  let failed = false;
  for (const p of paths) {
    const filePath = path.resolve(process.cwd(), p);
    const relPath = path.relative(process.cwd(), filePath);
    console.log(`\nPublishing ${log.dim(relPath)}${log.dim(` → ${destination}`)}`);
    const ok = await publishOne(
      filePath,
      destination,
      argv.registry,
      argv.bump,
      argv.dryRun,
      argv.skipControllers,
      argv.frozen,
      log,
    );
    if (!ok) failed = true;
  }
  console.log("");
  if (failed) process.exit(1);
}

export function publishCommand(yargs: Argv): Argv {
  return yargs.command(
    "publish <paths..>",
    "Publish one or more module manifests to an OCI registry",
    (y) =>
      y
        .positional("paths", {
          describe:
            "Leading OCI destination (oci://host/repo) followed by paths to telo.yaml files to publish",
          type: "string",
          array: true,
          demandOption: true,
        })
        .option("registry", {
          type: "string",
          default: "https://registry.telo.run",
          describe: "Registry origin used to resolve/pin dependencies (read-only)",
        })
        .option("bump", {
          type: "string",
          choices: ["patch", "minor", "major"] as const,
          describe: "Bump controller package versions before publishing",
        })
        .option("dry-run", {
          type: "boolean",
          default: false,
          describe: "Show what would happen without making any changes",
        })
        .option("skip-controllers", {
          type: "boolean",
          default: false,
          describe:
            "Skip controller build/publish/PURL rewrite; only run static analysis and push the manifest to the OCI registry",
        })
        .option("frozen", {
          type: "boolean",
          default: false,
          describe:
            "Fail if any remote import cannot be pinned to its dependency's integrity hash (default: best-effort — warn and continue)",
        }),
    async (argv) => {
      await publish(argv as any);
    },
  );
}
