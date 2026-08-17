import {
  TELO_SURFACE_VERSION,
  applyTextEdits,
  evaluateRequires,
  isLocalPathSource,
  readRequires,
  splitIntegrity,
} from "@telorun/analyzer";
import { defaultTransportRegistry, nodeHostVersions, type Transport } from "@telorun/kernel";
import { defaultCustomTags } from "@telorun/templating";
import * as fs from "fs";
import * as path from "path";
import semver from "semver";
import { parseAllDocuments } from "yaml";
import type { Argv } from "yargs";
import { createLogger, type Logger } from "../logger.js";
import { outEmit, outErrLine, outLine, output } from "../output.js";
import { findModuleDoc, importSourceRefs, type ImportSourceRef } from "./manifest-imports.js";

const DEFAULT_REGISTRY_URL = "https://registry.telo.run";

/** The version-independent label for a versioned `source`, for diagnostics —
 *  the ref with its exact `@<rawVersion>` suffix and any integrity fragment
 *  stripped (`oci://ghcr.io/telorun/run`, `acme/lib`). */
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

/**
 * How a candidate version answered the compatibility question.
 *
 * `unknown` — the manifest could not be read — is never treated as
 * incompatible, since an unreachable registry must not silently freeze a
 * consumer's imports.
 *
 * The two rejecting answers are kept APART because they call for different
 * actions and the user is told which one applies: `too-new` is fixed by
 * upgrading telo, `unreadable` cannot be fixed by the consumer at all. Collapsing
 * them into one `"no"` and then printing "requires a newer telo" would assert a
 * cause the check never established, and point at a runtime upgrade that will not
 * help.
 */
type Compatibility = "yes" | "too-new" | "unreadable" | "unknown";

/**
 * Read a candidate version's declared `requires.telo` and decide whether this
 * runtime can host it.
 *
 * The manifest is its own artifact layer, so this costs a `telo.yaml` fetch and
 * never pulls a payload. A module that declares nothing is compatible — the
 * bootstrap rule, permanent for everything published before the mechanism
 * existed.
 */
async function versionCompatibility(
  transport: Transport,
  source: string,
  version: string,
): Promise<Compatibility> {
  let text: string;
  try {
    ({ text } = await transport.source.read(transport.withVersion(source, version)));
  } catch {
    return "unknown";
  }
  try {
    const docs = parseAllDocuments(text, { customTags: defaultCustomTags });
    const moduleDoc = findModuleDoc(docs);
    if (!moduleDoc) return "unknown";
    const { block, issues } = readRequires(moduleDoc.toJS() as Record<string, unknown>);
    // A malformed declaration is not a licence to install: the module claims a
    // requirement it failed to state, and guessing which way it pointed is how a
    // consumer ends up on a version that cannot load.
    // The load gate warns about this same manifest, so the two halves agree.
    if (issues.some((i) => !i.unknownAxis)) return "unreadable";
    return evaluateRequires(block, TELO_SURFACE_VERSION, nodeHostVersions()).satisfied
      ? "yes"
      : "too-new";
  } catch {
    return "unknown";
  }
}

interface Selection {
  /** The newest version this runtime can host, or `null` when none can be. */
  best: string | null;
  /** The newest version overall, when it is NOT `best` — what was held back. */
  heldBack: string | null;
  /** Why `heldBack` was rejected, so the message states the cause it actually
   *  established rather than assuming a version skew. */
  reason: Exclude<Compatibility, "yes"> | null;
}

/**
 * The newest version whose declared range accepts this runtime.
 *
 * Walks newest-first and stops at the first satisfied candidate, so the common
 * case — the newest version is compatible — costs a single manifest fetch. The
 * held-back version is reported rather than swallowed: without it `upgrade` says
 * "up to date" while newer versions exist, which is a silent ceiling and a worse
 * report than the failure this whole mechanism replaces.
 */
