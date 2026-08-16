import type { ArtifactLayer } from "@telorun/analyzer";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { computeFilesIntegrity, type PayloadFile } from "../src/bundle/files-integrity.js";
import { ModuleArtifact } from "../src/bundle/module-artifact.js";
import { BundleControllerLoader } from "../src/controller-loaders/bundle-loader.js";
import type {
  ResolvedSiblingLibrary,
  SiblingLibraryMap,
} from "../src/controller-loaders/sibling-libraries.js";
import type { TransportRegistry } from "../src/transports/transport-registry.js";

/**
 * A module-owned library is resolved at load, not copied into each dependent's
 * bundle — so two dependents of one library share a module scope rather than
 * getting one copy each. These pin the two halves that make that true: the
 * generated resolution beside a bundle, and the fact that both dependents' shims
 * point at the *same* file.
 */
describe("sibling library resolution", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-sibling-lib-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A module on disk: a manifest, and whatever files it ships. */
  function moduleOnDisk(name: string, files: Record<string, string>): string {
    const root = path.join(dir, name);
    for (const [rel, content] of Object.entries(files)) {
      const file = path.join(root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    fs.writeFileSync(path.join(root, "telo.yaml"), "kind: Telo.Library\n");
    return root;
  }

  function libraryOf(
    root: string,
    overrides: Partial<ResolvedSiblingLibrary> = {},
  ): ResolvedSiblingLibrary {
    return {
      specifier: "@acme/shared",
      selector: { format: "js" },
      path: "nodejs/shared.mjs",
      moduleDir: root,
      artifact: undefined,
      moduleSource: pathToFileURL(path.join(root, "telo.yaml")).href,
      moduleVersion: "1.0.0",
      libraries: new Map(),
      ...overrides,
    };
  }

  it("resolves a sibling's specifier to that module's entry point", async () => {
    const library = moduleOnDisk("shared", {
      "nodejs/shared.mjs": "export const marker = 'shared';",
    });
    const consumer = moduleOnDisk("consumer", {
      "nodejs/c.mjs": "export const create = async () => ({});",
    });

    const libraries: SiblingLibraryMap = new Map([["@acme/shared", libraryOf(library)]]);
    await new BundleControllerLoader().resolve(
      "pkg:telo/local/js?path=./nodejs/c.mjs",
      pathToFileURL(path.join(consumer, "telo.yaml")).href,
      undefined,
      libraries,
    );

    const shim = path.join(consumer, "nodejs/node_modules/@acme/shared");
    expect(JSON.parse(fs.readFileSync(path.join(shim, "package.json"), "utf8")).name).toBe(
      "@acme/shared",
    );
    expect(fs.readFileSync(path.join(shim, "index.mjs"), "utf8")).toContain(
      pathToFileURL(path.join(library, "nodejs/shared.mjs")).href,
    );
  });

  it("points two dependents at one file, so the library is one module scope", async () => {
    const library = moduleOnDisk("shared", {
      "nodejs/shared.mjs": "export const marker = 'shared';",
    });
    const consumers = ["one", "two"].map((name) =>
      moduleOnDisk(name, { "nodejs/c.mjs": "export const create = async () => ({});" }),
    );

    const libraries: SiblingLibraryMap = new Map([["@acme/shared", libraryOf(library)]]);
    for (const consumer of consumers) {
      await new BundleControllerLoader().resolve(
        "pkg:telo/local/js?path=./nodejs/c.mjs",
        pathToFileURL(path.join(consumer, "telo.yaml")).href,
        undefined,
        libraries,
      );
    }

    const targets = consumers.map((consumer) =>
      fs.readFileSync(path.join(consumer, "nodejs/node_modules/@acme/shared/index.mjs"), "utf8"),
    );
    expect(targets[0]).toBe(targets[1]);
  });

  it("materializes the library layer of a published sibling", async () => {
    const files: PayloadFile[] = [{ name: "nodejs/shared.mjs", content: "export const x = 1;" }];
    const blob = `sha256:${"2".repeat(64)}`;
    const layer: ArtifactLayer = {
      role: "library",
      selector: { format: "js" },
      blob,
      integrity: await computeFilesIntegrity(files),
    };
    const libraryDir = path.join(dir, "published");
    fs.mkdirSync(libraryDir, { recursive: true });
    const artifact = new ModuleArtifact({
      pinnedRef: "oci://reg.test/acme/shared@1.0.0#sha256-abc",
      layers: [layer],
      dir: libraryDir,
      transports: {
        fetchLayer: async (_ref: string, asked: string) => {
          if (asked !== blob) throw new Error(`no such blob ${asked}`);
          return files;
        },
      } as unknown as TransportRegistry,
    });

    const consumer = moduleOnDisk("consumer", {
      "nodejs/c.mjs": "export const create = async () => ({});",
    });
    const libraries: SiblingLibraryMap = new Map([
      ["@acme/shared", libraryOf(libraryDir, { artifact })],
    ]);

    await new BundleControllerLoader().resolve(
      "pkg:telo/local/js?path=./nodejs/c.mjs",
      pathToFileURL(path.join(consumer, "telo.yaml")).href,
      undefined,
      libraries,
    );

    // Extracted from the artifact, and the consumer's shim points into it.
    expect(fs.existsSync(path.join(libraryDir, "nodejs/shared.mjs"))).toBe(true);
    expect(
      fs.readFileSync(path.join(consumer, "nodejs/node_modules/@acme/shared/index.mjs"), "utf8"),
    ).toContain(pathToFileURL(path.join(libraryDir, "nodejs/shared.mjs")).href);
  });

  it("never writes through a slot a package manager owns", async () => {
    // The shape a pnpm workspace produces, and the one the prebuilt-`path=` branch
    // imports out of: node_modules/@acme/shared is a symlink INTO the library's own
    // source tree, so writing the shim through it would replace that package's real
    // package.json.
    const library = moduleOnDisk("shared", {
      "nodejs/shared.mjs": "export const marker = 'shared';",
      "nodejs/package.json": '{ "name": "@acme/shared", "version": "9.9.9" }\n',
    });
    const consumer = moduleOnDisk("consumer", {
      "nodejs/c.mjs": "export const create = async () => ({});",
    });
    const slot = path.join(consumer, "nodejs/node_modules/@acme");
    fs.mkdirSync(slot, { recursive: true });
    fs.symlinkSync(path.join(library, "nodejs"), path.join(slot, "shared"), "dir");

    const libraries: SiblingLibraryMap = new Map([["@acme/shared", libraryOf(library)]]);
    await new BundleControllerLoader().resolve(
      "pkg:telo/local/js?path=./nodejs/c.mjs",
      pathToFileURL(path.join(consumer, "telo.yaml")).href,
      undefined,
      libraries,
    );

    expect(JSON.parse(fs.readFileSync(path.join(library, "nodejs/package.json"), "utf8"))).toEqual({
      name: "@acme/shared",
      version: "9.9.9",
    });
    expect(fs.existsSync(path.join(library, "nodejs/index.mjs"))).toBe(false);
  });

  it("rewrites its own shim when the entry point moves", async () => {
    const library = moduleOnDisk("shared", {
      "nodejs/shared.mjs": "export const marker = 'shared';",
      "nodejs/other.mjs": "export const marker = 'other';",
    });
    const consumer = moduleOnDisk("consumer", {
      "nodejs/c.mjs": "export const create = async () => ({});",
    });
    const baseUri = pathToFileURL(path.join(consumer, "telo.yaml")).href;
    const purl = "pkg:telo/local/js?path=./nodejs/c.mjs";
    const shim = path.join(consumer, "nodejs/node_modules/@acme/shared/index.mjs");

    await new BundleControllerLoader().resolve(
      purl,
      baseUri,
      undefined,
      new Map([["@acme/shared", libraryOf(library)]]),
    );
    await new BundleControllerLoader().resolve(
      purl,
      baseUri,
      undefined,
      new Map([["@acme/shared", libraryOf(library, { path: "nodejs/other.mjs" })]]),
    );

    expect(fs.readFileSync(shim, "utf8")).toContain(
      pathToFileURL(path.join(library, "nodejs/other.mjs")).href,
    );
  });

  it("reports a library the sibling ships no layer for, rather than importing nothing", async () => {
    const consumer = moduleOnDisk("consumer", {
      "nodejs/c.mjs": "export const create = async () => ({});",
    });
    const emptyDir = path.join(dir, "empty");
    fs.mkdirSync(emptyDir, { recursive: true });
    const artifact = new ModuleArtifact({
      pinnedRef: "oci://reg.test/acme/shared@1.0.0#sha256-abc",
      layers: [],
      dir: emptyDir,
      transports: { fetchLayer: async () => [] } as unknown as TransportRegistry,
    });
    const libraries: SiblingLibraryMap = new Map([
      ["@acme/shared", libraryOf(emptyDir, { artifact })],
    ]);

    await expect(
      new BundleControllerLoader().resolve(
        "pkg:telo/local/js?path=./nodejs/c.mjs",
        pathToFileURL(path.join(consumer, "telo.yaml")).href,
        undefined,
        libraries,
      ),
    ).rejects.toThrow(/ships no js library layer/);
  });
});
