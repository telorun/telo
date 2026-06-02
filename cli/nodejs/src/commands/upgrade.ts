import { defaultCustomTags } from "@telorun/templating";
import * as fs from "fs";
import * as path from "path";
import semver from "semver";
import { parseAllDocuments } from "yaml";
import type { Argv } from "yargs";
import { createLogger, type Logger } from "../logger.js";
import { findModuleDoc, importSourceRefs } from "./manifest-imports.js";

const DEFAULT_REGISTRY_URL = "https://registry.telo.run";

interface ParsedRef {
  namespace: string;
  name: string;
  /** Normalized SemVer string (no `v` prefix), or `null` if the pin is not valid SemVer. */
  version: string | null;
  /** Raw version segment as written in the YAML — preserved for diagnostic output. */
  rawVersion: string;
}

/** Parse `<namespace>/<name>@<version>`. Exported for tests. */
export function parseModuleRef(source: string): ParsedRef | null {
  const atIdx = source.lastIndexOf("@");
  if (atIdx <= 0 || atIdx === source.length - 1) return null;
  const modulePath = source.slice(0, atIdx);
  const slashIdx = modulePath.indexOf("/");
  if (slashIdx <= 0 || slashIdx === modulePath.length - 1) return null;
  const namespace = modulePath.slice(0, slashIdx);
  const name = modulePath.slice(slashIdx + 1);
  const rawVersion = source.slice(atIdx + 1);
  if (!namespace || !name || !rawVersion) return null;
  // Registry refs are strictly `<namespace>/<name>@<version>` — exactly one
  // slash. A second slash means we're looking at a relative path or a URL
  // disguised as a ref; either way it would resolve to a bogus `/ns/a/b` URL
  // and surface as "no published versions" instead of being treated as
  // non-registry.
  if (name.includes("/")) return null;
  // Reject anything that doesn't look like a module ref so we don't try to
  // upgrade HTTP URLs, relative paths, etc.
  if (namespace.includes("://") || namespace.includes(":") || namespace.startsWith(".")) {
    return null;
  }
  // semver.valid() tolerates a `v` prefix and returns the cleaned form.
  return { namespace, name, version: semver.valid(rawVersion), rawVersion };
}

interface VersionsResponse {
  name?: string;
  version?: string;
  versions?: string[];
}

