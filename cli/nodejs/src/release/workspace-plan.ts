/**
 * The release plan of one workspace: resolve, check the destinations, then
 * collect evidence.
 *
 * Shared by `telo release` and by `telo upgrade --pin-local`, which asks the same
 * question for another reason — a module the plan would bump is one whose
 * published artifact is not what the working copy holds.
 *
 * The two destination checks run FIRST and short-circuit: both are decidable
 * from the manifests alone, and reporting them after sixty payload builds would
 * spend two minutes to say the workspace file is inconsistent — while the
 * payload builder's own refusal, which is what would fire instead, speaks about
 * a manifest published to two places rather than about the file that said so.
 */

import {
  planRelease,
  type Ledger,
  type ModuleKey,
  type ReleasePlan,
} from "@telorun/analyzer";
import * as path from "node:path";
import { ModulePayloadBuilder } from "../bundle/module-payload.js";
import { carriedBy } from "./carried-changes.js";
import { collectEvidence, type ModuleTarget } from "./evidence.js";
import { readFragments, readLedger } from "./ledger-store.js";
import { readImportGraph, resolveTargets, type RegistryRungs } from "./targets.js";
import type { DiscoveredModule, Workspace } from "./workspace.js";

export interface WorkspacePlanOptions {
  readonly rungs: RegistryRungs;
  /** Git ref the changed-files reading diffs against. */
  readonly baseRef: string;
  /** Git ref whose carried fragments are dropped from the plan (`--carried-by`). */
  readonly carriedBy?: string;
  readonly onModule?: (module: DiscoveredModule, index: number, total: number) => void;
}

export interface WorkspacePlan {
  readonly ledger: Ledger;
  readonly targets: ReadonlyMap<ModuleKey, ModuleTarget>;
  readonly plan: ReleasePlan;
}

/** The pending fragments, less those `ref` carries: the same file at its merge
 *  base with HEAD, or written on it since. */
export function pendingFragments(root: string, ref: string | undefined) {
  const fragments = readFragments(root);
  if (!ref) return fragments;
  const carried = carriedBy({ cwd: root, files: fragments.map((fragment) => fragment.source), ref });
  return fragments.filter((fragment) => !carried.has(fragment.source));
}

export async function planWorkspace(
  workspace: Workspace,
  options: WorkspacePlanOptions,
): Promise<WorkspacePlan> {
  const ledger = readLedger(workspace.root);
  const fragments = pendingFragments(workspace.root, options.carriedBy);
  const builder = new ModulePayloadBuilder({ cacheRoot: path.join(workspace.root, ".telo") });

  const { targets, diagnostics } = resolveTargets(workspace, ledger, options.rungs);
  const graph = await readImportGraph(workspace, targets, builder);
  // The marker's own diagnostics travel with the plan, so an entry that
  // discovers nothing is reported by CI and not only by the editor.
  const upfront = [...workspace.diagnostics, ...diagnostics, ...graph.diagnostics];
  if (upfront.some((diagnostic) => diagnostic.severity === "error")) {
    return { ledger, targets, plan: { modules: [], fragments: [], diagnostics: upfront } };
  }

  const modules = await collectEvidence(workspace, {
    targets,
    builder,
    baseRef: options.baseRef,
    ...(options.onModule ? { onModule: options.onModule } : {}),
  });

  const plan = planRelease({ modules, ledger, fragments });
  return { ledger, targets, plan: { ...plan, diagnostics: [...upfront, ...plan.diagnostics] } };
}
