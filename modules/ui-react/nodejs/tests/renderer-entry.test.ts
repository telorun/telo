import * as source from "@telorun/message-format";
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import { loadVectors } from "../../../../message-format/nodejs/conformance/load-vectors.js";
import { runVectors, type MessageFormatCore } from "../../../../message-format/nodejs/conformance/vector-runner.js";

/**
 * The renderer browser entry as the kernel builds it — the entry's own
 * declaration (source, external list, exports) under the kernel's browser
 * build options — holds the message core every browser formats with: it
 * answers the core's conformance vectors as the package does, and it carries
 * the Unicode notice of the CLDR data inlined into it.
 */
const manifest = parseAllDocuments(readFileSync(new URL("../../telo.yaml", import.meta.url), "utf8"), { logLevel: "silent" })[0].toJS();
const entry = manifest.exports.browser.find((each: { specifier: string }) => each.specifier === "@telorun/ui-react-renderer");

// The built entry runs React's production build, as a page does.
process.env.NODE_ENV = "production";

let directory: string;
let built: string;
let module: Record<string, unknown>;

beforeAll(async () => {
  // Built beside this package's dependencies, so the entry's external imports
  // resolve as a page's import map resolves them.
  directory = mkdtempSync(join(fileURLToPath(new URL("../node_modules/", import.meta.url)), ".renderer-entry-"));
  const result = await build({
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    splitting: true,
    conditions: ["source"],
    define: { "process.env.NODE_ENV": '"production"' },
    external: entry.external,
    entryPoints: { renderer: fileURLToPath(new URL(`../../${entry.source}`, import.meta.url)) },
    outdir: directory,
    logLevel: "silent",
  });
  expect(result.errors).toEqual([]);
  built = readFileSync(join(directory, "renderer.js"), "utf8");
  module = await import(pathToFileURL(join(directory, "renderer.js")).href);
}, 60_000);

afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("the renderer entry as built", () => {
  it("exports every name it declares", () => {
    expect(Object.keys(module).sort()).toEqual([...entry.exports].sort());
  });

  it("answers the message core's conformance vectors as the core does", () => {
    const vectors = loadVectors();
    const report = runVectors(module as unknown as MessageFormatCore, vectors);
    expect(report.failures).toEqual([]);
    expect(report.counts).toEqual(runVectors(source, vectors).counts);
  });

  it("carries the Unicode license notice of the CLDR data it inlines", () => {
    expect(built).toMatch(/\/\*![^]*CLDR data \(Unicode CLDR, https:\/\/cldr\.unicode\.org\), used under this licence:[^]*SPDX-License-Identifier: Unicode-3\.0/);
  });
});
