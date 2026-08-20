/**
 * Writing a release plan to disk — the half of `telo release apply` that
 * changes files.
 *
 * Split from the command so the command is wiring: `commands/release.ts` reads
 * argv, resolves the registry and prints, and everything that touches a manifest,
 * a changelog or the ledger is here. The seam is the plan itself, which is
 * already a complete description of what to write.
 */

import {
  prependChangelogRelease,
  renderChangelogRelease,
  stampCrateVersion,
  stampManifestVersion,
  stampPackageVersion,
  stampSelfNpmPins,
  VersionStampError,
  type Ledger,
  type LedgerEntry,
  type ModuleKey,
  type PlannedModule,
  type ReleasePlan,
} from "@telorun/analyzer";
import * as fs from "node:fs";
import * as path from "node:path";
import { ModulePayloadBuilder } from "../bundle/module-payload.js";
import { destinationFor, digestPayload, imageDigest } from "./evidence.js";
import { readLedger } from "./ledger-store.js";
import { loadWorkspace, requireModule, type Workspace } from "./workspace.js";

/** One module's writes, reported so `apply` can list what it touched. */
export interface AppliedModule {
  readonly key: ModuleKey;
  readonly from: string;
  readonly to: string;
  /** Workspace-relative paths written for this module. */
  readonly files: readonly string[];
}

/**
 * Write every planned module's version and changelog.
 *
 * Returns before the ledger is recorded, because the ledger has to be built from
 * the versions this pass just wrote.
 */
export function writePlannedVersions(
  workspace: Workspace,
  plan: ReleasePlan,
  date: string,
): AppliedModule[] {
  return plan.modules.map((module) => {
    const discovered = requireModule(workspace, module.key);
    const files = [...stampVersion(discovered.dir, module.to)];
    const changelog = writeChangelog(workspace, discovered.dir, module, date);
    if (changelog) files.push(changelog);
    return { key: module.key, from: module.from, to: module.to, files };
  });
}

/**
 * Stamp a module's one version into every manifest it owns.
 *
 * A file that carries no version is skipped — a module may own only a
 * `telo.yaml`, and most have no Rust crate. One whose version is written in a
 * shape that cannot be rewritten in place throws instead, because leaving a
 * module's manifests disagreeing about its own version is worse than stopping.
 */
/**
 * The package a module ships itself, when it has one that is published.
 *
 * A missing file means the module ships no package — the ordinary answer for the
 * bundled majority. A MALFORMED one is a different fact and must not read as the
 * same: this is what decides whether the manifest's self-pin gets stamped, so
 * swallowing a parse error silently skips exactly the stamping this exists to
 * guarantee, and the module ships naming a version of itself that never moved.
 */
function readPackageName(file: string): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  let pkg: { name?: string; private?: boolean };
  try {
    pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new VersionStampError(
      `${file} is not valid JSON: ${(err as Error).message}. It decides whether this ` +
        `module's manifest pins its own package, so it cannot be skipped.`,
    );
  }
  return pkg.private ? undefined : pkg.name;
}

function stampVersion(dir: string, version: string): string[] {
  const targets: Array<[string, (text: string, v: string, where: string) => string | undefined]> = [
    ["telo.yaml", stampManifestVersion],
    ["nodejs/package.json", stampPackageVersion],
    ["rust/Cargo.toml", stampCrateVersion],
  ];
  const written: string[] = [];
  for (const [relative, stamp] of targets) {
    const file = path.join(dir, relative);
    if (!fs.existsSync(file)) continue;
    const before = fs.readFileSync(file, "utf8");
    const after = stamp(before, version, relative);
    if (after === undefined || after === before) continue;
    fs.writeFileSync(file, after, "utf8");
    written.push(relative);
  }

  // A module delivering its controller from npm pins its OWN package in the
  // manifest, and that pin is part of its version too. Left behind it would name
  // a tarball older than the module describing it — which is how one came to
  // point at a years-old version of itself.
  const ownPackage = readPackageName(path.join(dir, "nodejs", "package.json"));
  const manifest = path.join(dir, "telo.yaml");
  if (ownPackage && fs.existsSync(manifest)) {
    const before = fs.readFileSync(manifest, "utf8");
    const after = stampSelfNpmPins(before, ownPackage, version);
    if (after !== before) {
      fs.writeFileSync(manifest, after, "utf8");
      if (!written.includes("telo.yaml")) written.push("telo.yaml");
    }
  }
  return written;
}

/** Prepend this release's block, or nothing when no fragment named the module —
 *  a bump that came only from propagation or a toolchain move has no prose, and
 *  an empty heading would be worse than silence. */
function writeChangelog(
  workspace: Workspace,
  dir: string,
  module: PlannedModule,
  date: string,
): string | undefined {
  if (module.entries.length === 0) return undefined;
  const file = path.join(dir, "CHANGELOG.md");
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
  fs.writeFileSync(
    file,
    prependChangelogRelease(
      existing,
      renderChangelogRelease({ version: module.to, date, entries: module.entries }),
    ),
    "utf8",
  );
  return path.relative(workspace.root, file);
}

/**
 * The ledger as it will look once this release is published.
 *
 * Built from a SECOND payload pass taken after the versions are on disk, because
 * that is what will actually ship: a dependent's manifest layer carries its
 * dependency's new version and the pin derived from the dependency's new bytes,
 * neither of which existed while the plan was being formed. Recording the
 * pre-bump digest would guarantee the next `check` reported drift on every
 * module in this release.
 */
export async function recordLedger(
  root: string,
  registry: string,
  plan: ReleasePlan,
): Promise<Ledger> {
  // Re-read the workspace so discovery sees the versions just written.
  const workspace = loadWorkspace(root);
  const planned = new Set(plan.modules.map((module) => module.key));
  const builder = new ModulePayloadBuilder({ cacheRoot: path.join(workspace.root, ".telo") });

  // A module that is not in the plan keeps whatever the ledger already said —
  // which may be nothing, the correct reading for one that has never published.
  // Recording a digest for it here would claim a publish that is not happening.
  const entries = new Map<ModuleKey, LedgerEntry>(readLedger(workspace.root).modules);
  for (const module of workspace.modules) {
    if (!planned.has(module.key)) continue;
    entries.set(module.key, {
      version: module.version,
      layers:
        module.artifactKind === "image"
          ? { image: await imageDigest(module) }
          : await digestPayload(
              await builder.payload(module.manifestPath, destinationFor(registry, module)),
            ),
    });
  }
  return { registry, modules: entries };
}
