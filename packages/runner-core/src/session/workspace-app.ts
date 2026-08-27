import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The name the manifest is mounted under, in every backend. */
export const WORKSPACE_APP_FILENAME = "telo.yaml";

/**
 * The workspace application's manifest, read from the package rather than
 * inlined as a string: it is a Telo manifest, so it must stay a `.yaml` file the
 * repo's own `telo check` and formatter see. It lives in runner-core because the
 * workspace surface is part of the `/v1` session contract — both backends mount
 * the same bytes, and a copy per backend would be two manifests to hold in
 * agreement.
 *
 * Read once and memoized: it never changes within a process.
 */
let cached: string | undefined;

export function workspaceAppManifest(): string {
  if (cached !== undefined) return cached;
  // `dist/session/` at runtime, `src/session/` under a source run — three levels
  // up is the package root either way.
  const here = dirname(fileURLToPath(import.meta.url));
  cached = readFileSync(join(here, "..", "..", "workspace-app", WORKSPACE_APP_FILENAME), "utf8");
  return cached;
}
