import * as fs from "fs";
import { PackageURL } from "packageurl-js";
import * as path from "path";
import { minimatch } from "minimatch";
import { Loader, StaticAnalyzer } from "@telorun/analyzer";
import { LocalFileAdapter } from "@telorun/kernel";
import { parseAllDocuments } from "yaml";
import type { Argv } from "yargs";
import { createLogger, formatAnalysisDiagnostics, type Logger } from "../logger.js";
import type { BumpLevel, ParsedController } from "../publishers/interface.js";
import { getPublisher } from "../publishers/registry.js";

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

function expandAndInlineIncludes(content: string, manifestDir: string): string {
  // Parse the first YAML document to extract include patterns
  const docs = parseAllDocuments(content);
  const firstParsed = docs[0]?.toJSON();
  if (!firstParsed || !Array.isArray(firstParsed.include) || firstParsed.include.length === 0) {
    return content;
  }

  const patterns: string[] = firstParsed.include.filter(
    (p: unknown): p is string => typeof p === "string",
  );
  if (patterns.length === 0) return content;

  // Expand globs against the manifest directory
  const hasGlobs = patterns.some((p) => /[*?{}\[\]]/.test(p));
  let resolvedFiles: string[];

  if (hasGlobs) {
    const entries = fs.readdirSync(manifestDir, { recursive: true, withFileTypes: true });
    const normalizedPatterns = patterns.map((p) => p.replace(/\\/g, "/").replace(/^\.\//, ""));
    resolvedFiles = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const relative = path.relative(manifestDir, path.join(entry.parentPath, entry.name));
      const normalized = relative.replace(/\\/g, "/");
      if (normalizedPatterns.some((p) => minimatch(normalized, p))) {
        resolvedFiles.push(path.resolve(manifestDir, relative));
      }
    }
    resolvedFiles.sort();
  } else {
    resolvedFiles = [...new Set(patterns.map((p) => path.resolve(manifestDir, p)))];
  }

  // Validate all resolved paths exist and stay within the module directory
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

// ---------------------------------------------------------------------------
// Telo registry push
// ---------------------------------------------------------------------------

async function pushToTeloRegistry(
  content: string,
  filePath: string,
  registry: string,
  log: Logger,
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

  const url = `${registry.replace(/\/$/, "")}/${namespace}/${name}/${version}`;
  const label = `${namespace}/${name}@${version}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "PUT",
      headers: { "content-type": "text/yaml" },
      body: content,
    });
  } catch (err) {
    console.error(
      log.error("error") + `  Network error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, label, url };
  }

  if (!res.ok) {
    const contentType = res.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json") ? await res.json() : await res.text();
    console.error(log.error("error") + `  Push failed (${res.status}): ${JSON.stringify(body)}`);
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

  const uniqueControllers = Array.from(byLocalPath.values());

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
  const analysisLoader = new Loader([new LocalFileAdapter()]);
  let analysisManifests;
  try {
    analysisManifests = await analysisLoader.loadManifests(filePath);
  } catch (err) {
    console.error(
      log.error("error") +
        `  Failed to load manifest for analysis: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
  const diagnostics = new StaticAnalyzer().analyze(analysisManifests);
  const { errorCount } = formatAnalysisDiagnostics(diagnostics, analysisManifests, log, filePath);
  if (errorCount > 0) {
    return false;
  }
  stepOk(log, "check", "static analysis passed");

  // Expand include globs and inline partial file contents before pushing
  content = expandAndInlineIncludes(content, manifestDir);

  if (dryRun) {
    stepDry(log, "push", "Telo registry");
    return true;
  }

  const { ok, label, url } = await pushToTeloRegistry(content, filePath, registry, log);
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
}): Promise<void> {
  const log = createLogger(false);
  let failed = false;
  for (const p of argv.paths) {
    const filePath = path.resolve(process.cwd(), p);
    const relPath = path.relative(process.cwd(), filePath);
    console.log(`\nPublishing ${log.dim(relPath)}`);
    const ok = await publishOne(filePath, argv.registry, argv.bump, argv.dryRun, log);
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
        }),
    async (argv) => {
      await publish(argv as any);
    },
  );
}
