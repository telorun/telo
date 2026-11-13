/**
 * Which release-workspace module an import names, and the published pin of it.
 *
 * A consumer in the same repository — an example, a starter, an application —
 * imports a workspace module either by relative path or by its published,
 * hash-pinned reference. `telo release imports` asks this file, per import,
 * which module it names and, for the published form, what pin to write.
 *
 * **The verdict is the release plan's.** A module the plan would bump is one
 * whose published artifact differs from the working copy, so pinning it would
 * silently drop the change the relative import was written for. The comparison
 * is therefore the one `telo release status` makes — the payload publish would
 * build, against the ledger — and never a second digest of the source files,
 * which publish rewrites. A dependent the plan bumps because a sibling moved is
 * pending for the same reason, and the reason names the sibling.
 *
 * **The registry has the last word.** The ledger is committed before the
 * artifact is pushed, so a version the plan calls settled may not exist yet; the
 * pin is read from the registry, and its absence is "not published yet".
 */

import { isLocalPathSource, parseVersionedRef, splitIntegrity } from "@telorun/analyzer";
import type { LedgerEntry, PlannedUnit } from "@telorun/release";
import { defaultTransportRegistry, type TransportRegistry } from "@telorun/kernel";
import * as fs from "node:fs";
import * as path from "node:path";
import semver from "semver";
import { findWorkspaceRoot } from "../workspace-marker.js";
import { readLedger } from "./ledger-store.js";
import { describeReason } from "@telorun/release/node";
import { resolveTargets, type RegistryRungs, type ResolvedTargets } from "./targets.js";
import { releaseWorkspaceAt, type DiscoveredModule, type Workspace } from "./workspace.js";
import { planWorkspace, type WorkspacePlan } from "./workspace-plan.js";

/** What a consumer's import of a workspace module is written as under
 *  `--as=published`. */
export type PublishedForm =
  | { readonly kind: "pinned"; readonly pin: string; readonly version: string }
  /** A released module whose published artifact is not the working copy yet. */
  | { readonly kind: "pending"; readonly cause: PendingCause; readonly reason: string }
  | { readonly kind: "error"; readonly message: string };

/** Why an import stays relative under `--as=published`, for machines. */
export type PendingCause = "plan-bumped" | "never-released" | "unpublished";

export type LocalImportVerdict =
  /** Not a released module of any workspace — an application's own library. */
  | { readonly kind: "unmanaged" }
  /** The importing manifest sits inside the module it imports. */
  | { readonly kind: "own" }
  | PublishedForm;

/**
 * What an import names, relative to the manifest holding it.
 *
 * `unmanaged` is everything the command leaves alone: no workspace module, an
 * image module, a target below the importer's own directory (a nested library,
 * which ships inside the importer's artifact and has no pin of its own). `own`
 * is an import of the module the manifest sits inside — its own test or
 * fixture, a blueprint's `example/` — which always stays relative. `relative` is
 * the path from the manifest's directory to the module's, as written.
 */
export type ImportTarget =
  | { readonly kind: "unmanaged" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "own"; readonly module: DiscoveredModule; readonly relative: string }
  | {
      readonly kind: "consumer";
      readonly workspace: Workspace;
      readonly module: DiscoveredModule;
      readonly relative: string;
    };

export interface ModuleReleaseState {
  readonly module: Pick<DiscoveredModule, "key" | "version">;
  /** Where the module publishes, absent when no destination resolved. */
  readonly destination: string | undefined;
  /** The module's entry in the release plan, when the plan bumps it. */
  readonly planned: PlannedUnit | undefined;
  /** What the ledger records as published. */
  readonly published: LedgerEntry | undefined;
}

