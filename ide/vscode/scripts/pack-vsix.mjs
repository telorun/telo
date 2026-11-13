// Packs the staged extension (`stage-vsix.mjs`) into `telo-vscode.vsix`: what
// ships is the staged directory itself, so it is what the release planner digests.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extension = join(here, "..");

function run(command, args, cwd, stdout) {
  const result = spawnSync(command, args, { cwd, stdio: ["ignore", stdout, "inherit"], shell: process.platform === "win32" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

// The staging script's stdout is the payload listing; here only its work matters.
let status = run(process.execPath, [join(here, "stage-vsix.mjs")], extension, "ignore");
if (status === 0) {
  // The unit's own vsce, run from the staged directory.
  const vsce = join(extension, "node_modules", ".bin", process.platform === "win32" ? "vsce.cmd" : "vsce");
  status = run(vsce, ["package", "--no-dependencies", "--out", "../../telo-vscode.vsix"], join(extension, "dist", "vsix"), "inherit");
}
process.exit(status);
