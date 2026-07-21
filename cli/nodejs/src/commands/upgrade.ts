import { isLocalPathSource, splitIntegrity } from "@telorun/analyzer";
import { defaultTransportRegistry, type Transport } from "@telorun/kernel";
import { defaultCustomTags } from "@telorun/templating";
import * as fs from "fs";
import * as path from "path";
import semver from "semver";
import { parseAllDocuments } from "yaml";
import type { Argv } from "yargs";
import { createLogger, type Logger } from "../logger.js";
import { findModuleDoc, importSourceRefs, type ImportSourceRef } from "./manifest-imports.js";

const DEFAULT_REGISTRY_URL = "https://registry.telo.run";

/** The version-independent label for a versioned `source`, for diagnostics —
 *  the ref with its exact `@<rawVersion>` suffix and any integrity fragment
 *  stripped (`std/run`, `oci://ghcr.io/telorun/http-server`). */
function refLabel(source: string, rawVersion: string): string {
  const base = splitIntegrity(source).base;
  const suffix = `@${rawVersion}`;
  return base.endsWith(suffix) ? base.slice(0, -suffix.length) : base;
}

/** Exported for tests. */
export function pickLatest(versions: string[], includePrerelease: boolean): string | null {
  const eligible = includePrerelease
    ? versions
    : versions.filter((v) => semver.prerelease(v) === null);
  if (eligible.length === 0) return null;
  // semver.rcompare puts the highest precedence first.
  return [...eligible].sort(semver.rcompare)[0];
}

interface ImportUpgrade {
  packagePath: string;
  from: string;
  to: string;
}

interface UpgradeResult {
  changed: boolean;
  upgrades: ImportUpgrade[];
  /** Imports already at the latest version that were newly pinned (integrity
   *  hash added without a version change). */
  pinned: number;
  unchanged: number;
  skipped: number;
  errors: number;
}

