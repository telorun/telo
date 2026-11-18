import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `@telorun/host-runner`'s own version — the server's, reported on `/v1/health`.
 * A single-file executable has no `package.json`, so its build bakes the value
 * (`__TELO_BAKED_VERSIONS__`); every other distribution reads its manifest.
 */
declare const __TELO_BAKED_VERSIONS__: Record<string, string> | undefined;

const PACKAGE_NAME = "@telorun/host-runner";

export function hostRunnerVersion(): string | undefined {
  if (typeof __TELO_BAKED_VERSIONS__ === "object" && __TELO_BAKED_VERSIONS__ !== null) {
    const baked = __TELO_BAKED_VERSIONS__[PACKAGE_NAME];
    if (baked) return baked;
  }
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      const pkg = JSON.parse(fs.readFileSync(candidate, "utf8")) as { name?: string; version?: string };
      if (pkg.name === PACKAGE_NAME && typeof pkg.version === "string") return pkg.version;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
