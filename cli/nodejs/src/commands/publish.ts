import * as fs from "fs";
import { PackageURL } from "packageurl-js";
import * as path from "path";
import { DEFAULT_MANIFEST_FILENAME, Loader, PUBLISH_BLOCKING_CODES, StaticAnalyzer, TELO_SURFACE_VERSION, collectModuleDocuments, flattenForAnalyzer, splitIntegrity, type LoadedGraph } from "@telorun/analyzer";
import { LocalFileSource, defaultTransportRegistry, resolveCacheRoot } from "@telorun/kernel";
import { defaultCustomTags } from "@telorun/templating";
import { parseAllDocuments } from "yaml";
import { fetchManifestHash } from "../manifest-hash.js";
import {
  PublishFailure,
  publishFailureReport,
  type PublishFailureCode,
  type PublishFailureReport,
} from "../publish-failure.js";
import type { Argv } from "yargs";
import { findModuleDoc, importSourceRefs } from "./manifest-imports.js";
import { readOwnerVersion } from "../bundle/manifest-text.js";
import {
  describeVersionSkew,
  isPublished,
  ownedNpmPackages,
  publishPackage,
} from "../release/npm-controller-package.js";
import { pushableLayers } from "../bundle/built-layers.js";
import { ModulePayloadBuilder, type ModulePayload } from "../bundle/module-payload.js";
import { describePartition } from "../bundle/partition-layers.js";
import { checkPublishedPin, describePinMove, manifestPin } from "../bundle/payload-drift.js";
import { parseAnnotationFlags } from "../publish-annotations.js";
import { createLogger, formatAnalysisDiagnostics, type Logger } from "../logger.js";
import { outEmit, outErrLine, outLine } from "../output.js";
import type { BumpLevel, ParsedController } from "../publishers/interface.js";
import { getPublisher } from "../publishers/registry.js";
import {
  publishedTeloVersions,
  unpublishedUpperBound,
  verifyRequires,
} from "../release/verify-requires.js";

// The manifest-text transforms moved to `bundle/manifest-text.ts` so `telo
// release` computes the published bytes the same way this command does. Kept
// exported here because they were part of this module's surface.
export {
  expandAndInlineIncludes,
  readAssetPatterns,
  readFilesPatterns,
} from "../bundle/manifest-text.js";

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
// Import pin verification
//
// Pinning is authoring-time work now: `telo install` / `telo upgrade` write a
// dependency's integrity beside its ref, and the payload builder REFUSES a
// remote import that carries none. What is left for publish is the other half —
// checking that the hash the author committed still describes what the origin
// serves.
//
// It replaced a best-effort fetch-and-pin. That branch decided the published
// bytes from network reachability, and swallowed an unresolvable import into a
// silently unpinned artifact — an importer's Merkle chain quietly missing a link.
// ---------------------------------------------------------------------------

/** Exported under a test-only name because the check is publish-internal but
 *  its regression — a comparison that silently never ran — is only observable
 *  through it. */
export const verifyImportPinsForTest = verifyImportPins;

async function verifyImportPins(payload: ModulePayload, log: Logger): Promise<void> {
  for (const { alias, ref, integrity } of payload.authoredPins) {
    let actual: string;
    try {
      actual = await fetchManifestHash(ref);
    } catch (err) {
      throw new PublishFailure(
        "import_unreachable",
        `import '${alias}' (${ref}) could not be read to verify its pin: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        { alias, ref },
      );
    }
    if (actual !== integrity) {
      throw new PublishFailure(
        "import_pin_mismatch",
        `import '${alias}' is pinned to ${integrity}, but ${ref} now serves ${actual}. ` +
          `A pin is what makes this artifact reproducible, so publishing over the disagreement ` +
          `would embed a claim that is already false. Re-pin with \`telo upgrade\` if the move ` +
          `is intended.`,
        { alias, ref },
      );
    }
    stepOk(log, "pin", `${alias} verified`);
  }
}


// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const STEP_WIDTH = 9; // "publish  " column width

