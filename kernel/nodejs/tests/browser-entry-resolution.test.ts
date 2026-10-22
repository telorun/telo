import { readBrowserEntries, type ArtifactLayer } from "@telorun/analyzer";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  controllerBrowserEntryModule,
  directImportSources,
  resolveBrowserEntryFiles,
  type BrowserEntryHost,
  type BrowserEntryModule,
} from "../src/browser-entry-resolution.js";
import { computeFilesIntegrity, type PayloadFile } from "../src/bundle/files-integrity.js";
import { ModuleArtifact } from "../src/bundle/module-artifact.js";
import type { TransportRegistry } from "../src/transports/transport-registry.js";

/**
 * One answer to "what does this browser entry load", whichever way the module
 * arrived: built from source in a checkout, extracted from a published
 * `browser` layer, or carried built inside a packaged application.
 */
const SPECIFIER = "@demo/badges";
const ENTRY = "browser/badges.js";
const SIDECAR = `${ENTRY}.siblings.json`;

const entries = readBrowserEntries({
  exports: {
    browser: [
      {
        specifier: SPECIFIER,
        path: `./${ENTRY}`,
        source: "./src/badges.js",
        abi: "ui-1",
        external: ["@host/runtime"],
        exports: ["StatusPill"],
      },
      {
        specifier: "@demo/charts",
        path: "./browser/charts.js",
        source: "./src/charts.js",
        abi: "ui-1",
        external: ["@host/runtime"],
        exports: ["Bar"],
      },
    ],
  },
}).entries;

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-browser-entry-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(root: string, rel: string, content: string | Uint8Array): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function moduleAt(root: string): BrowserEntryModule {
  fs.mkdirSync(root, { recursive: true });
  return { source: pathToFileURL(path.join(root, "telo.yaml")).href, browser: entries };
}

const host = (artifact?: ModuleArtifact): BrowserEntryHost => ({
  getModuleArtifact: () => artifact,
  getCacheRoot: () => path.join(dir, "cache"),
});

/** A resolution with its locations made relative to the directory it resolved
 *  in, so two resolutions of one module compare whatever directory holds them. */
async function resolved(module: BrowserEntryModule, from: BrowserEntryHost) {
  const files = await resolveBrowserEntryFiles(SPECIFIER, module, from, "Demo.Widget/pill");
  const entryFile = fileURLToPath(files.file);
  const root = entryFile.slice(0, -ENTRY.length);
  const relative = (uri: string) => path.relative(root, fileURLToPath(uri)).split(path.sep).join("/");
  return {
    root,
    answer: { ...files, file: relative(files.file), siblings: files.siblings.map(relative) },
  };
}

/** The module in a source checkout, resolved: the baseline every other
 *  delivery must equal, and the real builder's output on disk. */
async function checkout() {
  const root = path.join(dir, "checkout");
  write(root, "src/shared.js", "export const label = (x) => `status:${x}`;\n");
  write(root, "src/badges.css", ".status-pill { border-radius: 999px; }\n");
  write(
    root,
    "src/badges.js",
    'import "./badges.css";\nimport { h } from "@host/runtime";\nimport { label } from "./shared.js";\n' +
      'export const StatusPill = (p) => h("span", label(p.done));\n',
  );
  write(
    root,
    "src/charts.js",
    'import { h } from "@host/runtime";\nimport { label } from "./shared.js";\n' +
      'export const Bar = (p) => h("div", label(p.done));\n',
  );
  return resolved(moduleAt(root), host());
}

/** The files the build put in the entry's layer: the entry, its sidecar and
 *  everything the sidecar lists. */
function builtFiles(built: Awaited<ReturnType<typeof checkout>>): PayloadFile[] {
  return [ENTRY, SIDECAR, ...built.answer.siblings].map((name) => ({
    name,
    content: fs.readFileSync(path.join(built.root, name)),
  }));
}

async function published(files: PayloadFile[]): Promise<ModuleArtifact> {
  const blob = `sha256:${"3".repeat(64)}`;
  const layer: ArtifactLayer = {
    role: "browser",
    selector: { format: "esm", abi: "ui-1" },
    blob,
    integrity: await computeFilesIntegrity(files),
  };
  const extracted = path.join(dir, "published");
  fs.mkdirSync(extracted, { recursive: true });
  return new ModuleArtifact({
    pinnedRef: "oci://reg.test/demo/widgets@1.0.0#sha256-abc",
    layers: [layer],
    dir: extracted,
    transports: { fetchLayer: async () => files } as unknown as TransportRegistry,
  });
}

