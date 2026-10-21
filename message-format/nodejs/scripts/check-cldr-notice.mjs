/**
 * The `prepack` guard for the CLDR notice. The Unicode License V3 asks that its
 * notice travel with every copy of the data, so a tarball is refused unless:
 *
 * - `LICENSE-CLDR` sits beside `package.json` and is `message-format/cldr/LICENSE`;
 * - the built `dist/cldr-data.js` and the shipped `src/cldr-data.ts` both open with
 *   the `/*! *\/` notice holding that text, which survives bundling.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const license = readFileSync(join(root, "..", "cldr", "LICENSE"), "utf8");
const failures = [];

const shipped = join(root, "LICENSE-CLDR");
if (!existsSync(shipped)) failures.push("LICENSE-CLDR is missing beside package.json.");
else if (readFileSync(shipped, "utf8") !== license) failures.push("LICENSE-CLDR is not message-format/cldr/LICENSE.");

for (const file of ["src/cldr-data.ts", "dist/cldr-data.js"]) {
  const path = join(root, file);
  if (!existsSync(path)) {
    failures.push(`${file} is missing; build the package before packing it.`);
    continue;
  }
  const text = readFileSync(path, "utf8");
  if (!text.startsWith("/*!") || !text.slice(0, text.indexOf("*/")).includes(license.trimEnd())) {
    failures.push(`${file} does not open with the /*! */ CLDR licence notice.`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exit(1);
}
console.log("the CLDR licence notice ships with @telorun/message-format.");
