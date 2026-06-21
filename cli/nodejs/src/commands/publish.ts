import * as fs from "fs";
import { PackageURL } from "packageurl-js";
import * as path from "path";
import { pathToFileURL } from "url";
import { Loader, StaticAnalyzer, defaultSources, flattenForAnalyzer } from "@telorun/analyzer";
import { LocalFileSource } from "@telorun/kernel";
import { defaultCustomTags } from "@telorun/templating";
import { parseAllDocuments } from "yaml";
import type { Argv } from "yargs";
import { selectFiles } from "../bundle/select-files.js";
import { makeTarGz } from "../bundle/tar.js";
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
// `../sibling` source into `<namespace>/<name>@<version>` so the published
// manifest is self-contained. A relative path is only meaningful on the
// publisher's disk; once the artifact is in the registry, `..` collapses the
// version segment of the registry URL and breaks resolution for downstream
// consumers.
// ---------------------------------------------------------------------------

export async function canonicalizeRelativeImports(
  content: string,
  manifestPath: string,
  loader: Loader,
  localFileSource: LocalFileSource,
): Promise<string> {
  const baseUrl = pathToFileURL(manifestPath).href;
  const docs = parseAllDocuments(content, { customTags: defaultCustomTags() });
  const moduleDoc = findModuleDoc(docs);
  if (!moduleDoc) return content;
  let changed = false;

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
    if (!namespace || !name || !version) {
      throw new Error(
        `import source '${source}' (resolved: '${targetUrl}') is missing metadata.namespace/name/version, required for canonicalization.`,
      );
    }

    moduleDoc.setIn(importRef.path, `${namespace}/${name}@${version}`);
    changed = true;
  }

  if (!changed) return content;
  return docs.map((d) => d.toString()).join("---\n");
}

// ---------------------------------------------------------------------------
// Telo registry push
// ---------------------------------------------------------------------------

