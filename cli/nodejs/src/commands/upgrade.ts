import {
  TELO_RUNNING_SURFACE,
  applyTextEdits,
  isLocalPathSource,
  readModuleVersion,
  selectionCompatibility,
  splitIntegrity,
  type HostVersions,
  type ModuleVersionRequirements,
  type SelectionVerdict,
} from "@telorun/analyzer";
import { defaultTransportRegistry, nodeHostVersions, type Transport } from "@telorun/kernel";
import { defaultCustomTags } from "@telorun/templating";
import * as fs from "fs";
import * as path from "path";
import semver from "semver";
import { parseAllDocuments } from "yaml";
import type { Argv } from "yargs";
import { createLogger, type Logger } from "../logger.js";
import { outEmit, outErrLine, outLine } from "../output.js";
import type { LocalImportPinner } from "../release/local-import-pins.js";
import {
  buildSourceEdit,
  findModuleDoc,
  importSourceRefs,
  resolveManifestPath,
  type ImportSourceRef,
} from "./manifest-imports.js";
import { newImportPinner, rewriteImportForms } from "./release-imports.js";

/** The version-independent label for a versioned `source`, for diagnostics —
 *  the ref with its exact `@<rawVersion>` suffix and any integrity fragment
 *  stripped (`oci://ghcr.io/telorun/run`). */
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

/** The runtime upgrade judges candidates against. A build of the pending release
 *  reports `+unreleased`, which is what meets a `>=unreleased` floor. */
export interface UpgradeRuntime {
  telo: string;
  host: HostVersions;
}

function currentRuntime(): UpgradeRuntime {
  return { telo: TELO_RUNNING_SURFACE, host: nodeHostVersions() };
}

type Rejection = { compatibility: "unreadable" } | Extract<SelectionVerdict, { key: string }>;

/** A published version the runtime cannot be offered, and why. */
interface Held {
  version: string;
  verdict: Rejection;
}

/** What the newest-first walk established. */
interface Walk {
  /** The newest version this runtime can use — at or above the pin when the pin
   *  is published. `null` when none is. */
  best: string | null;
  /** Rejected versions newer than `best` (or than the pin), newest first. */
  held: Held[];
  /** Why the pin itself is rejected, when the walk reached it and it is. */
  pinVerdict: Rejection | null;
}

/**
 * Read one published version's `telo.yaml`. The manifest is its own artifact
 * layer, so this costs a manifest fetch and never pulls a payload. A manifest
 * that cannot be read speaks for nothing and holds nothing back: an unreachable
 * registry must not silently freeze a consumer's imports.
 */
async function readVersion(
  transport: Transport,
  source: string,
  version: string,
): Promise<ModuleVersionRequirements> {
  try {
    const { text } = await transport.source.read(transport.withVersion(source, version));
    return readModuleVersion({ version, text });
  } catch {
    return { version, requirements: "unknown" };
  }
}

/**
 * The newest version whose range accepts this runtime, walking newest-first.
 *
 * A version's verdict depends on the manifests of every version NEWER than it (a
 * later `restrictions:` entry speaks for it), and the walk has read exactly
 * those by the time it reaches a candidate, so restrictions cost no request
 * beyond the manifests upgrade already reads. The walk stops at the pin when it
 * is published: `upgrade` moves pins forward, never backwards. Every rejection
 * newer than what it stops at is returned, or the pin is a silent ceiling and
 * *"up to date"* becomes the new confusing report. A prerelease is neither a
 * candidate nor a speaker unless `includePrerelease`: only then are prereleases,
 * and their `restrictions:`, read.
 */
async function walkVersions(
  transport: Transport,
  source: string,
  versions: string[],
  includePrerelease: boolean,
  pin: string | null,
  runtime: UpgradeRuntime,
): Promise<Walk> {
  const eligible = (
    includePrerelease ? versions : versions.filter((v) => semver.prerelease(v) === null)
  )
    .slice()
    .sort(semver.rcompare);
  const walk: Walk = { best: null, held: [], pinVerdict: null };
  const read: ModuleVersionRequirements[] = [];
  for (const version of eligible) {
    if (pin !== null && semver.lte(version, pin) && !semver.eq(version, pin)) break;
    const candidate = await readVersion(transport, source, version);
    const verdict = selectionCompatibility(candidate, read, runtime.telo, runtime.host);
    read.push(candidate);
    if (verdict.compatibility === "yes" || verdict.compatibility === "unknown") {
      walk.best = version;
      return walk;
    }
    if (pin !== null && semver.eq(version, pin)) {
      walk.pinVerdict = verdict as Rejection;
      return walk;
    }
    walk.held.push({ version, verdict: verdict as Rejection });
  }
  return walk;
}

