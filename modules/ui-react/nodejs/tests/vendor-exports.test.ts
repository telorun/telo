import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

// The built entries are React's production build.
process.env.NODE_ENV = "production";
const require = createRequire(import.meta.url);

const manifest = parseAllDocuments(readFileSync(new URL("../../telo.yaml", import.meta.url), "utf8"), { logLevel: "silent" })[0].toJS();
const declared = (specifier: string): string[] =>
  manifest.exports.browser.find((entry: { specifier: string }) => entry.specifier === specifier).exports;

describe.each([
  ["react", "react"],
  ["react/jsx-runtime", "react-jsx-runtime"],
  ["react-dom", "react-dom"],
  ["react-dom/client", "react-dom-client"],
])("the %s entry", (specifier, file) => {
  it("exports by name exactly what the package has, in its source and in the manifest", async () => {
    const packageKeys = Object.keys(require(specifier)).sort();
    const shim = await import(`../src/browser/vendor/${file}.ts`);
    expect(Object.keys(shim).filter((name) => name !== "default").sort()).toEqual(packageKeys);
    expect([...declared(specifier)].sort()).toEqual(packageKeys);
  });
});

describe("the host entry", () => {
  it("exports exactly useHost", async () => {
    expect(declared("@telorun/ui-react")).toEqual(["useHost"]);
    const source = readFileSync(new URL("../src/browser/host-entry.ts", import.meta.url), "utf8");
    expect(source.match(/^export .*$/gm)).toEqual(['export { useHost } from "./host.js";']);
  });
});
