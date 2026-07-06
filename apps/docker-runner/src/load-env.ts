import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "dotenv-flow";

/**
 * Load the runner's dotenv-flow files (`.env`, `.env.local`, and any
 * `.env.<node_env>[.local]`) from the runner package directory into
 * `process.env`. Lets an operator drop secret-bearing config (e.g. the
 * `RUNNER_APPS` catalog, whose entries may embed secrets in `env`) in a file
 * instead of threading it through the container's environment.
 *
 * Resolved relative to this module so it works whether the runner runs from
 * `src/` (tsx) or `dist/` — both sit one level under the package root. Existing
 * environment variables always take precedence over file values.
 */
export function loadRunnerEnvFiles(): void {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  config({ path: dir, silent: true });
}
