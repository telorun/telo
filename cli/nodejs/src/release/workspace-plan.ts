/**
 * The release plan of one workspace as `telo release status` forms it, for the
 * callers that ask the same question for another reason: `telo release imports`
 * (and its deprecated alias `telo upgrade --pin-local`) — a module the plan would
 * bump is one whose published artifact is not what the working copy holds.
 */

import type { Ledger, ReleasePlan, UnitKey as ModuleKey } from "@telorun/release";
import { planWorkspaceRelease } from "@telorun/release/node";
import type { ModuleTarget } from "./evidence.js";
import { readLedger } from "./ledger-store.js";
import { resolveTargets, type RegistryRungs } from "./targets.js";
import { teloReleaseHost } from "./telo-host.js";
import type { Workspace } from "./workspace.js";

export interface WorkspacePlanOptions {
  readonly rungs: RegistryRungs;
  /** Git ref the changed-files reading diffs against. */
  readonly baseRef: string;
  /** Git ref whose carried fragments are dropped from the plan (`--carried-by`). */
  readonly carriedBy?: string;
  readonly onUnit?: (unit: { readonly key: ModuleKey }, index: number, total: number) => void;
}

export interface WorkspacePlan {
  readonly ledger: Ledger;
  readonly targets: ReadonlyMap<ModuleKey, ModuleTarget>;
  readonly plan: ReleasePlan;
}

export async function planWorkspace(workspace: Workspace, options: WorkspacePlanOptions): Promise<WorkspacePlan> {
  const host = teloReleaseHost({ rungs: () => options.rungs });
  const run = await planWorkspaceRelease(host, workspace, {}, {
    baseRef: options.baseRef,
    ...(options.carriedBy ? { carriedBy: options.carriedBy } : {}),
    ...(options.onUnit ? { onUnit: options.onUnit } : {}),
  });
  return { ledger: run.ledger, targets: resolveTargets(workspace, readLedger(workspace.root), options.rungs).targets, plan: run.plan };
}
