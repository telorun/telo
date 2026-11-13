/**
 * The ledger as it will read once a plan is published, recorded from the tree as
 * it now stands — for a caller seeding a workspace's ledger outside `telo
 * release apply` (which records it itself).
 */

import type { Ledger, ReleasePlan } from "@telorun/release";
import { recordedLedger } from "@telorun/release/node";
import { readLedger } from "./ledger-store.js";
import type { RegistryRungs } from "./targets.js";
import { teloReleaseHost } from "./telo-host.js";
import { loadWorkspace } from "./workspace.js";

export async function recordLedger(root: string, plan: ReleasePlan, rungs: RegistryRungs = {}): Promise<Ledger> {
  return recordedLedger(teloReleaseHost({ rungs: () => rungs }), loadWorkspace(root), readLedger(root), plan, {});
}
