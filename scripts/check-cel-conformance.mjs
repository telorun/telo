/**
 * Replays the CEL conformance vectors through `@telorun/cel`'s front end.
 *
 * The vectors directory is a parameter of the package's conformance config, and
 * this script is the only thing in the repository that names where the vectors
 * currently live — so moving them is a one-line change here, and `@telorun/cel`'s
 * own test suite never needs a sibling package's tree to exist.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const vectors = fileURLToPath(new URL("templating/cel-conformance/", root));

const result = spawnSync("pnpm", ["--filter", "@telorun/cel", "run", "test:conformance"], {
  cwd: fileURLToPath(root),
  env: { ...process.env, CEL_CONFORMANCE_DIR: vectors },
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