describe("resolving a browser entry", () => {
  it("answers from a published browser layer as from the checkout that built it", async () => {
    const built = await checkout();
    expect(built.answer.siblings.length).toBeGreaterThan(0);

    const artifact = await published(builtFiles(built));
    const fromLayer = await resolved(
      { source: "oci://reg.test/demo/widgets@1.0.0", browser: entries },
      host(artifact),
    );

    expect(fromLayer.root).not.toBe(built.root);
    expect(fromLayer.answer).toEqual(built.answer);
  });

  it("answers from a module carried built, with no source on disk", async () => {
    const built = await checkout();
    const carried = path.join(dir, "carried");
    for (const file of builtFiles(built)) write(carried, file.name, file.content as Uint8Array);

    const fromCarried = await resolved(moduleAt(carried), host());

    expect(fs.existsSync(path.join(carried, "src"))).toBe(false);
    expect(fromCarried.answer).toEqual(built.answer);
  });

  it("refuses an entry whose published artifact ships no browser layer for it", async () => {
    const artifact = new ModuleArtifact({
      pinnedRef: "oci://reg.test/demo/widgets@1.0.0#sha256-abc",
      layers: [],
      dir: path.join(dir, "published"),
      transports: { fetchLayer: async () => [] } as unknown as TransportRegistry,
    });
    await expect(
      resolved({ source: "oci://reg.test/demo/widgets@1.0.0", browser: entries }, host(artifact)),
    ).rejects.toMatchObject({
      code: "ERR_BROWSER_ENTRY_UNAVAILABLE",
      message: expect.stringContaining("ships no browser layer"),
    });
  });

  it("refuses an entry whose sidecar names a file outside its layer", async () => {
    write(dir, "outside.js", "export const stolen = 1;\n");
    const files: PayloadFile[] = [
      { name: ENTRY, content: "export const StatusPill = 1;\n" },
      { name: SIDECAR, content: JSON.stringify({ files: [{ path: "../outside.js" }] }) },
    ];
    await expect(
      resolved(
        { source: "oci://reg.test/demo/widgets@1.0.0", browser: entries },
        host(await published(files)),
      ),
    ).rejects.toMatchObject({
      code: "ERR_BROWSER_ENTRY_UNAVAILABLE",
      message: expect.stringContaining("'../outside.js'"),
    });
  });

  it("refuses an entry whose sidecar is missing from its layer", async () => {
    const files: PayloadFile[] = [{ name: ENTRY, content: "export const StatusPill = 1;\n" }];
    await expect(
      resolved(
        { source: "oci://reg.test/demo/widgets@1.0.0", browser: entries },
        host(await published(files)),
      ),
    ).rejects.toMatchObject({
      code: "ERR_BROWSER_ENTRY_UNAVAILABLE",
      message: expect.stringContaining(`'${SIDECAR}' is missing`),
    });
  });

  it("refuses an entry whose sidecar is not the declared shape", async () => {
    const files: PayloadFile[] = [
      { name: ENTRY, content: "export const StatusPill = 1;\n" },
      { name: SIDECAR, content: JSON.stringify([]) },
    ];
    await expect(
      resolved(
        { source: "oci://reg.test/demo/widgets@1.0.0", browser: entries },
        host(await published(files)),
      ),
    ).rejects.toMatchObject({
      code: "ERR_BROWSER_ENTRY_UNAVAILABLE",
      message: expect.stringContaining("is not of the shape"),
    });
  });

  it("ignores sidecar members it does not know", async () => {
    const files: PayloadFile[] = [
      { name: ENTRY, content: "export const StatusPill = 1;\n" },
      { name: "browser/chunks/shared.js", content: "export const shared = 1;\n" },
      {
        name: SIDECAR,
        content: JSON.stringify({
          generation: 2,
          files: [{ path: "browser/chunks/shared.js", preload: true }],
        }),
      },
    ];
    const fromLayer = await resolved(
      { source: "oci://reg.test/demo/widgets@1.0.0", browser: entries },
      host(await published(files)),
    );
    expect(fromLayer.answer.siblings).toEqual(["browser/chunks/shared.js"]);
  });
});

describe("the module a controller's browser entry is resolved against", () => {
  const declaring = (name: string, ...specifiers: string[]): BrowserEntryModule => ({
    source: `file:///${name}/telo.yaml`,
    name,
    browser: readBrowserEntries({
      exports: { browser: specifiers.map((specifier) => ({ specifier, path: "./entry.js" })) },
    }).entries,
  });
  /** `Themes` imports `Contract` from its owner file and `Renderer` from an
   *  `include:` partial, and `Contract` imports `Deep`. */
  const graph = {
    modules: new Map(
      ["Themes", "Contract", "Renderer", "Deep"].map((name) => [
        `file:///${name}/telo.yaml`,
        {
          owner: { source: `file:///${name}/telo.yaml` },
          partials: name === "Themes" ? [{ source: "file:///Themes/partial.yaml" }] : [],
        },
      ]),
    ),
    importEdges: new Map([
      ["file:///Themes/telo.yaml", new Map([["Contract", { targetSource: "file:///Contract/telo.yaml" }]])],
      ["file:///Themes/partial.yaml", new Map([["Renderer", { targetSource: "file:///Renderer/telo.yaml" }]])],
      ["file:///Contract/telo.yaml", new Map([["Deep", { targetSource: "file:///Deep/telo.yaml" }]])],
    ]),
  } as unknown as Parameters<typeof directImportSources>[0];
  const modules = new Map(
    [
      declaring("Themes", "@acme/own"),
      declaring("Contract", "@acme/own", "@acme/contract", "@acme/both"),
      declaring("Renderer", "@acme/both"),
      declaring("Deep", "@acme/deep"),
    ].map((module) => [module.source, module]),
  );
  const themes = modules.get("file:///Themes/telo.yaml")!;
  const importsOfThemes = directImportSources(graph)
    .get(themes.source)!
    .map((source) => modules.get(source)!);
  const moduleFor = (specifier: string) =>
    controllerBrowserEntryModule(specifier, themes, importsOfThemes, "Themes.Theme/look").name;

  it("is the kind's own module first, then the one direct import declaring the entry", () => {
    expect(moduleFor("@acme/own")).toBe("Themes");
    expect(moduleFor("@acme/contract")).toBe("Contract");
    expect(() => moduleFor("@acme/deep")).toThrow(
      expect.objectContaining({ code: "ERR_BROWSER_ENTRY_UNKNOWN" }),
    );
  });

  it("refuses two direct imports declaring the entry, naming both", () => {
    expect(() => moduleFor("@acme/both")).toThrow(
      expect.objectContaining({
        code: "ERR_BROWSER_ENTRY_AMBIGUOUS",
        message: expect.stringContaining(
          "'Contract' (file:///Contract/telo.yaml) and 'Renderer' (file:///Renderer/telo.yaml)",
        ),
      }),
    );
  });
});