/** `a`, `a and b`, `a, b and c`. */
function listOf(versions: string[]): string {
  if (versions.length <= 1) return versions.join("");
  return `${versions.slice(0, -1).join(", ")} and ${versions[versions.length - 1]}`;
}

/** Consecutive held versions with the same cause share one line. */
function heldBackLines(held: Held[]): string[] {
  const groups: Array<{ key: string; versions: string[]; verdict: Rejection }> = [];
  for (const { version, verdict } of held) {
    const key =
      verdict.compatibility === "unreadable"
        ? "unreadable"
        : verdict.source.from === "restriction"
          ? `restriction|${verdict.source.reason}`
          : `${verdict.compatibility}|${verdict.key}|${verdict.bound}`;
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.versions.push(version);
    else groups.push({ key, versions: [version], verdict });
  }
  return groups.map(({ versions, verdict }) => {
    const list = listOf(versions);
    const plural = versions.length > 1;
    if (verdict.compatibility === "unreadable") {
      return `held back: ${list} declare${plural ? "" : "s"} a requirement that cannot be read.`;
    }
    if (verdict.source.from === "restriction") return `held back: ${list} — ${verdict.source.reason}`;
    if (verdict.compatibility === "too-new") {
      return (
        `held back: ${list} require${plural ? "" : "s"} ${verdict.key} '${verdict.bound}'; ` +
        `this runtime reports ${verdict.running}.`
      );
    }
    return (
      `held back: ${list} ${plural ? "are" : "is"} restricted to ${verdict.key} ` +
      `'${verdict.bound}'; this runtime reports ${verdict.running}.`
    );
  });
}

/** Why the pin cannot be offered, as one sentence. */
function pinRestriction(where: string, verdict: Rejection): string {
  if (verdict.compatibility !== "unreadable" && verdict.source.from === "restriction") {
    return `${where} is restricted by ${verdict.source.version ?? "a later version"}: ${verdict.source.reason}`;
  }
  if (verdict.compatibility === "unreadable") {
    return `${where} declares a requirement that cannot be read.`;
  }
  return (
    `${where} is not usable by this telo: it ` +
    (verdict.compatibility === "too-new" ? "requires" : "is restricted to") +
    ` ${verdict.key} '${verdict.bound}'; this runtime reports ${verdict.running}.`
  );
}

interface ImportUpgrade {
  /** The manifest holding the import, as displayed. */
  manifest?: string;
  packagePath: string;
  from: string;
  to: string;
}

/** An import of a workspace module `--pin-local` rewrote (`telo release imports
 *  --as=published`): to its published pin, or to its relative path. */
interface LocalRepin {
  manifest?: string;
  source: string;
  to: string;
}

/** An import of a workspace module that stays relative, and why. */
interface PendingLocalImport {
  manifest?: string;
  source: string;
  reason: string;
}

interface UpgradeResult {
  changed: boolean;
  upgrades: ImportUpgrade[];
  /** Imports already at the latest version that were newly pinned (integrity
   *  hash added without a version change). */
  pinned: number;
  repins: LocalRepin[];
  pendingLocal: PendingLocalImport[];
  /** Published versions this runtime cannot be offered, per import. */
  heldBack: HeldBack[];
  unchanged: number;
  skipped: number;
  errors: number;
}

