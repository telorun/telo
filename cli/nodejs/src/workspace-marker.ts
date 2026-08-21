/**
 * Finding `telo-workspace.yaml` on disk — re-exported from the kernel, which owns
 * it because `resolveCacheRoot` anchors the `.telo` cache on the same marker and
 * must answer without a CLI (a child kernel started through the runtime seam, a
 * test harness). Two walks would eventually disagree about what "this repo" means
 * for env collection and for the cache.
 */

export { WORKSPACE_FILENAME, findWorkspaceRoot, realPath } from "@telorun/kernel";
