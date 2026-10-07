/**
 * Turning a relative import of a released module back into its published pin.
 *
 * A consumer in the same repository — an example, a starter, an application —
 * imports a module by relative path while a change to that module is unreleased,
 * and should name the published artifact again once it ships. `telo upgrade
 * --pin-local` asks this file, per relative import, whether that moment has come.
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

import {
  WORKSPACE_FILENAME,
  readWorkspaceConfig,
  type LedgerEntry,
  type PlannedModule,
} from "@telorun/analyzer";
import { defaultTransportRegistry, type TransportRegistry } from "@telorun/kernel";
import * as fs from "node:fs";
import * as path from "node:path";
import semver from "semver";
import { findWorkspaceRoot } from "../workspace-marker.js";
import { describeReason } from "./render.js";
import type { RegistryRungs } from "./targets.js";
import { loadWorkspace, type DiscoveredModule, type Workspace } from "./workspace.js";
import { planWorkspace, type WorkspacePlan } from "./workspace-plan.js";

export type LocalImportVerdict =
  /** Not a released module of any workspace — an application's own library. */
  | { readonly kind: "unmanaged" }
  | { readonly kind: "pinned"; readonly pin: string; readonly version: string }
  /** A released module whose published artifact is not the working copy yet. */
  | { readonly kind: "pending"; readonly reason: string }
  | { readonly kind: "error"; readonly message: string };

export interface ModuleReleaseState {
  readonly module: Pick<DiscoveredModule, "key" | "version">;
  /** Where the module publishes, absent when no destination resolved. */
  readonly destination: string | undefined;
  /** The module's entry in the release plan, when the plan bumps it. */
  readonly planned: PlannedModule | undefined;
  /** What the ledger records as published. */
  readonly published: LedgerEntry | undefined;
}

/** Exported for tests. */
export async function verdictForModule(
  state: ModuleReleaseState,
  registry: TransportRegistry,
): Promise<LocalImportVerdict> {
  const { module, destination, planned, published } = state;
  if (planned) {
    const reasons = [...new Set(planned.reasons.map(describeReason))].join("; ");
    return {
      kind: "pending",
      reason: `${module.key} has an unreleased change (${planned.from} → ${planned.to}: ${reasons})`,
    };
  }
  if (!published) {
    return { kind: "pending", reason: `${module.key} has never been released` };
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
  readonly onModule?: (module: DiscoveredModule, index: number, total: number) => void;
  readonly registry?: TransportRegistry;
}

/**
 * Answers per relative import, building each workspace's release plan at most
 * once and only when an import actually names one of its modules — a manifest
 * with no such import pays nothing.
 */
export class LocalImportPinner {
  private readonly workspaces = new Map<string, Workspace | null>();
  private readonly plans = new Map<string, Promise<WorkspacePlan>>();
  private readonly registry: TransportRegistry;

  constructor(private readonly options: LocalImportPinnerOptions) {
    this.registry = options.registry ?? defaultTransportRegistry();
  }

  /** `source` is the import as written, relative to `manifestDir`. */
  async verdictFor(manifestDir: string, source: string): Promise<LocalImportVerdict> {
    const target = path.resolve(manifestDir, source);
    const targetDir = isDirectory(target) ? target : path.dirname(target);

    const workspace = this.workspaceAt(targetDir);
    const module = workspace?.modules.find((candidate) => path.resolve(candidate.dir) === targetDir);
    // An image module is an application: nothing imports one, so there is no pin
    // to write for it. A manifest inside the module it imports is that module's
    // own test or fixture, which exists to exercise the working copy.
    if (!workspace || !module || module.artifactKind === "image") return { kind: "unmanaged" };
    if (isWithin(path.resolve(manifestDir), targetDir)) return { kind: "unmanaged" };

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
        planned: planned.plan.modules.find((candidate) => candidate.key === module.key),
        published: planned.ledger.modules.get(module.key),
      },
      this.registry,
    );
  }

  /** The release workspace holding `dir`, or `null` when it is in none — no
   *  marker above it, or a marker that declares no `release:` block. */
  private workspaceAt(dir: string): Workspace | null {
    const root = findWorkspaceRoot(dir);
    if (!root) return null;
    const known = this.workspaces.get(root);
    if (known !== undefined) return known;

    const marker = fs.readFileSync(path.join(root, WORKSPACE_FILENAME), "utf8");
    const releases = readWorkspaceConfig(marker, WORKSPACE_FILENAME).config.release !== undefined;
    const workspace = releases ? loadWorkspace(root) : null;
    this.workspaces.set(root, workspace);
    return workspace;
  }

  private planOf(workspace: Workspace): Promise<WorkspacePlan> {
    let plan = this.plans.get(workspace.root);
    if (!plan) {
      plan = planWorkspace(workspace, {
        rungs: this.options.rungs,
        // The changed-files reading only asks for changelog entries, which this
        // caller does not report.
        baseRef: "HEAD",
        ...(this.options.onModule ? { onModule: this.options.onModule } : {}),
      });
      this.plans.set(workspace.root, plan);
    }
    return plan;
  }
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