function step(log: Logger, label: string, status: string) {
  outLine(`    ${label.padEnd(STEP_WIDTH)}${status}`);
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

/**
 * Verify the entry module's declared `requires.telo` before publishing it.
 *
 * Two rules, failing in opposite directions on purpose:
 *
 *  - **A refuted range is fatal.** The edge CLI ran and rejected the manifest,
 *    so the declaration is false and publishing it would put a claim in the
 *    registry that `upgrade` and every consumer's load gate then act on.
 *  - **An unverifiable one warns.** A CLI that could not be installed leaves the
 *    claim unproven, not disproven, and blocking a publish on registry
 *    reachability trades one failure for a worse one.
 *
 * The upper-bound existence check follows the same split: a bound naming a
 * version npm does not have is fatal (an unverifiable bound is what the grammar
 * forbids), while an unreachable registry warns, since the rule gates a bound
 * absent from almost every module.
 */
async function verifyDeclaredRequirements(
  filePath: string,
  graph: LoadedGraph,
  log: Logger,
): Promise<boolean> {
  const ownerDoc = graph.entry.owner.manifests.find(
    (m) => m?.kind === "Telo.Application" || m?.kind === "Telo.Library",
  );
  if (!ownerDoc) return true;

  // The published list is fetched BEFORE the edges run, so an edge naming a
  // version that does not exist yet is reported as pending rather than spawning
  // an `npx` that can only ETARGET. Memoized process-wide, so publishing the
  // whole standard library asks once.
  const published = await publishedTeloVersions();
  const result = await verifyRequires(filePath, ownerDoc as unknown as Record<string, unknown>, {
    currentVersion: TELO_SURFACE_VERSION,
    publishedVersions: published,
  });
  if (!result.declared) {
    // Absent means no requirement — permanent for everything published before
    // this mechanism existed, and correct, since none of it uses syntax that did
    // not yet exist.
    return true;
  }

  const refuted = result.outcomes.filter((o) => o.status === "failed");
  for (const outcome of refuted) {
    outErrLine(
      `${log.err.error("error")}  requires.telo '${result.declared.raw}' is not true: ` +
        `telo ${outcome.edge} rejects this manifest.`,
    );
    outErrLine(indent(outcome.output));
  }
  if (refuted.length > 0) {
    outErrLine(
      `${log.err.dim("")}  Raise the bound to a version that accepts it, or stop using the ` +
        `syntax that version cannot read.`,
    );
    return false;
  }

  // A lower bound above everything published is fatal HERE and informational at
  // `telo release check`, and the asymmetry is the release order: npm publishes
  // before modules do, so by the time a module is pushed its declared minimum
  // exists. If it does not, the release is out of order — and the module would
  // land at the registry declaring a floor no runtime can satisfy, which every
  // consumer's `telo upgrade` would then refuse.
  const pending = result.outcomes.find((o) => o.status === "pending");
  if (pending?.status === "pending") {
    outErrLine(
      `${log.err.error("error")}  requires.telo '${result.declared.raw}' needs telo ` +
        `${pending.edge}, which is not published — the latest is ${pending.latestPublished}. ` +
        `Publish the CLI release that carries it first, or lower the bound to a version that ` +
        `exists.`,
    );
    return false;
  }

  const missing = unpublishedUpperBound(result.declared, published);
  if (missing) {
    outErrLine(
      `${log.err.error("error")}  requires.telo '${result.declared.raw}' bounds above ` +
        `${missing}, which is not a published telo version. An upper bound must name a version ` +
        `that already exists — a bound nothing can run is a bound nothing can verify.`,
    );
    return false;
  }

  const unavailable = result.outcomes.filter((o) => o.status === "unavailable");
  for (const outcome of unavailable) {
    stepWarn(log, "requires", `could not run telo ${outcome.edge} (${outcome.reason})`);
  }
  if (published === null) {
    stepWarn(log, "requires", "could not reach npm to check the upper bound");
  }
  if (unavailable.length === 0 && result.outcomes.length > 0) {
    stepOk(
      log,
      "requires",
      `telo ${result.declared.raw} verified at ${result.outcomes.map((o) => o.edge).join(", ")}`,
    );
  } else if (result.outcomes.length === 0) {
    // Open above and the low edge is this CLI: HEAD is the only edge, and the
    // static analysis that just passed IS that check.
    stepOk(log, "requires", `telo ${result.declared.raw}`);
  }
  return true;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Main per-manifest publish
// ---------------------------------------------------------------------------

/** What one manifest's publish produced: whether it succeeded, and the complete
 *  annotation set it pushed (or would push, under `--dry-run`) once that set was
 *  known. */
type PublishOutcome =
  | {
      ok: true;
      annotations: Record<string, string>;
      /** The module's `metadata.version`, when it declares one. */
      version?: string;
      /** The pin of the published `telo.yaml`: what an import of it verifies. */
      integrity: string;
      /** The pushed artifact's content digest. Absent under `--dry-run`. */
      digest?: string;
      /** This version was already published with exactly these bytes. */
      identical: boolean;
    }
  | { ok: false; error: PublishFailureReport };

function refused(
  code: PublishFailureCode,
  message: string,
  details?: Record<string, unknown>,
): PublishOutcome {
  return { ok: false, error: { code, message, ...(details ? { details } : {}) } };
}

async function publishOne(
  filePath: string,
  destination: string,
  bump: BumpLevel | undefined,
  dryRun: boolean,
  skipControllers: boolean,
  authoredAnnotations: Readonly<Record<string, string>>,
  log: Logger,
): Promise<PublishOutcome> {
  // A directory argument resolves to its telo.yaml — standard Telo path
  // resolution, matching `run` / `check` (LocalFileSource stats a dir → telo.yaml).
  try {
    if (fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, DEFAULT_MANIFEST_FILENAME);
    }
  } catch {
    outErrLine(log.err.error("error") + `  Cannot read file: ${filePath}`);
    return refused("module_not_found", `Cannot read file: ${filePath}`);
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    outErrLine(log.err.error("error") + `  Cannot read file: ${filePath}`);
    return refused("module_not_found", `Cannot read file: ${filePath}`);
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

    outLine(`\n  ${log.dim(ctrl.packageName)}`);

    if (!publisher) {
      step(log, "publish", log.warn("skipped") + `  no publisher for type "${ctrl.type}"`);
      continue;
    }

    if (!fs.existsSync(ctrl.localPath)) {
      step(log, "publish", log.error("error") + `  local_path not found: ${ctrl.localPath}`);
      return refused("publish_failed", `controller local_path not found: ${ctrl.localPath}`);
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
        outErrLine(
          (err instanceof Error ? err.message : String(err))
            .split("\n")
            .map((l) => `      ${l}`)
            .join("\n"),
        );
        return refused(
          "publish_failed",
          `building ${ctrl.packageName} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
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
  outLine(`\n  ${log.dim("manifest")}`);

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
  // analyzer's `defaultSources()` (HTTP only) cannot resolve an OCI import, so
  // an `oci://` dependency (pinned or not) fails to load for analysis.
  const analysisLoader = new Loader([localFileSource, ...defaultTransportRegistry().sources()]);
  let analysisGraph;
  try {
    // `desugarImports` so inline `imports:` maps expand into synthetic
    // Telo.Import manifests and the imported kinds resolve during analysis.
    analysisGraph = await analysisLoader.loadGraph(filePath, { desugarImports: true, migrate: true });
    if (analysisGraph.errors.length > 0) throw analysisGraph.errors[0].error;
  } catch (err) {
    outErrLine(
      log.err.error("error") +
        `  Failed to load manifest for analysis: ${err instanceof Error ? err.message : String(err)}`,
    );
    return refused(
      "manifest_invalid",
      `Failed to load manifest for analysis: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // A parse failure yields a mangled manifest tree; analyzing it would drown the
  // real error under spurious schema violations. Report the parse diagnostics
  // and stop before analysis — mirrors the kernel's load-time short-circuit.
  if (analysisGraph.parseDiagnostics.length > 0) {
    const parsed = formatAnalysisDiagnostics(
      analysisGraph.parseDiagnostics,
      analysisGraph,
      log,
      filePath,
    );
    return refused("manifest_invalid", "the manifest does not parse", {
      diagnostics: parsed.diagnostics,
    });
  }
  const analysisManifests = flattenForAnalyzer(analysisGraph);
  const diagnostics = new StaticAnalyzer().analyze(analysisManifests, {
    moduleDocuments: collectModuleDocuments(analysisGraph),
  });
  const { errorCount, diagnostics: located } = formatAnalysisDiagnostics(
    diagnostics,
    analysisGraph,
    log,
    filePath,
  );
  if (errorCount > 0) {
    return refused(
      "manifest_invalid",
      `static analysis reported ${errorCount} error${errorCount !== 1 ? "s" : ""}`,
      { diagnostics: located.filter((d) => d.severity === "error") },
    );
  }
  // Some diagnostics are warnings while a manifest merely runs and fatal the
  // moment it is published. Descriptive metadata is the case: nothing reads
  // `version` or `license` at runtime, so refusing to start an app over one is
  // worse than the mistake — but publish is where those fields become the
  // module's public face, projected onto the artifact's annotations and indexed
  // by the hub, and a wrong one there is permanent for that version.
  const blocking = diagnostics.filter(
    (d) => typeof d.code === "string" && PUBLISH_BLOCKING_CODES.has(d.code),
  );
  if (blocking.length > 0) {
    outErrLine(
      `${log.err.error("error")}  ${blocking.length} metadata problem${blocking.length !== 1 ? "s" : ""} must be fixed before publishing ` +
        `(reported as warnings above). These fields describe the module to everyone who finds it, ` +
        `and this version's copy of them cannot be changed once published.`,
    );
    return refused(
      "manifest_invalid",
      `${blocking.length} metadata problem${blocking.length !== 1 ? "s" : ""} must be fixed before publishing`,
      {
        diagnostics: located.filter(
          (d) => d.code !== undefined && PUBLISH_BLOCKING_CODES.has(d.code),
        ),
      },
    );
  }
  stepOk(log, "check", "static analysis passed");

  // Declared runtime requirements: verify the module's own `requires.telo` range
  // by RUNNING the CLI at each edge of it. Publishing is where the claim becomes
  // consequential — a consumer resolves against it and is told, at load, that
  // this version needs a newer runtime — so it is where an unverified claim must
  // be caught. Without this the declaration is only as honest as each
  // publisher's CI, and a wrong one hands a consumer a confusing failure instead
  // of a clear one, which is the exact outcome the mechanism exists to remove.
  if (!(await verifyDeclaredRequirements(filePath, analysisGraph, log))) {
    return refused(
      "requires_refuted",
      "the module's declared `requires.telo` range does not hold; see the report on stderr",
    );
  }

  // Build exactly what will be pushed, through the shared payload builder — the
  // same computation `telo release` digests, so the ledger's number and the
  // registry's are answers to one question. It canonicalizes relative imports,
  // derives each sibling's pin from the sibling's own published bytes, refuses a
  // remote import the author left unpinned, inlines `include:` partials, and
  // BUILDS every bundled controller from source rather than reading a
  // gitignored artifact that may be stale or absent.
  let payload: ModulePayload;
  try {
    payload = await new ModulePayloadBuilder({
      cacheRoot: resolveCacheRoot(filePath) ?? path.join(manifestDir, ".telo"),
      // The bytes that ship: every staged file verified against its pin and
      // framed, so each `blob` and every sibling pin is the registry's.
      stagedFiles: "disk",
    }).payload(filePath, destination);
  } catch (err) {
    outErrLine(log.err.error("error") + `  ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, error: publishFailureReport(err) };
  }
  content = payload.manifest;
  const partition = payload.partition;
  const layers = payload.layers;

  // Strict: a published app does not publish its siblings, so every ref derived
  // from a relative import must already resolve at its published location — a
  // dangling one is a hard error (publish the sibling first, or earlier in this
  // invocation). Skipped on --dry-run (nothing is published yet).
  if (!dryRun) {
    const transports = defaultTransportRegistry();
    // Every unpublished sibling is named, not only the first: the remedy is to
    // publish them, and a reader told one at a time publishes one at a time.
    const unpublished: string[] = [];
    for (const { ref } of payload.relativeImports) {
      try {
        const transport = transports.forRef(ref);
        if (!transport) throw new Error(`no transport owns '${ref}'`);
        await transport.source.read(ref);
      } catch (err) {
        outErrLine(
          log.err.error("error") +
            `  relative import canonicalized to '${ref}', which does not resolve at its published ` +
            `location — publish the sibling first. Cause: ${err instanceof Error ? err.message : String(err)}`,
        );
        unpublished.push(ref);
      }
    }
    if (unpublished.length > 0) {
      return refused(
        "sibling_not_published",
        `${unpublished.length} imported sibling${unpublished.length !== 1 ? "s do" : " does"} not resolve at ` +
          `${unpublished.length !== 1 ? "their" : "its"} published location — publish ${unpublished.length !== 1 ? "them" : "it"} first`,
        { refs: unpublished },
      );
    }

    // Every author-written pin still describes what the registry serves.
    try {
      await verifyImportPins(payload, log);
    } catch (err) {
      outErrLine(log.err.error("error") + `  ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, error: publishFailureReport(err) };
    }
  }


  // The pin, not a ledger: a version already published must be republished
  // byte-for-byte or not at all, because every import pinned to it verifies
  // against its telo.yaml. Runs before the push (and on --dry-run) so the
  // release fails while it is still a fixable working copy.
  const version = readOwnerVersion(content);
  const integrity = await manifestPin(content);
  let identical = false;
  if (version) {
    let check;
    try {
      check = await checkPublishedPin(destination, version, content, layers);
    } catch (err) {
      // A registry that could not answer is not a pass. Fail the publish and say
      // why, rather than shipping on the assumption that nothing changed.
      const message = err instanceof Error ? err.message : String(err);
      outErrLine(log.err.error("error") + `  ${message}`);
      return refused("registry_unavailable", message);
    }
    if (check.status === "moved") {
      const message = describePinMove(destination, version, check);
      outErrLine(log.err.error("error") + `  ${message}`);
      return refused("version_content_mismatch", message, {
        version,
        publishedIntegrity: check.publishedPin,
        builtIntegrity: check.builtPin,
      });
    }
    if (check.status === "identical") {
      identical = true;
      stepOk(log, "manifest", `identical to the published ${version} (${check.pin})`);
    }
  }

  // The complete set the push writes: what the transport derives from
  // `metadata`, plus exactly this invocation's annotations.
  let annotations: Record<string, string>;
  try {
    annotations = defaultTransportRegistry().publishedAnnotations(
      destination,
      content,
      authoredAnnotations,
    );
  } catch (err) {
    outErrLine(log.err.error("error") + `  ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, error: publishFailureReport(err) };
  }

  // A module whose controller is delivered from npm has to push that tarball
  // too, and before the manifest that names it — otherwise the artifact points
  // at a version npm has never seen. Skipped with `--skip-controllers`, which
  // already names this step.
  if (!skipControllers) {
    const owned = ownedNpmPackages(controllers, path.dirname(filePath));
    for (const pkg of owned) {
      const skew = describeVersionSkew(pkg, version);
      if (skew) {
        outErrLine(log.err.error("error") + `  ${skew}`);
        return refused("publish_failed", skew);
      }
      if (await isPublished(pkg.name, pkg.packageVersion)) {
        stepOk(log, "npm", `${pkg.name}@${pkg.packageVersion} already published`);
        continue;
      }
      if (dryRun) {
        stepDry(log, "npm", `publish ${pkg.name}@${pkg.packageVersion}`);
        continue;
      }
      try {
        await publishPackage(pkg);
      } catch (err) {
        outErrLine(
          log.err.error("error") +
            `  npm publish ${pkg.name}@${pkg.packageVersion} failed: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        return refused(
          "publish_failed",
          `npm publish ${pkg.name}@${pkg.packageVersion} failed: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
      stepOk(log, "npm", `${pkg.name}@${pkg.packageVersion} published`);
    }
  }

  if (dryRun) {
    for (const line of describePartition(partition)) stepDry(log, "layer", line);
    for (const [key, value] of Object.entries(annotations)) stepDry(log, "annotate", `${key}=${value}`);
    stepDry(log, "push", destination);
    return { ok: true, annotations, version, integrity, identical };
  }

  for (const line of describePartition(partition)) stepOk(log, "layer", line);
  for (const [key, value] of Object.entries(annotations)) stepOk(log, "annotate", `${key}=${value}`);

  // The transport pushes each layer as its own blob, injects the resulting
  // `layers:` index into the manifest, and pushes the manifest layer last.
  let result;
  try {
    result = await defaultTransportRegistry().publish(
      destination,
      { manifest: content, layers: pushableLayers(layers) },
      {
        annotations: authoredAnnotations,
        onRetry: ({ reason, attempt, maxAttempts, delayMs }) =>
          outErrLine(
            `    ${"retry".padEnd(STEP_WIDTH)}${log.err.warn(reason)}  attempt ${attempt}/${maxAttempts - 1}, ` +
              `waiting ${Math.round(delayMs / 100) / 10}s`,
          ),
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    outErrLine(log.err.error("error") + `  ${message}`);
    return refused("registry_unavailable", message);
  }

  stepOk(log, "push", `${result.label} → ${result.url}`);
  return { ok: true, annotations, version, integrity, digest: result.digest, identical };
}

// ---------------------------------------------------------------------------
// Destination-first positional — `telo publish <destination> <paths…>`. The
// destination is an OCI repo (`oci://host/repo`); publishing over plain HTTP has
// been removed. A leading positional is classified so an old-style HTTP
// destination gets a clear error rather than being read as a path.
// ---------------------------------------------------------------------------

type DestinationKind = "oci" | "http" | null;

function classifyDestination(arg: string): DestinationKind {
  if (arg.startsWith("oci://")) return "oci";
  if (arg.startsWith("http://") || arg.startsWith("https://")) return "http";
  if (arg.startsWith(".") || arg.startsWith("/")) return null;
  if (fs.existsSync(arg)) return null; // a real local file/dir wins
  if (arg.endsWith(".yaml") || arg.endsWith(".yml")) return null;
  // Host-like bare destination (the old HTTP form, e.g. ghcr.io is written
  // `oci://…`). First path segment carries a dot.
  return arg.split("/")[0].includes(".") ? "http" : null;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function publish(argv: {
  paths: string[];
  bump?: BumpLevel;
  dryRun: boolean;
  skipControllers: boolean;
  /** Every `--annotation` occurrence; yargs yields one string for a single use. */
  annotation?: string | string[];
}): Promise<void> {
  if (argv.bump && argv.skipControllers) {
    outErrLine("error: --bump and --skip-controllers are mutually exclusive");
    process.exit(1);
  }

  // The push destination is the leading positional, an OCI repo.
  let paths = argv.paths;
  let destination: string | undefined;
  if (paths.length > 0) {
    const kind = classifyDestination(paths[0]);
    if (kind === "http") {
      outErrLine(
        "error: publishing over plain HTTP has been removed. " +
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
    outErrLine(
      "error: no publish destination — pass an OCI repo as the first argument, " +
        "e.g. `telo publish oci://ghcr.io/<org>/<name> ./telo.yaml`.",
    );
    process.exit(1);
  }
  if (paths.length === 0) {
    outErrLine("error: no manifest paths to publish");
    process.exit(1);
  }

  // Before anything is built or fetched: a refused annotation is a typo in the
  // command line, and finding it after a full build wastes the build.
  let authoredAnnotations: Record<string, string>;
  try {
    authoredAnnotations = parseAnnotationFlags(
      argv.annotation === undefined ? [] : [argv.annotation].flat(),
    );
    defaultTransportRegistry().checkAuthoredAnnotations(destination, authoredAnnotations);
  } catch (err) {
    outErrLine(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const log = createLogger(false);
  let failed = false;
  const published: string[] = [];
  const failures: string[] = [];
  const annotations: Record<string, Record<string, string>> = {};
  const modules: Array<Record<string, unknown>> = [];
  for (const p of paths) {
    const filePath = path.resolve(process.cwd(), p);
    const relPath = path.relative(process.cwd(), filePath);
    outLine(`\nPublishing ${log.dim(relPath)}${log.dim(` → ${destination}`)}`);
    const outcome = await publishOne(
      filePath,
      destination,
      argv.bump,
      argv.dryRun,
      argv.skipControllers,
      authoredAnnotations,
      log,
    );
    (outcome.ok ? published : failures).push(relPath);
    if (outcome.ok) {
      annotations[relPath] = outcome.annotations;
      modules.push({
        path: relPath,
        ok: true,
        version: outcome.version ?? null,
        digest: outcome.digest ?? null,
        integrity: outcome.integrity,
        identical: outcome.identical,
      });
    } else {
      failed = true;
      modules.push({ path: relPath, ok: false, error: outcome.error });
    }
  }
  outLine("");
  outEmit({
    ok: !failed,
    destination,
    dryRun: argv.dryRun ?? false,
    published,
    failed: failures,
    annotations,
    // One entry per manifest, in the order given: a stable failure code, or the
    // version, digest and integrity of what was pushed.
    modules,
  });
  // `process.exitCode`, not `process.exit()`: the structured payload was just
  // written, and on a pipe `write` is asynchronous while `exit` does not flush. A
  // large diagnostic set exceeds the 64 KB pipe buffer, and truncated JSON is a
  // parse failure for the one consumer this format exists for. Returning lets
  // the event loop drain.
  if (failed) process.exitCode = 1;
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
        .option("annotation", {
          type: "string",
          requiresArg: true,
          describe:
            "Write <key>=<value> onto the pushed OCI manifest (repeatable; a reverse-domain key). " +
            "Replaces the annotations a republish carried; the ones telo derives from metadata are refused",
        })
        .option("skip-controllers", {
          type: "boolean",
          default: false,
          describe:
            "Skip controller build/publish/PURL rewrite; only run static analysis and push the manifest to the OCI registry",
        }),
    // `--frozen` is gone rather than kept as a no-op: it selected between
    // best-effort pinning and a hard error, and best-effort no longer exists.
    // An unpinned remote import is always refused and every author-written pin
    // is always verified, so the flag named a choice there is nothing left to
    // make — and its help text said the opposite of what now happens.
    async (argv) => {
      await publish(argv as any);
    },
  );
}