async function fetchPublishedVersions(
  registryUrl: string,
  namespace: string,
  name: string,
): Promise<string[] | null> {
  const base = registryUrl.replace(/\/+$/, "");
  const url = `${base}/${namespace}/${name}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Registry returned ${res.status} ${res.statusText} for ${namespace}/${name}`);
  }
  const body = (await res.json()) as VersionsResponse;
  if (!Array.isArray(body.versions)) return [];
  // Normalize via semver.valid so downstream string-equality matches on the
  // pin compare the same canonical form (handles `v` prefix, whitespace, etc).
  return body.versions
    .map((v) => semver.valid(v))
    .filter((v): v is string => v !== null);
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
}): Promise<{ content: string; result: UpgradeResult }> {
  const { content, registryUrl, includePrerelease, log, displayName } = args;

  const result: UpgradeResult = {
    changed: false,
    upgrades: [],
    unchanged: 0,
    skipped: 0,
    errors: 0,
  };

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

  for (const importRef of importRefs) {
    const source = importRef.source;

    const ref = parseModuleRef(source);
    if (!ref) {
      console.log(`  ${log.dim("·")}  ${source}  ${log.dim("skipped (not a registry ref)")}`);
      result.skipped++;
      continue;
    }

    let published: string[] | null;
    try {
      published = await fetchPublishedVersions(registryUrl, ref.namespace, ref.name);
    } catch (err) {
      console.error(
        `  ${log.error("✗")}  ${ref.namespace}/${ref.name}  ` +
          (err instanceof Error ? err.message : String(err)),
      );
      result.errors++;
      continue;
    }

    if (published === null || published.length === 0) {
      console.log(
        `  ${log.warn("!")}  ${ref.namespace}/${ref.name}  ${log.dim("no published versions in registry")}`,
      );
      result.skipped++;
      continue;
    }

    const best = pickLatest(published, includePrerelease);
    if (!best) {
      // Versions exist but none pass the prerelease filter / semver parser.
      console.log(
        `  ${log.warn("!")}  ${ref.namespace}/${ref.name}  ${log.dim("no eligible versions in registry")}`,
      );
      result.skipped++;
      continue;
    }

    if (!ref.version) {
      console.log(
        `  ${log.warn("!")}  ${ref.namespace}/${ref.name}  ${log.dim(`unparseable current version (${ref.rawVersion})`)}`,
      );
      result.skipped++;
      continue;
    }

    const currentPublished = published.some((v) => semver.eq(v, ref.version!));
    const cmp = semver.compare(best, ref.version);

    // The pinned version is in the registry and matches the latest pick — nothing to do.
    if (currentPublished && cmp === 0) {
      console.log(
        `  ${log.ok("=")}  ${ref.namespace}/${ref.name}  ${log.dim(`already at ${ref.version}`)}`,
      );
      result.unchanged++;
      continue;
    }

    // currentPublished && cmp < 0 shouldn't be possible — `best` is the max of
    // `published`, and `currentPublished` means the pin is in that list. Keep a
    // defensive branch so we don't silently swallow it.
    if (currentPublished && cmp < 0) {
      console.log(
        `  ${log.ok("=")}  ${ref.namespace}/${ref.name}  ${log.dim(`already at ${ref.version}`)}`,
      );
      result.unchanged++;
      continue;
    }

    const edit = buildSourceEdit(importRef.node, content, `${ref.namespace}/${ref.name}@${best}`);
    if (!edit) {
      // No range info — extremely unlikely for a freshly parsed doc, but bail
      // out loudly rather than silently dropping the rewrite.
      console.error(
        `  ${log.error("✗")}  ${ref.namespace}/${ref.name}  source scalar has no range — skipping`,
      );
      result.errors++;
      continue;
    }

    edits.push(edit);
    result.changed = true;
    result.upgrades.push({
      packagePath: `${ref.namespace}/${ref.name}`,
      from: ref.version,
      to: best,
    });

    if (currentPublished) {
      // Pinned version exists in the registry, just older — straight upgrade.
      console.log(
        `  ${log.ok("↑")}  ${ref.namespace}/${ref.name}  ${ref.version} → ${log.ok(best)}`,
      );
    } else {
      // Pinned version NOT in the registry — broken pin, repair to latest
      // regardless of direction.
      const arrow = cmp >= 0 ? log.ok("↑") : log.warn("↓");
      console.log(
        `  ${arrow}  ${ref.namespace}/${ref.name}  ${ref.version} → ${log.ok(best)}  ${log.warn("(pinned version not in registry)")}`,
      );
    }
  }

  return { content: applyEdits(content, edits), result };
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

export async function upgradeOne(
  inputPath: string,
  registryUrl: string,
  includePrerelease: boolean,
  dryRun: boolean,
  log: Logger,
): Promise<UpgradeResult> {
  const { filePath, error: resolveError } = resolveManifestPath(inputPath);
  const displayPath = path.relative(process.cwd(), filePath);

  if (resolveError) {
    console.error(`${displayPath}  ${log.error("error")}  ${resolveError}`);
    return { changed: false, upgrades: [], unchanged: 0, skipped: 0, errors: 1 };
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    console.error(
      `${displayPath}  ${log.error("error")}  cannot read file: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return { changed: false, upgrades: [], unchanged: 0, skipped: 0, errors: 1 };
  }

  const { content: nextContent, result } = await upgradeManifest({
    content,
    registryUrl,
    includePrerelease,
    log,
    displayName: displayPath,
  });

  if (result.changed && !dryRun) {
    fs.writeFileSync(filePath, nextContent, "utf-8");
  }

  if (result.changed && dryRun) {
    console.log(`  ${log.dim(`dry-run: ${result.upgrades.length} import(s) would be updated`)}`);
  }

  return result;
}

export async function upgrade(argv: {
  paths: string[];
  registryUrl?: string;
  includePrerelease: boolean;
  dryRun: boolean;
}): Promise<void> {
  const log = createLogger(false);

  const registryUrl =
    argv.registryUrl ?? process.env.TELO_REGISTRY_URL ?? DEFAULT_REGISTRY_URL;

  let totalUpgrades = 0;
  let totalUnchanged = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const p of argv.paths) {
    const r = await upgradeOne(p, registryUrl, argv.includePrerelease, argv.dryRun, log);
    totalUpgrades += r.upgrades.length;
    totalUnchanged += r.unchanged;
    totalSkipped += r.skipped;
    totalErrors += r.errors;
  }

  const parts: string[] = [];
  parts.push(
    `${totalUpgrades} upgraded${argv.dryRun && totalUpgrades > 0 ? log.dim(" (dry-run)") : ""}`,
  );
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
        }),
    async (argv) => {
      await upgrade(argv as any);
    },
  );
}