/** Mirror LocalFileSource: a directory path resolves to `<dir>/telo.yaml`. */
function resolveManifestPath(inputPath: string): { filePath: string; error?: string } {
  const resolved = path.resolve(process.cwd(), inputPath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch (err) {
    return { filePath: resolved, error: err instanceof Error ? err.message : String(err) };
  }
  if (stat.isDirectory()) {
    return { filePath: path.join(resolved, "telo.yaml") };
  }
  return { filePath: resolved };
}

/**
 * Pure string-in / string-out core of the upgrade command. No filesystem
 * access — `upgradeOne` is the disk-backed wrapper. Exported so tests can
 * exercise the parse / fetch / decision pipeline without a tmpdir.
 *
 * The returned `content` is the rewritten YAML when `result.changed === true`,
 * and the original `content` (byte-identical) when nothing matched.
 */
export async function upgradeManifest(args: {
  content: string;
  registryUrl: string;
  includePrerelease: boolean;
  log: Logger;
  /** Optional label printed in the "Upgrading <name>" header. */
  displayName?: string;
  /** When set, local sibling imports are followed by the caller — so they are
   *  neither counted nor reported as skipped here. */
  recursive?: boolean;
}): Promise<{ content: string; result: UpgradeResult; relativeImports: string[] }> {
  const { content, registryUrl, includePrerelease, log, displayName, recursive } = args;

  const result: UpgradeResult = {
    changed: false,
    upgrades: [],
    pinned: 0,
    unchanged: 0,
    skipped: 0,
    errors: 0,
  };

  const registry = defaultTransportRegistry(registryUrl);
  const docs = parseAllDocuments(content, { customTags: defaultCustomTags() });

  if (displayName !== undefined) {
    console.log(`\nUpgrading ${log.dim(displayName)}`);
  }

  // Collect text-level edits as we walk the parsed docs. We never call
  // `Document.toString()` — that path would re-fold block scalars (`>-` / `|`),
  // drop quote-style hints, and reflow long quoted strings. Instead, each
  // accepted upgrade records the byte range of its `source:` value, and at the
  // end we splice the new pin into the original string. Everything outside
  // those exact ranges is byte-identical to the input.
  interface SourceEdit {
    /** Byte offset of the first character of the scalar's value (inclusive). */
    start: number;
    /** Byte offset one past the last character of the scalar's value. */
    end: number;
    /** The new pin, written verbatim into the slice (no quoting added). */
    newText: string;
  }
  const edits: SourceEdit[] = [];

  const moduleDoc = findModuleDoc(docs);
  const importRefs = moduleDoc ? importSourceRefs(moduleDoc) : [];
  const relativeImports = importRefs.map((r) => r.source).filter(isLocalPathSource);

  // An import already at the latest version isn't upgraded — but if it carries
  // no integrity hash yet (neither a `#sha256-...` fragment nor an object-form
  // `integrity:` sibling), pin it in place. Best-effort: a failed hash fetch
  // leaves it unpinned. This is what lets `telo upgrade` pin a rarely-changing
  // module whose version never moves.
  const ensurePinned = async (
    importRef: ImportSourceRef,
    transport: Transport,
    label: string,
    version: string,
  ): Promise<void> => {
    if (splitIntegrity(importRef.source).integrity || importRef.integrity) {
      console.log(`  ${log.ok("=")}  ${label}  ${log.dim(`already at ${version}, pinned`)}`);
      result.unchanged++;
      return;
    }
    const pinBase = transport.withVersion(importRef.source, version);
    let hash: string;
    try {
      hash = await transport.manifestHash(pinBase);
    } catch (err) {
      console.log(
        `  ${log.warn("!")}  ${label}  ${log.dim(`already at ${version}, left unpinned (${err instanceof Error ? err.message : String(err)})`)}`,
      );
      result.unchanged++;
      return;
    }
    const edit = buildSourceEdit(importRef.node, content, `${pinBase}#${hash}`);
    if (!edit) {
      console.error(
        `  ${log.error("✗")}  ${label}  source scalar has no range — skipping`,
      );
      result.errors++;
      return;
    }
    edits.push(edit);
    result.changed = true;
    result.pinned++;
    console.log(`  ${log.ok("+")}  ${label}  ${log.dim(`already at ${version},`)} ${log.ok("pinned")}`);
  };

  for (const importRef of importRefs) {
    const source = importRef.source;

    // A local sibling import (relative/absolute path) carries no version to bump
    // here. Under `--recursive` the caller descends into it, so stay silent;
    // otherwise report it skipped and point at the flag.
    if (isLocalPathSource(source)) {
      if (!recursive) {
        console.log(
          `  ${log.dim("·")}  ${source}  ${log.dim("skipped (local import — use --recursive to follow)")}`,
        );
        result.skipped++;
      }
      continue;
    }

    // The transport that owns the ref's scheme handles version enumeration,
    // reconstruction, and hashing — `upgrade` never branches on ref shape.
    const transport = registry.forRef(source);
    if (!transport) {
      console.log(`  ${log.dim("·")}  ${source}  ${log.dim("skipped (not a remote ref)")}`);
      result.skipped++;
      continue;
    }

    const rawVersion = transport.refVersion(source);
    if (rawVersion === null) {
      // Remote but not version-pinned — a bare `https://` URL, or an OCI ref
      // with no explicit reference. Nothing to compare against.
      console.log(`  ${log.dim("·")}  ${source}  ${log.dim("skipped (not version-pinned)")}`);
      result.skipped++;
      continue;
    }
    const label = refLabel(source, rawVersion);

    let published: string[] | null;
    try {
      published = await transport.listVersions(source);
    } catch (err) {
      console.error(
        `  ${log.error("✗")}  ${label}  ` + (err instanceof Error ? err.message : String(err)),
      );
      result.errors++;
      continue;
    }

    if (published === null || published.length === 0) {
      console.log(
        `  ${log.warn("!")}  ${label}  ${log.dim("no published versions in registry")}`,
      );
      result.skipped++;
      continue;
    }

    // Normalize published tags to canonical SemVer so the compare and the
    // string-equality membership test use one form (handles a `v` prefix).
    const normalized = published
      .map((v) => semver.valid(v))
      .filter((v): v is string => v !== null);

    const best = pickLatest(normalized, includePrerelease);
    if (!best) {
      // Versions exist but none pass the prerelease filter / semver parser.
      console.log(
        `  ${log.warn("!")}  ${label}  ${log.dim("no eligible versions in registry")}`,
      );
      result.skipped++;
      continue;
    }

    const currentVersion = semver.valid(rawVersion);
    if (!currentVersion) {
      // A non-SemVer pin — an OCI `sha256:` digest, a moving tag like `latest`.
      // There is no ordering to upgrade along, so leave it untouched.
      console.log(
        `  ${log.warn("!")}  ${label}  ${log.dim(`unparseable current version (${rawVersion})`)}`,
      );
      result.skipped++;
      continue;
    }

    const currentPublished = normalized.some((v) => semver.eq(v, currentVersion));
    const cmp = semver.compare(best, currentVersion);

    // Already at the latest published version (`cmp < 0` is defensive — `best`
    // is the max of `published` and `currentPublished` means the pin is in that
    // list). Nothing to upgrade; ensure it carries an integrity hash.
    if (currentPublished && cmp <= 0) {
      await ensurePinned(importRef, transport, label, currentVersion);
      continue;
    }

    // Re-pin to the new version's integrity hash. Best-effort: if the hash
    // fetch fails, still rewrite the version but leave it unpinned (warn).
    const newBase = transport.withVersion(source, best);
    let newPin = newBase;
    try {
      newPin = `${newBase}#${await transport.manifestHash(newBase)}`;
    } catch (err) {
      console.log(
        `  ${log.warn("!")}  ${label}  ${log.dim(`left unpinned (${err instanceof Error ? err.message : String(err)})`)}`,
      );
    }

    const edit = buildSourceEdit(importRef.node, content, newPin);
    if (!edit) {
      // No range info — extremely unlikely for a freshly parsed doc, but bail
      // out loudly rather than silently dropping the rewrite.
      console.error(
        `  ${log.error("✗")}  ${label}  source scalar has no range — skipping`,
      );
      result.errors++;
      continue;
    }

    edits.push(edit);
    result.changed = true;
    result.upgrades.push({ packagePath: label, from: currentVersion, to: best });

    if (currentPublished) {
      // Pinned version exists in the registry, just older — straight upgrade.
      console.log(`  ${log.ok("↑")}  ${label}  ${currentVersion} → ${log.ok(best)}`);
    } else {
      // Pinned version NOT in the registry — broken pin, repair to latest
      // regardless of direction.
      const arrow = cmp >= 0 ? log.ok("↑") : log.warn("↓");
      console.log(
        `  ${arrow}  ${label}  ${currentVersion} → ${log.ok(best)}  ${log.warn("(pinned version not in registry)")}`,
      );
    }
  }

  return { content: applyEdits(content, edits), result, relativeImports };
}

/**
 * Build a byte-level edit for an import entry's source scalar node.
 * Returns `null` when the parser didn't attach a range to the node — this
 * shouldn't happen for plain `parseAllDocuments` output but we don't want to
 * crash on weird inputs.
 *
 * Quote style is preserved: if the original scalar was written as
 * `Run: "std/run@0.2.4"` we re-emit `"std/run@0.2.7"`; plain stays plain.
 */
function buildSourceEdit(
  // A yaml v2 Scalar node — typed as unknown here to avoid leaking the
  // import into the public signature of this helper.
  node: unknown,
  content: string,
  newPin: string,
): { start: number; end: number; newText: string } | null {
  if (!node || typeof node !== "object") return null;
  const range = (node as { range?: unknown }).range;
  if (!Array.isArray(range) || range.length < 2) return null;
  const start = range[0] as number;
  const end = range[1] as number;
  if (typeof start !== "number" || typeof end !== "number") return null;

  // Inspect the original byte slice to decide whether to wrap the new value.
  // The parsed scalar's `range[0..1]` covers the quotes (when quoted), so we
  // check the first/last char against `"` and `'` rather than relying on
  // `node.type`, which is fine but adds another yaml-internal dependency.
  const original = content.slice(start, end);
  let newText: string;
  if (original.startsWith('"') && original.endsWith('"')) {
    newText = `"${newPin}"`;
  } else if (original.startsWith("'") && original.endsWith("'")) {
    newText = `'${newPin}'`;
  } else {
    newText = newPin;
  }

  return { start, end, newText };
}

function applyEdits(
  content: string,
  edits: Array<{ start: number; end: number; newText: string }>,
): string {
  if (edits.length === 0) return content;
  // Reverse offset order keeps earlier ranges valid as we splice later ones in.
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = content;
  for (const e of sorted) {
    out = out.slice(0, e.start) + e.newText + out.slice(e.end);
  }
  return out;
}

function emptyResult(errors = 0): UpgradeResult {
  return { changed: false, upgrades: [], pinned: 0, unchanged: 0, skipped: 0, errors };
}

/** Fold `child` counters into `into` (recursion aggregation). */
function mergeResults(into: UpgradeResult, child: UpgradeResult): void {
  into.upgrades.push(...child.upgrades);
  into.pinned += child.pinned;
  into.unchanged += child.unchanged;
  into.skipped += child.skipped;
  into.errors += child.errors;
  into.changed ||= child.changed;
}

export async function upgradeOne(
  inputPath: string,
  registryUrl: string,
  includePrerelease: boolean,
  dryRun: boolean,
  log: Logger,
  recursive = false,
  visited: Set<string> = new Set(),
): Promise<UpgradeResult> {
  const { filePath, error: resolveError } = resolveManifestPath(inputPath);
  const displayPath = path.relative(process.cwd(), filePath);

  if (resolveError) {
    console.error(`${displayPath}  ${log.error("error")}  ${resolveError}`);
    return emptyResult(1);
  }

  // A shared visited set makes recursion cycle-safe and de-dupes a sibling
  // reached from more than one manifest — each file is upgraded at most once.
  if (visited.has(filePath)) return emptyResult();
  visited.add(filePath);

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    console.error(
      `${displayPath}  ${log.error("error")}  cannot read file: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return emptyResult(1);
  }

  const { content: nextContent, result, relativeImports } = await upgradeManifest({
    content,
    registryUrl,
    includePrerelease,
    log,
    displayName: displayPath,
    recursive,
  });

  if (result.changed && !dryRun) {
    fs.writeFileSync(filePath, nextContent, "utf-8");
  }

  if (result.changed && dryRun) {
    const count = result.upgrades.length + result.pinned;
    console.log(`  ${log.dim(`dry-run: ${count} import(s) would be updated`)}`);
  }

  // Descend into local sibling manifests, resolving each relative source against
  // this manifest's directory. Remote imports were already bumped in place above.
  if (recursive) {
    const dir = path.dirname(filePath);
    for (const rel of relativeImports) {
      const child = await upgradeOne(
        path.resolve(dir, rel),
        registryUrl,
        includePrerelease,
        dryRun,
        log,
        recursive,
        visited,
      );
      mergeResults(result, child);
    }
  }

  return result;
}

export async function upgrade(argv: {
  paths: string[];
  registryUrl?: string;
  includePrerelease: boolean;
  dryRun: boolean;
  recursive?: boolean;
}): Promise<void> {
  const log = createLogger(false);

  const registryUrl =
    argv.registryUrl ?? process.env.TELO_REGISTRY_URL ?? DEFAULT_REGISTRY_URL;

  let totalUpgrades = 0;
  let totalPinned = 0;
  let totalUnchanged = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  // One visited set across all input paths — a sibling shared by two roots is
  // upgraded once.
  const visited = new Set<string>();

  for (const p of argv.paths) {
    const r = await upgradeOne(
      p,
      registryUrl,
      argv.includePrerelease,
      argv.dryRun,
      log,
      argv.recursive ?? false,
      visited,
    );
    totalUpgrades += r.upgrades.length;
    totalPinned += r.pinned;
    totalUnchanged += r.unchanged;
    totalSkipped += r.skipped;
    totalErrors += r.errors;
  }

  const parts: string[] = [];
  parts.push(
    `${totalUpgrades} upgraded${argv.dryRun && totalUpgrades > 0 ? log.dim(" (dry-run)") : ""}`,
  );
  if (totalPinned > 0) parts.push(`${totalPinned} newly pinned`);
  if (totalUnchanged > 0) parts.push(log.dim(`${totalUnchanged} already current`));
  if (totalSkipped > 0) parts.push(log.dim(`${totalSkipped} skipped`));
  if (totalErrors > 0) parts.push(log.error(`${totalErrors} error${totalErrors !== 1 ? "s" : ""}`));
  console.log(`\n${parts.join(", ")}`);

  if (totalErrors > 0) process.exit(1);
}

export function upgradeCommand(yargs: Argv): Argv {
  return yargs.command(
    "upgrade <paths..>",
    "Bump import sources to the latest published version in the registry",
    (y) =>
      y
        .positional("paths", {
          describe: "Paths to YAML manifests to upgrade",
          type: "string",
          array: true,
          demandOption: true,
        })
        .option("registry-url", {
          type: "string",
          describe: "Base URL for the telo module registry. Overrides TELO_REGISTRY_URL.",
        })
        .option("include-prerelease", {
          type: "boolean",
          default: false,
          describe: "Include pre-release versions (e.g. 1.0.0-beta.1) when picking the latest",
        })
        .option("dry-run", {
          type: "boolean",
          default: false,
          describe: "Show what would change without writing to disk",
        })
        .option("recursive", {
          alias: "r",
          type: "boolean",
          default: false,
          describe: "Follow relative (local) imports and upgrade their manifests too",
        }),
    async (argv) => {
      await upgrade(argv as any);
    },
  );
}
