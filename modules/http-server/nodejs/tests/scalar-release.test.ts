import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));

// The page HTML comes from @scalar/core and the script that reads it from the
// staged standalone.js; they agree only when both come from one Scalar release.
describe("Scalar's staged browser bundle", () => {
  it("is from the release whose rendering libraries the controller bundles", () => {
    const moduleDoc = parseAllDocuments(readFileSync(join(here, "../../telo.yaml"), "utf8"))[0]!.toJSON();
    const release = readJson(join(here, "../node_modules/@scalar/fastify-api-reference/package.json"));
    const own = readJson(join(here, "../package.json"));

    expect(release.version).toBe(moduleDoc.sources.scalar.version);
    expect({
      "@scalar/core": own.dependencies["@scalar/core"],
      "@scalar/openapi-parser": own.dependencies["@scalar/openapi-parser"],
    }).toEqual({
      "@scalar/core": release.dependencies["@scalar/core"],
      "@scalar/openapi-parser": release.dependencies["@scalar/openapi-parser"],
    });
  });
});
