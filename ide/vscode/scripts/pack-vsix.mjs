// Packs the extension with its markdown links resolved to the release tag, then
// puts the working tree back. Relative links in source resolve against any ref
// on GitHub; inside a .vsix they resolve against nothing.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extension = join(here, "..");
const rewrite = join(here, "..", "..", "..", "scripts", "rewrite-pack-links.mjs");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: extension, stdio: "inherit", shell: process.platform === "win32" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

let status = run(process.execPath, [rewrite, "."]);
if (status === 0) status = run("pnpm", ["exec", "vsce", "package", "--no-dependencies", "--out", "telo-vscode.vsix"]);
const restored = run(process.execPath, [rewrite, ".", "--restore"]);
process.exit(status !== 0 ? status : restored);