interface HeldBack {
  manifest?: string;
  import: string;
  /** The held-back lines as printed. */
  lines: string[];
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
  includePrerelease: boolean;
  log: Logger;
  /** Optional label printed in the "Upgrading <name>" header. */
  displayName?: string;
  /** When set, local sibling imports are followed by the caller — so they are
   *  neither counted nor reported as skipped here. */
  recursive?: boolean;
  /** Aliases of imports whose form `telo release imports` decided: a remote
   *  source among them is not bumped, a relative one is not reported skipped. */
  formDecided?: ReadonlySet<string>;
  /** The runtime candidates are judged against; this process by default. */
  runtime?: UpgradeRuntime;
}): Promise<{ content: string; result: UpgradeResult; relativeImports: string[] }> {
  const { content, includePrerelease, log, displayName, recursive } = args;
  const formDecided = args.formDecided ?? new Set<string>();
  const runtime = args.runtime ?? currentRuntime();

  const result: UpgradeResult = {
    changed: false,
    upgrades: [],
    pinned: 0,
    repins: [],
    pendingLocal: [],
    heldBack: [],
    unchanged: 0,
    skipped: 0,
    errors: 0,
  };

  const registry = defaultTransportRegistry();
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
  // Relative imports that stay relative — what `--recursive` descends into.
  const relativeImports: string[] = [];

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
      relativeImports.push(source);
      if (!recursive && !formDecided.has(importRef.alias)) {
        outLine(
          `  ${log.dim("·")}  ${source}  ${log.dim("skipped (local import — use --recursive to follow)")}`,
        );
        result.skipped++;
      }
      continue;
    }

    if (formDecided.has(importRef.alias)) continue;

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
        `  ${log.warn("!")}  ${label}  ${log.dim("no published versions")}`,
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

    // Selection: the highest version whose range — narrowed by the `restrictions:`
    // of the newer versions — accepts this runtime, not the highest full stop.
    // Without it a consumer is handed syntax their runtime cannot read, or a
    // version a later release marked as broken on it.
    const currentPublished = normalized.some((v) => semver.eq(v, currentVersion));
    const { best, held, pinVerdict } = await walkVersions(
      transport,
      source,
      normalized,
      includePrerelease,
      currentPublished ? currentVersion : null,
      runtime,
    );
    const where = `${importRef.alias}: ${splitIntegrity(source).base}`;
    const lines = heldBackLines(held);
    const reportHeld = (): void => {
      for (const line of lines) outLine(`      ${log.dim(line)}`);
      if (lines.length > 0) result.heldBack.push({ import: label, lines });
    };

    if (pinVerdict) {
      // The pin is a published version this runtime cannot be offered: say why,
      // and leave it — the load gate reports what it cannot read.
      outLine(`  ${log.warn("!")}  ${pinRestriction(where, pinVerdict)}`);
      reportHeld();
      result.skipped++;
      continue;
    }
    if (!best) {
      if (held.length > 0) {
        outLine(`  ${log.warn("!")}  ${label}  ${log.warn("no published version is usable here")}`);
        reportHeld();
      } else {
        // Versions exist but none pass the prerelease filter / semver parser.
        outLine(`  ${log.warn("!")}  ${label}  ${log.dim("no eligible versions in registry")}`);
      }
      result.skipped++;
      continue;
    }

    const cmp = semver.compare(best, currentVersion);

    // The pin is the newest version usable here — nothing to upgrade; ensure it
    // carries an integrity hash (`cmp < 0` is defensive: the walk stops at a
    // published pin).
    if (currentPublished && cmp <= 0) {
      if (held.length > 0) {
        outLine(`  ${log.dim("·")}  ${where} is the newest version this telo can use.`);
        reportHeld();
      }
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
    reportHeld();
  }

  return { content: applyTextEdits(content, edits), result, relativeImports };
}

function emptyResult(errors = 0): UpgradeResult {
  return {
    changed: false,
    upgrades: [],
    pinned: 0,
    repins: [],
    pendingLocal: [],
    heldBack: [],
    unchanged: 0,
    skipped: 0,
    errors,
  };
}

/** Fold `child` counters into `into` (recursion aggregation). */
function mergeResults(into: UpgradeResult, child: UpgradeResult): void {
  into.upgrades.push(...child.upgrades);
  into.pinned += child.pinned;
  into.repins.push(...child.repins);
  into.pendingLocal.push(...child.pendingLocal);
  into.heldBack.push(...child.heldBack);
  into.unchanged += child.unchanged;
  into.skipped += child.skipped;
  into.errors += child.errors;
  into.changed ||= child.changed;
}

/**
 * `--pin-local`, as one invocation holds it: the deprecated alias of `telo
 * release imports --as=published` over the manifests NAMED on the command line.
 * One reached through `--recursive` is some module's own manifest, whose relative
 * imports are the edges its release is planned along.
 */
export interface LocalImportPins {
  readonly pinner: LocalImportPinner;
  /** Absolute paths of the manifests named on the command line. */
  readonly named: ReadonlySet<string>;
}

