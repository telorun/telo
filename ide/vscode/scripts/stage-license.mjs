// vsce reads LICENSE from the extension root, and `license: "SEE LICENSE IN
// LICENSE"` promises one is there. The repo keeps a single canonical copy, so
// stage it in rather than committing a second one that can drift out of sync.
import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
copyFileSync(join(here, "../../../LICENSE"), join(here, "../LICENSE"));
