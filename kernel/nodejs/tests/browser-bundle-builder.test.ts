import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildBrowserEntries,
  readBrowserSiblings,
  type BrowserBuildGroup,
} from "../src/controller-loaders/browser-bundle-builder.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-browser-build-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const file = path.join(dir, "module", rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const group = (overrides: Partial<BrowserBuildGroup> = {}): BrowserBuildGroup => ({
  moduleDir: path.join(dir, "module"),
  external: ["@host/runtime"],
  entries: [
    {
      specifier: "@demo/badges",
      source: path.join(dir, "module/src/badges.js"),
      path: "browser/badges.js",
      exports: ["StatusPill"],
    },
    {
      specifier: "@demo/charts",
      source: path.join(dir, "module/src/charts.js"),
      path: "browser/charts.js",
      exports: ["Bar"],
    },
  ],
  ...overrides,
});

function writeSources(): void {
  // A dependency nothing lists as external, reached by a bare specifier.
  write("node_modules/tiny-dep/package.json", JSON.stringify({ name: "tiny-dep", main: "index.js" }));
  write("node_modules/tiny-dep/index.js", 'module.exports.mark = "TINY_DEP_BODY";\n');
  write("src/shared.js", 'import { mark } from "tiny-dep";\nexport const label = (x) => `${mark}:${x}`;\n');
  write("src/badges.css", ".status-pill { border-radius: 999px; }\n");
  write(
    "src/badges.js",
    'import "./badges.css";\nimport { h } from "@host/runtime";\nimport { label } from "./shared.js";\n' +
      'export const StatusPill = (p) => h("span", label(p.done));\n',
  );
  write(
    "src/charts.js",
    'import { h } from "@host/runtime";\nimport { label } from "./shared.js";\n' +
      'export const Bar = (p) => h("div", label(p.done));\n',
  );
}

describe("buildBrowserEntries", () => {
  it("builds the entries of one group together, so what they share is one chunk", async () => {
    writeSources();
    const built = await buildBrowserEntries(group(), path.join(dir, "cache"));
    const read = (file: string) => fs.readFileSync(path.join(built.directory, file), "utf8");

    const badges = await readBrowserSiblings(built.directory, "browser/badges.js");
    const charts = await readBrowserSiblings(built.directory, "browser/charts.js");
    const chunk = badges.find((file) => file.endsWith(".js"))!;

    // One chunk, loaded by both entries, holding the shared module and the
    // dependency no `external` names.
    expect(charts).toEqual([chunk]);
    expect(chunk).toMatch(/^browser\/chunks\/.+\.js$/);
    expect(read(chunk)).toContain("TINY_DEP_BODY");
    expect(read("browser/badges.js")).not.toContain("TINY_DEP_BODY");
    // The stylesheet an entry's sources import is a file beside that entry.
    expect(badges).toEqual(["browser/badges.css", chunk].sort());
    expect(read("browser/badges.css")).toContain(".status-pill");
    // An `external` name stays an import for the page to resolve.
    expect(read("browser/badges.js")).toMatch(/from\s*"@host\/runtime"/);
    expect(built.files).toEqual(
      [
        "browser/badges.css",
        "browser/badges.js",
        "browser/badges.js.siblings.json",
        "browser/charts.js",
        "browser/charts.js.siblings.json",
        chunk,
      ].sort(),
    );
  });

  it("serves the same directory again until an input changes", async () => {
    writeSources();
    const cache = path.join(dir, "cache");
    const first = await buildBrowserEntries(group(), cache);
    expect((await buildBrowserEntries(group(), cache)).directory).toBe(first.directory);

    write("src/shared.js", "export const label = (x) => `changed:${x}`;\n");
    const rebuilt = await buildBrowserEntries(group(), cache);
    expect(rebuilt.directory).not.toBe(first.directory);
    expect(fs.existsSync(first.directory)).toBe(false);
  });

  it("refuses an entry whose source lacks an export it declares", async () => {
    writeSources();
    const declared = group();
    const missing = group({
      entries: [{ ...declared.entries[0]!, exports: ["StatusPill", "Missing"] }, declared.entries[1]!],
    });
    await expect(buildBrowserEntries(missing, path.join(dir, "cache"))).rejects.toMatchObject({
      code: "ERR_BROWSER_BUILD_FAILED",
      message: expect.stringContaining("declares the export 'Missing'"),
    });
  });

  it("reports a source that does not build", async () => {
    writeSources();
    write("src/charts.js", 'import { nothing } from "./absent.js";\nexport const Bar = nothing;\n');
    await expect(buildBrowserEntries(group(), path.join(dir, "cache"))).rejects.toMatchObject({
      code: "ERR_BROWSER_BUILD_FAILED",
      message: expect.stringContaining("absent.js"),
    });
  });
});