export async function upgradeOne(
  inputPath: string,
  includePrerelease: boolean,
  dryRun: boolean,
  log: Logger,
  recursive = false,
  visited: Set<string> = new Set(),
  pinLocal?: LocalImportPins,
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

  const forms = pinLocal?.named.has(filePath)
    ? await rewriteImportForms({
        content,
        manifestDir: path.dirname(filePath),
        as: "published",
        pinner: pinLocal.pinner,
      })
    : undefined;
  const { content: nextContent, result, relativeImports } = await upgradeManifest({
    content: forms?.content ?? content,
    includePrerelease,
    log,
    displayName: displayPath,
    recursive,
    ...(forms ? { formDecided: forms.workspaceAliases } : {}),
  });
  if (forms) {
    for (const { source, to } of forms.rewritten) {
      const shown = splitIntegrity(to).base;
      result.repins.push({ source, to: shown });
      outLine(`  ${log.ok("⇢")}  ${source} → ${log.ok(shown)}`);
    }
    for (const { source, reason } of forms.keptRelative) {
      result.pendingLocal.push({ source, reason });
      outLine(`  ${log.dim("·")}  ${source}  ${log.dim(`kept local — ${reason}`)}`);
    }
    for (const { source, message } of forms.errors) {
      outErrLine(`  ${log.err.error("✗")}  ${source ?? ""}  ${message}`);
      result.errors++;
    }
    result.changed ||= forms.rewritten.length > 0;
  }
  for (const entry of [...result.upgrades, ...result.repins, ...result.pendingLocal, ...result.heldBack]) {
    entry.manifest = displayPath;
  }

  if (result.changed && !dryRun) {
    fs.writeFileSync(filePath, nextContent, "utf-8");
  }

  if (result.changed && dryRun) {
    const count = result.upgrades.length + result.pinned + result.repins.length;
    outLine(`  ${log.dim(`dry-run: ${count} import(s) would be updated`)}`);
  }

  // Descend into local sibling manifests, resolving each relative source against
  // this manifest's directory. Remote imports were already bumped in place above.
  if (recursive) {
    const dir = path.dirname(filePath);
    for (const rel of relativeImports) {
      const child = await upgradeOne(
        path.resolve(dir, rel),
        includePrerelease,
        dryRun,
        log,
        recursive,
        visited,
        pinLocal,
      );
      mergeResults(result, child);
    }
  }

  return result;
}

export async function upgrade(argv: {
  paths: string[];
  includePrerelease: boolean;
  dryRun: boolean;
  recursive?: boolean;
  pinLocal?: boolean;
  registry?: string;
}): Promise<void> {
  const log = createLogger(false);

  if (argv.pinLocal) {
    outErrLine(
      `${log.err.warn("deprecated")}  --pin-local will be removed: run ` +
        "`telo release imports --as=published` on the same manifests instead.",
    );
  }
  const pinLocal: LocalImportPins | undefined = argv.pinLocal
    ? {
        pinner: newImportPinner(
          {
            ...(argv.registry ? { flag: argv.registry } : {}),
            ...(process.env.TELO_OCI_REGISTRY ? { env: process.env.TELO_OCI_REGISTRY } : {}),
          },
          log,
        ),
        named: new Set(argv.paths.map((p) => resolveManifestPath(p).filePath)),
      }
    : undefined;

  const upgrades: ImportUpgrade[] = [];
  const repins: LocalRepin[] = [];
  const pendingLocal: PendingLocalImport[] = [];
  const heldBack: HeldBack[] = [];
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
      argv.includePrerelease,
      argv.dryRun,
      log,
      argv.recursive ?? false,
      visited,
      pinLocal,
    );
    upgrades.push(...r.upgrades);
    repins.push(...r.repins);
    pendingLocal.push(...r.pendingLocal);
    heldBack.push(...r.heldBack);
    totalPinned += r.pinned;
    totalUnchanged += r.unchanged;
    totalSkipped += r.skipped;
    totalErrors += r.errors;
  }

  const totalUpgrades = upgrades.length;
  const parts: string[] = [];
  parts.push(
    `${totalUpgrades} upgraded${argv.dryRun && totalUpgrades > 0 ? log.dim(" (dry-run)") : ""}`,
  );
  if (totalPinned > 0) parts.push(`${totalPinned} newly pinned`);
  if (repins.length > 0) parts.push(`${repins.length} local pinned to published`);
  if (pendingLocal.length > 0) parts.push(log.dim(`${pendingLocal.length} kept local`));
  if (totalUnchanged > 0) parts.push(log.dim(`${totalUnchanged} already current`));
  if (totalSkipped > 0) parts.push(log.dim(`${totalSkipped} skipped`));
  if (totalErrors > 0) parts.push(log.error(`${totalErrors} error${totalErrors !== 1 ? "s" : ""}`));
  outLine(`\n${parts.join(", ")}`);

  outEmit({
    ok: totalErrors === 0,
    dryRun: argv.dryRun ?? false,
    upgraded: totalUpgrades,
    pinned: totalPinned,
    repinned: repins.length,
    keptLocal: pendingLocal.length,
    upgrades,
    repins,
    pendingLocal,
    heldBack,
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
    "Bump import sources to the latest published version at their origin",
    (y) =>
      y
        .positional("paths", {
          describe: "Paths to YAML manifests to upgrade",
          type: "string",
          array: true,
          demandOption: true,
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
        })
        .option("pin-local", {
          type: "boolean",
          default: false,
          describe:
            "Deprecated: use `telo release imports --as=published`, which this runs on the manifests named here (not on ones reached through --recursive).",
        })
        .option("registry", {
          type: "string",
          describe:
            "With --pin-local: publish destination base (oci://host/org) for modules whose workspace entry declares none.",
        }),
    async (argv) => {
      await upgrade(argv as any);
    },
  );
}