/** Exported for tests. */
export async function verdictForModule(
  state: ModuleReleaseState,
  registry: TransportRegistry,
): Promise<PublishedForm> {
  const { module, destination, planned, published } = state;
  if (planned) {
    const reasons = [...new Set(planned.reasons.map(describeReason))].join("; ");
    return {
      kind: "pending",
      cause: "plan-bumped",
      reason: `${module.key} has an unreleased change (${planned.from} → ${planned.to}: ${reasons})`,
    };
  }
  if (!published) {
    return {
      kind: "pending",
      cause: "never-released",
      reason: `${module.key} has never been released`,
    };
  }
  if (!destination) {
    return { kind: "error", message: `${module.key} has no publish destination` };
  }

  const ref = `${destination}@${module.version}`;
  const transport = registry.forRef(ref);
  if (!transport) {
    return { kind: "error", message: `no transport reads '${ref}'` };
  }
  let versions: string[] | null;
  try {
    versions = await transport.listVersions(ref);
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
  const isPublished = (versions ?? []).some((candidate) => {
    const valid = semver.valid(candidate);
    return valid !== null && semver.eq(valid, module.version);
  });
  if (!isPublished) {
    return {
      kind: "pending",
      cause: "unpublished",
      reason: `${module.key}@${module.version} is not published at ${destination} yet`,
    };
  }
  try {
    return {
      kind: "pinned",
      pin: `${ref}#${await transport.manifestHash(ref)}`,
      version: module.version,
    };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

export interface LocalImportPinnerOptions {
  readonly rungs: RegistryRungs;
  /** Called per module while a workspace's plan is being built. */
  readonly onUnit?: (unit: { readonly key: string }, index: number, total: number) => void;
  readonly registry?: TransportRegistry;
}

/**
 * Answers per import, building each workspace's release plan at most once and
 * only when a published form is actually asked for, and resolving its publish
 * destinations only when a pinned import could name one of its modules — a
 * manifest with neither pays nothing.
 */
export class LocalImportPinner {
  private readonly workspaces = new Map<string, Workspace | null>();
  private readonly targets = new Map<string, ResolvedTargets>();
  private readonly plans = new Map<string, Promise<WorkspacePlan>>();
  private readonly registry: TransportRegistry;

  constructor(private readonly options: LocalImportPinnerOptions) {
    this.registry = options.registry ?? defaultTransportRegistry();
  }

  /** `source` is the import as written, in the manifest whose directory is
   *  `manifestDir`. */
  targetOf(manifestDir: string, source: string): ImportTarget {
    const importer = path.resolve(manifestDir);
    if (isLocalPathSource(source)) {
      const target = path.resolve(importer, source);
      const manifestPath = isDirectory(target) ? path.join(target, "telo.yaml") : target;
      const workspace = this.workspaceAt(path.dirname(manifestPath));
      const module = workspace?.modules.find(
        (candidate) => path.resolve(candidate.manifestPath) === manifestPath,
      );
      return workspace && module ? relation(workspace, module, importer) : { kind: "unmanaged" };
    }

    const transport = this.registry.forRef(source);
    if (!transport) return { kind: "unmanaged" };
    const workspace = this.workspaceAt(importer);
    if (!workspace) return { kind: "unmanaged" };
    const repository = (parseVersionedRef(source)?.baseRef ?? splitIntegrity(source).base).replace(
      /\/+$/,
      "",
    );
    const { targets, diagnostics } = this.targetsOf(workspace);
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (errors.length > 0) {
      return {
        kind: "error",
        message: `the publish destinations of ${workspace.root} cannot be resolved: ${errors[0]!.message}`,
      };
    }
    const key = [...targets].find(([, target]) => target.destination === repository)?.[0];
    const module = key ? workspace.modules.find((candidate) => candidate.key === key) : undefined;
    return module ? relation(workspace, module, importer) : { kind: "unmanaged" };
  }

  /** The published pin of a module a consumer imports, or why there is none. */
  async publishedForm(workspace: Workspace, module: DiscoveredModule): Promise<PublishedForm> {
    const planned = await this.planOf(workspace);
    const errors = planned.plan.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (errors.length > 0) {
      return {
        kind: "error",
        message: `the release plan of ${workspace.root} cannot be formed: ${errors[0]!.message}`,
      };
    }
    return verdictForModule(
      {
        module,
        destination: planned.targets.get(module.key)?.destination,
        planned: planned.plan.units.find((candidate) => candidate.key === module.key),
        published: planned.ledger.units.get(module.key),
      },
      this.registry,
    );
  }

  /** A relative import's verdict: what `--as=published` would do with it. */
  async verdictFor(manifestDir: string, source: string): Promise<LocalImportVerdict> {
    const target = this.targetOf(manifestDir, source);
    if (target.kind === "consumer") return this.publishedForm(target.workspace, target.module);
    if (target.kind === "own") return { kind: "own" };
    return target;
  }

  /** The release workspace holding `dir`, or `null` when it is in none — no
   *  marker above it, or a marker that declares no `release:` block. */
  private workspaceAt(dir: string): Workspace | null {
    const root = findWorkspaceRoot(dir);
    if (!root) return null;
    const known = this.workspaces.get(root);
    if (known !== undefined) return known;
    const workspace = releaseWorkspaceAt(root);
    this.workspaces.set(root, workspace);
    return workspace;
  }

  private targetsOf(workspace: Workspace): ResolvedTargets {
    let resolved = this.targets.get(workspace.root);
    if (!resolved) {
      resolved = resolveTargets(workspace, readLedger(workspace.root), this.options.rungs);
      this.targets.set(workspace.root, resolved);
    }
    return resolved;
  }

  private planOf(workspace: Workspace): Promise<WorkspacePlan> {
    let plan = this.plans.get(workspace.root);
    if (!plan) {
      plan = planWorkspace(workspace, {
        rungs: this.options.rungs,
        // The changed-files reading only asks for changelog entries, which this
        // caller does not report.
        baseRef: "HEAD",
        ...(this.options.onUnit ? { onUnit: this.options.onUnit } : {}),
      });
      this.plans.set(workspace.root, plan);
    }
    return plan;
  }
}

/** How the manifest in `importer` stands to `module`. */
function relation(workspace: Workspace, module: DiscoveredModule, importer: string): ImportTarget {
  // An image module is an application: nothing imports one.
  if (module.artifactKind === "image") return { kind: "unmanaged" };
  const dir = path.resolve(module.dir);
  const relative = relativeImportPath(importer, dir);
  if (isWithin(importer, dir)) return { kind: "own", module, relative };
  if (isWithin(dir, importer)) return { kind: "unmanaged" };
  return { kind: "consumer", workspace, module, relative };
}

/** `../…/<dir>` or `./<dir>`, `/`-separated, naming the directory — no
 *  trailing `telo.yaml` and no trailing slash. */
function relativeImportPath(from: string, to: string): string {
  const relative = path.relative(from, to).split(path.sep).join("/");
  if (relative === "") return ".";
  return relative === ".." || relative.startsWith("../") ? relative : `./${relative}`;
}

function isWithin(dir: string, ancestor: string): boolean {
  const rel = path.relative(ancestor, dir);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}