const MAX_PUSH_ATTEMPTS = 4;
const PUSH_BASE_DELAY_MS = 1000;

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pushToTeloRegistry(
  content: string,
  filePath: string,
  registry: string,
  log: Logger,
  push: { body: string | Buffer; contentType: string; urlSuffix: string } = {
    body: content,
    contentType: "text/yaml",
    urlSuffix: "",
  },
): Promise<{ ok: boolean; label: string; url: string }> {
  const firstDoc =
    content.split(/^---$/m)[0].trim() || content.split(/^---\n/m)[1]?.trim() || content;

  const nsMatch = firstDoc.match(/^\s{2,4}namespace:\s*["']?([^\s"']+)["']?/m);
  const nameMatch = firstDoc.match(/^\s{2,4}name:\s*["']?([^\s"']+)["']?/m);
  const versionMatch = firstDoc.match(/^\s{2,4}version:\s*["']?([^\s"']+)["']?/m);

  const namespace = nsMatch?.[1];
  const name = nameMatch?.[1];
  const version = versionMatch?.[1];

  if (!namespace || !name || !version) {
    console.error(
      log.error("error") +
        `  ${filePath}: metadata must include namespace, name, and version.\n` +
        `  Found: namespace=${namespace ?? "(missing)"}, name=${name ?? "(missing)"}, version=${version ?? "(missing)"}`,
    );
    return { ok: false, label: "", url: "" };
  }

  const base = `${registry.replace(/\/$/, "")}/${namespace}/${name}/${version}`;
  const url = `${base}${push.urlSuffix}`;
  const label = `${namespace}/${name}@${version}`;

  const headers: Record<string, string> = { "content-type": push.contentType };
  const token = process.env.TELO_REGISTRY_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;

  let res: Response | null = null;
  let networkErr: unknown = null;

  for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
    networkErr = null;
    try {
      res = await fetch(url, { method: "PUT", headers, body: push.body as BodyInit });
    } catch (err) {
      networkErr = err;
      res = null;
    }

    const transient = networkErr != null || (res != null && isRetryableStatus(res.status));
    if (!transient) break;
    if (attempt === MAX_PUSH_ATTEMPTS) break;

    const reason = networkErr
      ? `network error: ${networkErr instanceof Error ? networkErr.message : String(networkErr)}`
      : `HTTP ${res!.status}`;

    // Drain the body so the underlying connection can be reused for the retry.
    if (res) await res.text().catch(() => {});

    const delay = PUSH_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
    console.error(
      `    ${"retry".padEnd(STEP_WIDTH)}${log.warn(reason)}  attempt ${attempt}/${MAX_PUSH_ATTEMPTS - 1}, waiting ${Math.round(delay / 100) / 10}s`,
    );
    await sleep(delay);
  }

  if (networkErr) {
    console.error(
      log.error("error") +
        `  Network error: ${networkErr instanceof Error ? networkErr.message : String(networkErr)} (after ${MAX_PUSH_ATTEMPTS} attempts)`,
    );
    return { ok: false, label, url };
  }

  if (!res!.ok) {
    const contentType = res!.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json") ? await res!.json() : await res!.text();
    console.error(log.error("error") + `  Push failed (${res!.status}): ${JSON.stringify(body)}`);
    return { ok: false, label, url };
  }

  return { ok: true, label, url };
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
  registry: string,
  bump: BumpLevel | undefined,
  dryRun: boolean,
  skipControllers: boolean,
  log: Logger,
): Promise<boolean> {
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
  const analysisLoader = new Loader([localFileSource, ...defaultSources()]);
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
  const analysisManifests = flattenForAnalyzer(analysisGraph);
  const diagnostics = new StaticAnalyzer().analyze(analysisManifests);
  const { errorCount } = formatAnalysisDiagnostics(diagnostics, analysisGraph, log, filePath);
  if (errorCount > 0) {
    return false;
  }
  stepOk(log, "check", "static analysis passed");

  // Canonicalize relative `imports:` sources to `<namespace>/<name>@<version>`
  // so the registry artifact is portable. Done after analysis so the dev's on-disk
  // manifest (with relative paths) is what gets validated. Reuses the analysis
  // loader so sibling-library reads are cache hits.
  try {
    content = await canonicalizeRelativeImports(content, filePath, analysisLoader, localFileSource);
  } catch (err) {
    console.error(
      log.error("error") +
        `  Failed to canonicalize relative imports: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
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
    stepDry(log, "push", "Telo registry");
    return true;
  }

  let push: { body: string | Buffer; contentType: string; urlSuffix: string } | undefined;
  if (bundledFiles.length > 0) {
    const tarGz = await makeTarGz([
      { name: "telo.yaml", content },
      ...bundledFiles.map((rel) => ({
        name: rel,
        content: fs.readFileSync(path.resolve(manifestDir, rel)),
      })),
    ]);
    stepOk(log, "bundle", `${bundledFiles.length} file(s) + telo.yaml`);
    push = { body: tarGz, contentType: "application/gzip", urlSuffix: "/module.tar.gz" };
  }

  const { ok, label, url } = await pushToTeloRegistry(content, filePath, registry, log, push);
  if (!ok) return false;

  stepOk(log, "push", `${label} → ${url}`);
  return true;
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
}): Promise<void> {
  if (argv.bump && argv.skipControllers) {
    console.error("error: --bump and --skip-controllers are mutually exclusive");
    process.exit(1);
  }

  const log = createLogger(false);
  let failed = false;
  for (const p of argv.paths) {
    const filePath = path.resolve(process.cwd(), p);
    const relPath = path.relative(process.cwd(), filePath);
    console.log(`\nPublishing ${log.dim(relPath)}`);
    const ok = await publishOne(
      filePath,
      argv.registry,
      argv.bump,
      argv.dryRun,
      argv.skipControllers,
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
    "Publish one or more module manifests to the Telo registry",
    (y) =>
      y
        .positional("paths", {
          describe: "Paths to telo.yaml files to publish",
          type: "string",
          array: true,
          demandOption: true,
        })
        .option("registry", {
          type: "string",
          default: "https://registry.telo.run",
          describe: "Registry base URL",
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
            "Skip controller build/publish/PURL rewrite; only run static analysis and push the manifest to the Telo registry",
        }),
    async (argv) => {
      await publish(argv as any);
    },
  );
}
