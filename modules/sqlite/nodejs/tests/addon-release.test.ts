import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));

// The controller bundles better-sqlite3's JavaScript and loads the addon the
// module stages; the two must come from one release.
describe("better-sqlite3", () => {
  it("bundles the JavaScript of the release whose addons the module stages", () => {
    const moduleDoc = parseAllDocuments(readFileSync(join(here, "../../telo.yaml"), "utf8"))[0]!.toJSON();
    const wrapper = JSON.parse(
      readFileSync(join(here, "../node_modules/better-sqlite3/package.json"), "utf8"),
    );

    expect(wrapper.version).toBe(moduleDoc.sources["better-sqlite3"].version);
  });
});
