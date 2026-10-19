/**
 * Finding `telo-workspace.yaml` on disk — re-exported from the kernel, which owns
 * it because `resolveCacheRoot` anchors the `.telo` cache on the same marker and
 * must answer without a CLI (a child kernel started through the runtime seam, a
 * test harness). The env-file walk finds the marker through the analyzer's
 * `resolveWorkspaceEnv` instead; both stop at the nearest file of that name.
 */

export { WORKSPACE_FILENAME, findWorkspaceRoot, realPath } from "@telorun/kernel";