async function selectCompatible(
  transport: Transport,
  source: string,
  versions: string[],
  includePrerelease: boolean,
): Promise<Selection> {
  const eligible = (
    includePrerelease ? versions : versions.filter((v) => semver.prerelease(v) === null)
  )
    .slice()
    .sort(semver.rcompare);
  if (eligible.length === 0) return { best: null, heldBack: null, reason: null };

  let firstReason: Exclude<Compatibility, "yes"> | null = null;
  for (const version of eligible) {
    const verdict = await versionCompatibility(transport, source, version);
    if (verdict === "too-new" || verdict === "unreadable") {
      firstReason ??= verdict;
      continue;
    }
    const held = version === eligible[0] ? null : eligible[0]!;
    return { best: version, heldBack: held, reason: held ? firstReason : null };
  }
  return { best: null, heldBack: eligible[0]!, reason: firstReason };
}

/** How a rejected candidate reads in the held-back line. */
function describeReason(reason: Exclude<Compatibility, "yes"> | null): string {
  if (reason === "unreadable") return "its declared requirement cannot be read";
  if (reason === "too-new") return `it requires a newer telo than ${TELO_SURFACE_VERSION}`;
  return "it could not be checked";
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
    outLine(`\nUpgrading ${log.dim(displayName)}`);
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
      outLine(`  ${log.ok("=")}  ${label}  ${log.dim(`already at ${version}, pinned`)}`);
      result.unchanged++;
      return;
    }
    const pinBase = transport.withVersion(importRef.source, version);
    let hash: string;
    try {
      hash = await transport.manifestHash(pinBase);
    } catch (err) {
      outLine(
        `  ${log.warn("!")}  ${label}  ${log.dim(`already at ${version}, left unpinned (${err instanceof Error ? err.message : String(err)})`)}`,
      );
      result.unchanged++;
      return;
    }
    const edit = buildSourceEdit(importRef.node, content, `${pinBase}#${hash}`);
    if (!edit) {
      outErrLine(
        `  ${log.err.error("✗")}  ${label}  source scalar has no range — skipping`,
      );
      result.errors++;
      return;
    }
    edits.push(edit);
    result.changed = true;
    result.pinned++;
    outLine(`  ${log.ok("+")}  ${label}  ${log.dim(`already at ${version},`)} ${log.ok("pinned")}`);
  };

  for (const importRef of importRefs) {
    const source = importRef.source;

    // A local sibling import (relative/absolute path) carries no version to bump
    // here. Under `--recursive` the caller descends into it, so stay silent;
    // otherwise report it skipped and point at the flag.
    if (isLocalPathSource(source)) {
      if (!recursive) {
        outLine(
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
      outLine(`  ${log.dim("·")}  ${source}  ${log.dim("skipped (not a remote ref)")}`);
      result.skipped++;
      continue;
    }

    const rawVersion = transport.refVersion(source);
    if (rawVersion === null) {
      // Remote but not version-pinned — a bare `https://` URL, or an OCI ref
      // with no explicit reference. Nothing to compare against.
      outLine(`  ${log.dim("·")}  ${source}  ${log.dim("skipped (not version-pinned)")}`);
      result.skipped++;
      continue;
    }
    const label = refLabel(source, rawVersion);

    let published: string[] | null;
    try {
      published = await transport.listVersions(source);
    } catch (err) {
      outErrLine(
        `  ${log.err.error("✗")}  ${label}  ` + (err instanceof Error ? err.message : String(err)),
      );
      result.errors++;
      continue;
    }

    if (published === null || published.length === 0) {
      outLine(
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

    const currentVersion = semver.valid(rawVersion);
    if (!currentVersion) {
      // A non-SemVer pin — an OCI `sha256:` digest, a moving tag like `latest`.
      // There is no ordering to upgrade along, so leave it untouched.
      outLine(
        `  ${log.warn("!")}  ${label}  ${log.dim(`unparseable current version (${rawVersion})`)}`,
      );
      result.skipped++;
      continue;
    }

    // Nothing to select when the newest published version is the one already
    // pinned: there is no candidate to move to, so the compatibility question
    // has no bearing and asking it would cost a manifest fetch per import on the
    // path that changes nothing. A pin the runtime cannot read is the LOAD
    // gate's to report, not this command's — `upgrade` moves pins forward, it
    // does not walk anyone backwards.
    const plainLatest = pickLatest(normalized, includePrerelease);
    if (plainLatest && semver.eq(plainLatest, currentVersion)) {
      await ensurePinned(importRef, transport, label, currentVersion);
      continue;
    }

    // Compatibility-aware selection: the highest version whose declared
    // `requires.telo` accepts this runtime, not the highest full stop. Without
    // it a consumer is handed syntax their runtime cannot read, which is the
    // failure the requirement declaration exists to prevent reaching at all.
    const { best, heldBack, reason } = await selectCompatible(
      transport,
      source,
      normalized,
      includePrerelease,
    );
    if (!best) {
      if (heldBack) {
        // Every published version declares a runtime this one is not — the
        // abandoned-module case a closed upper bound exists for. Reporting it as
        // "up to date" would be a lie in the most expensive direction.
        outLine(
          `  ${log.warn("!")}  ${label}  ` +
            log.warn(
              `no published version is usable here — newest is ${heldBack}, and ` +
                `${describeReason(reason)}`,
            ),
        );
      } else {
        // Versions exist but none pass the prerelease filter / semver parser.
        outLine(`  ${log.warn("!")}  ${label}  ${log.dim("no eligible versions in registry")}`);
      }
      result.skipped++;
      continue;
    }
    if (heldBack) {
      outLine(
        `  ${log.dim("·")}  ${label}  ` +
          log.dim(`${heldBack} available — ${describeReason(reason)}`),
      );
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
      outLine(
        `  ${log.warn("!")}  ${label}  ${log.dim(`left unpinned (${err instanceof Error ? err.message : String(err)})`)}`,
      );
    }

    const edit = buildSourceEdit(importRef.node, content, newPin);
    if (!edit) {
      // No range info — extremely unlikely for a freshly parsed doc, but bail
      // out loudly rather than silently dropping the rewrite.
      outErrLine(
        `  ${log.err.error("✗")}  ${label}  source scalar has no range — skipping`,
      );
      result.errors++;
      continue;
    }

    edits.push(edit);
    result.changed = true;
    result.upgrades.push({ packagePath: label, from: currentVersion, to: best });

    if (currentPublished) {
      // Pinned version exists in the registry, just older — straight upgrade.
      outLine(`  ${log.ok("↑")}  ${label}  ${currentVersion} → ${log.ok(best)}`);
    } else {
      // Pinned version NOT in the registry — broken pin, repair to latest
      // regardless of direction.
      const arrow = cmp >= 0 ? log.ok("↑") : log.warn("↓");
      outLine(
        `  ${arrow}  ${label}  ${currentVersion} → ${log.ok(best)}  ${log.warn("(pinned version not in registry)")}`,
      );
    }
  }

  return { content: applyTextEdits(content, edits), result, relativeImports };
}

/**
 * Build a byte-level edit for an import entry's source scalar node.
 * Returns `null` when the parser didn't attach a range to the node — this
 * shouldn't happen for plain `parseAllDocuments` output but we don't want to
 * crash on weird inputs.
 *
 * Quote style is preserved: if the original scalar was written as
 * `Run: "oci://ghcr.io/telorun/run@0.2.4"` we re-emit `"oci://ghcr.io/telorun/run@0.2.7"`; plain stays plain.
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
    outErrLine(`${displayPath}  ${log.err.error("error")}  ${resolveError}`);
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
    outErrLine(
      `${displayPath}  ${log.err.error("error")}  cannot read file: ` +
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
    outLine(`  ${log.dim(`dry-run: ${count} import(s) would be updated`)}`);
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
  outLine(`\n${parts.join(", ")}`);

  outEmit({
    ok: totalErrors === 0,
    dryRun: argv.dryRun ?? false,
    upgraded: totalUpgrades,
    pinned: totalPinned,
    unchanged: totalUnchanged,
    skipped: totalSkipped,
    errorCount: totalErrors,
  });

  // `process.exitCode`, not `process.exit()`: the structured payload was just
  // written, and on a pipe `write` is asynchronous while `exit` does not flush.
  // Truncated JSON is a parse failure for the one consumer this format exists
  // for. Returning lets the event loop drain.
  if (totalErrors > 0) process.exitCode = 1;
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
