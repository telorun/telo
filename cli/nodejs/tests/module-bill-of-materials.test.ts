import {
  INCOMPLETE_PROPERTY,
  LAYER_PROPERTY,
  selectorKey,
  type ArtifactLayer,
  type BillOfMaterials,
} from "@telorun/analyzer";
import { computeFilesIntegrity, readOwnerManifest, type PayloadFile } from "@telorun/kernel";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readArtifactBillOfMaterials } from "../src/bundle/module-bill-of-materials.js";
import { ModulePayloadBuilder, type ModulePayload } from "../src/bundle/module-payload.js";

let workdir: string;
let mod: string;

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-sbom-test-"));
  mod = path.join(workdir, "mod");
});

afterEach(() => {
  fs.rmSync(workdir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const abs = path.join(mod, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const DESTINATION = "oci://registry.example/test/vault";

function controllerModule(extra: string[] = []): string {
  return [
    "kind: Telo.Library",
    "metadata:",
    "  name: Vault",
    "  version: 0.3.0",
    "  license: MIT",
    ...extra,
    "---",
    "kind: Telo.Definition",
    "metadata:",
    "  name: Store",
    "capability: Telo.Invocable",
    "controllers:",
    "  - pkg:telo/local/js?path=./nodejs/vault.mjs&local_path=./nodejs/src/index.ts#Store",
    "schema: { type: object }",
    "",
  ].join("\n");
}

function writePackage(dir: string, json: Record<string, unknown>, source: string): void {
  write(`${dir}/package.json`, JSON.stringify(json));
  write(`${dir}/index.js`, source);
}

const build = (manifest = "telo.yaml", stagedFiles: "pins" | "disk" = "pins") =>
  new ModulePayloadBuilder({ cacheRoot: path.join(workdir, ".telo"), stagedFiles }).payload(
    path.join(mod, manifest),
    DESTINATION,
  );

const recordOf = (payload: ModulePayload): BillOfMaterials => payload.billOfMaterials.record;

function occurrences(record: BillOfMaterials, ref: string): string[] {
  const component = record.components?.find((entry) => entry["bom-ref"] === ref);
  return (component?.properties ?? [])
    .filter((property) => property.name === LAYER_PROPERTY)
    .map((property) => property.value);
}

function incomplete(record: BillOfMaterials): string[] {
  return (record.metadata.component.properties ?? [])
    .filter((property) => property.name === INCOMPLETE_PROPERTY)
    .map((property) => property.value);
}

/** Every `telo:layer` / `telo:incomplete` value, minus its `role=` pair, is the
 *  canonical key of a selector in the published index, or empty. */
function assertOccurrencesNameIndexedLayers(payload: ModulePayload): void {
  const index = readOwnerManifest(payload.manifest).layers ?? [];
  const known = new Set(index.map((layer) => (layer.selector ? `role=${layer.role};${selectorKey(layer.selector)}` : `role=${layer.role}`)));
  const record = recordOf(payload);
  const values = [
    ...incomplete(record),
    ...(record.components ?? []).flatMap((component) => (component.properties ?? []).map((p) => p.value)),
  ];
  for (const value of values) expect(known, value).toContain(value);
}

describe("the bill of materials of a bundle", () => {
  beforeEach(() => {
    write("telo.yaml", controllerModule());
    write("nodejs/package.json", JSON.stringify({ name: "@acme/vault-build", version: "0.3.0" }));
    writePackage("node_modules/left-pad", { name: "left-pad", version: "1.3.0", license: "WTFPL" }, "export const leftPad = (s) => ` ${s}`;\nexport const unused = () => 'tree-shaken';\n");
    writePackage("node_modules/@scope/kit", { name: "@scope/kit", version: "2.0.0", license: "MIT" }, "export const kit = 1;\n");
  });

  it("lists each inlined package at its version, in its layer, and leaves the module's own build package out", async () => {
    write(
      "nodejs/src/index.ts",
      'import { leftPad } from "left-pad";\nimport { kit } from "@scope/kit";\nexport const Store = { leftPad, kit };\n',
    );
    const payload = await build();
    const record = recordOf(payload);

    expect(record.metadata.component).toEqual({
      type: "library",
      name: "Vault",
      version: "0.3.0",
      licenses: [{ license: { id: "MIT" } }],
    });
    expect((record.components ?? []).map((component) => component["bom-ref"])).toEqual([
      "pkg:npm/%40scope/kit@2.0.0",
      "pkg:npm/left-pad@1.3.0",
    ]);
    expect(record.components![0]).toMatchObject({ name: "@scope/kit", version: "2.0.0", purl: "pkg:npm/%40scope/kit@2.0.0" });
    expect(occurrences(record, "pkg:npm/left-pad@1.3.0")).toEqual(["role=controller;format=js"]);
    expect(incomplete(record)).toEqual([]);
    expect(payload.layers.at(-1)!.role).toBe("sbom");
    assertOccurrencesNameIndexedLayers(payload);
    const real = fs.realpathSync.native(mod);
    expect(payload.recordedVersionFiles).toEqual([
      path.join(real, "node_modules/@scope/kit/package.json"),
      path.join(real, "node_modules/left-pad/package.json"),
    ]);
  });

  it("gives identical record bytes when built twice from one tree", async () => {
    write("nodejs/src/index.ts", 'import { leftPad } from "left-pad";\nexport const Store = { leftPad };\n');
    const first = await build();
    const second = await build();
    const sbom = (payload: ModulePayload) => readOwnerManifest(payload.manifest).layers!.find((l) => l.role === "sbom")!;
    expect(sbom(second)).toEqual(sbom(first));
  });

  it("drops a package once no import reaches it", async () => {
    write("nodejs/src/index.ts", 'import { leftPad } from "left-pad";\nimport { kit } from "@scope/kit";\nexport const Store = { leftPad, kit };\n');
    expect(recordOf(await build()).components).toHaveLength(2);

    write("nodejs/src/index.ts", 'import { kit } from "@scope/kit";\nexport const Store = { kit };\n');
    const after = recordOf(await build());
    expect((after.components ?? []).map((component) => component["bom-ref"])).toEqual(["pkg:npm/%40scope/kit@2.0.0"]);
  });

  it("marks the layer incomplete for an input outside the root that no package claims, and names it", async () => {
    fs.writeFileSync(path.join(workdir, "shared.ts"), "export const shared = 'outside';\n");
    write("nodejs/src/index.ts", 'import { shared } from "../../../shared.ts";\nexport const Store = { shared };\n');
    const payload = await build();
    expect(incomplete(recordOf(payload))).toEqual(["role=controller;format=js"]);
    expect(payload.billOfMaterials.unattributed).toEqual([{ layer: "controller/js", input: "../shared.ts" }]);
    assertOccurrencesNameIndexedLayers(payload);
  });

  it("never attributes a package that declares no version to a manifest above its node_modules directory", async () => {
    write("package.json", JSON.stringify({ name: "vault-root", version: "9.9.9" }));
    writePackage("node_modules/nover", { name: "nover" }, "export const nover = 1;\n");
    write("node_modules/inner/package.json", JSON.stringify({ type: "module" }));
    write("node_modules/inner/lib/x.js", "export const inner = 2;\n");
    write(
      "nodejs/src/index.ts",
      'import { nover } from "nover";\nimport { inner } from "inner/lib/x.js";\nexport const Store = { nover, inner };\n',
    );
    const payload = await build();
    expect(recordOf(payload).components ?? []).toEqual([]);
    expect(payload.billOfMaterials.unattributed.map((entry) => entry.input)).toEqual([
      "node_modules/inner/lib/x.js",
      "node_modules/nover/index.js",
    ]);
  });

  it("treats a nested module's import of its parent's file as the artifact's own code", async () => {
    write("telo.yaml", ["kind: Telo.Library", "metadata:", "  name: Parent", "  version: 1.0.0", "imports:", "  Chat: ./chat", ""].join("\n"));
    write("shared.ts", "export const shared = 'parent';\n");
    write(
      "chat/telo.yaml",
      controllerModule().replace("  name: Vault\n  version: 0.3.0\n", "  name: Chat\n"),
    );
    write("chat/nodejs/src/index.ts", 'import { shared } from "../../../shared.ts";\nexport const Store = { shared };\n');
    const payload = await build();
    const [chat] = payload.nested;
    expect(chat!.path).toBe("chat/telo.yaml");
    expect(chat!.billOfMaterials.unattributed).toEqual([]);
    expect(incomplete(chat!.billOfMaterials.record)).toEqual([]);
    expect(chat!.layers.map((layer) => layer.role)).toContain("sbom");
  });

  it("derives for a module on disk the record publishing writes", async () => {
    write("nodejs/src/index.ts", 'import { leftPad } from "left-pad";\nexport const Store = { leftPad };\n');
    const builder = new ModulePayloadBuilder({ cacheRoot: path.join(workdir, ".telo") });
    const derived = await builder.derivedBillOfMaterials(path.join(mod, "telo.yaml"));
    expect(derived.text).toBe((await build()).billOfMaterials.text);
  });
});

describe("the bill of materials of staged and checked-in files", () => {
  const SHA = createHash("sha256").update("elf").digest("hex");
  const manifest = (sourcePurl: string | undefined) =>
    [
      "kind: Telo.Library",
      "metadata:",
      "  name: Native",
      "  version: 1.0.0",
      "native:",
      "  - { name: addon, format: node, os: linux, arch: amd64, abi: node-137, path: ./native/linux/addon.node }",
      "  - { name: addon, format: napi, os: darwin, arch: arm64, path: ./native/darwin/addon.node }",
      "sources:",
      "  addon:",
      "    version: 12.8.0",
      ...(sourcePurl
        ? [`    purl: ${sourcePurl}`, '    contains: [{ purl: pkg:generic/sqlite, version: 3.51.3, cpe: "cpe:2.3:a:sqlite:sqlite:3.51.3:*:*:*:*:*:*:*" }]']
        : []),
      "    url: https://example.test/v{version}/{upstream}.tar.gz",
      "    archive: tar.gz",
      "    notices: [./NOTICE]",
      "    entries:",
      `      ./native/linux/addon.node: { upstream: linux, member: addon.node, sha256: ${SHA}, executable: false }`,
      "",
    ].join("\n");

  it("lists a staged source and what it contains in its layer, and marks a native file no source stages incomplete", async () => {
    write("telo.yaml", manifest("pkg:npm/better-sqlite3"));
    write("NOTICE", "notice");
    write("native/darwin/addon.node", "macho");
    const payload = await build();
    const record = recordOf(payload);
    const linux = "role=native;abi=node-137;arch=amd64;format=node;os=linux";

    expect((record.components ?? []).map((component) => component["bom-ref"])).toEqual([
      "pkg:generic/sqlite@3.51.3",
      "pkg:npm/better-sqlite3@12.8.0",
    ]);
    expect(occurrences(record, "pkg:npm/better-sqlite3@12.8.0")).toEqual([linux]);
    expect(record.components![0]).toMatchObject({ cpe: "cpe:2.3:a:sqlite:sqlite:3.51.3:*:*:*:*:*:*:*" });
    expect(record.dependencies).toEqual([
      { ref: "pkg:npm/better-sqlite3@12.8.0", dependsOn: ["pkg:generic/sqlite@3.51.3"] },
    ]);
    expect(incomplete(record)).toEqual(["role=native;arch=arm64;format=napi;os=darwin"]);
    assertOccurrencesNameIndexedLayers(payload);
  });

  it("marks what a source with no purl stages incomplete", async () => {
    write("telo.yaml", manifest(undefined).replace("    version: 12.8.0\n", "    version: 12.8.0\n    build: { cargo: ./rust, inputs: sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA }\n"));
    write("NOTICE", "notice");
    write("native/darwin/addon.node", "macho");
    write("rust/Cargo.toml", '[package]\nname = "addon"\nversion = "1.0.0"\n');
    const record = recordOf(await build());
    expect(record.components ?? []).toEqual([]);
    expect(incomplete(record).sort()).toEqual([
      "role=native;abi=node-137;arch=amd64;format=node;os=linux",
      "role=native;arch=arm64;format=napi;os=darwin",
    ]);
  });

  it("lists one component per revision of a version, each carrying its repository and commit, the same bytes each build", async () => {
    const source = (name: string, revision: string, file: string) => [
      `  ${name}:`,
      "    version: 1.0.0",
      `    purl: pkg:npm/${name}`,
      "    contains:",
      `      - { purl: pkg:generic/sqlite, version: 3.51.3, vcs: { url: git+https://github.com/sqlite/sqlite, revision: ${revision} } }`,
      "    url: https://example.test/{upstream}.tar.gz",
      "    archive: tar.gz",
      "    notices: [./NOTICE]",
      "    entries:",
      `      ./${file}: { upstream: x, member: x, sha256: ${SHA}, executable: false }`,
    ];
    write(
      "telo.yaml",
      [
        "kind: Telo.Library",
        "metadata: { name: Twin, version: 1.0.0 }",
        "assets: [./a.wasm, ./b.wasm]",
        "sources:",
        ...source("addon-a", "a5333afb9ad1aa473f8963b92caeaa955f47dc74", "a.wasm"),
        ...source("addon-b", "66476771b77e3c0df9d406d912486c43ac726fab", "b.wasm"),
        "",
      ].join("\n"),
    );
    write("NOTICE", "notice");
    const first = await build();
    const vcsRef = (revision: string) =>
      `pkg:generic/sqlite@3.51.3?vcs_url=git%2Bhttps%3A%2F%2Fgithub.com%2Fsqlite%2Fsqlite%40${revision}`;
    expect((recordOf(first).components ?? []).map((component) => component["bom-ref"])).toEqual([
      vcsRef("66476771b77e3c0df9d406d912486c43ac726fab"),
      vcsRef("a5333afb9ad1aa473f8963b92caeaa955f47dc74"),
      "pkg:npm/addon-a@1.0.0",
      "pkg:npm/addon-b@1.0.0",
    ]);
    expect(recordOf(first).dependencies).toEqual([
      { ref: "pkg:npm/addon-a@1.0.0", dependsOn: [vcsRef("a5333afb9ad1aa473f8963b92caeaa955f47dc74")] },
      { ref: "pkg:npm/addon-b@1.0.0", dependsOn: [vcsRef("66476771b77e3c0df9d406d912486c43ac726fab")] },
    ]);
    const sbom = (payload: ModulePayload) => readOwnerManifest(payload.manifest).layers!.find((l) => l.role === "sbom")!;
    expect(sbom(await build())).toEqual(sbom(first));
  });

  it("refuses an author's file at the record's path", async () => {
    write("telo.yaml", ["kind: Telo.Library", "metadata:", "  name: Plain", "  version: 1.0.0", "files: [sbom.cdx.json]", ""].join("\n"));
    write("sbom.cdx.json", "{}");
    await expect(build()).rejects.toThrow(
      "./sbom.cdx.json is the path the module's bill of materials is written to. Rename the file or leave it out of `files:`.",
    );
  });
});

describe("reading an artifact's stored record", () => {
  it("fetches the sbom layer alone, verifies it and serves it from the layer store", async () => {
    const record = '{"bomFormat":"CycloneDX","metadata":{"component":{"name":"M","type":"library"}},"specVersion":"1.6","version":1}\n';
    const files: PayloadFile[] = [{ name: "sbom.cdx.json", content: Buffer.from(record) }];
    const sbom: ArtifactLayer = { role: "sbom", blob: `sha256:${"b".repeat(64)}`, integrity: await computeFilesIntegrity(files) };
    const layers: ArtifactLayer[] = [
      { role: "common", blob: `sha256:${"a".repeat(64)}`, integrity: `sha256-${"A".repeat(43)}` },
      sbom,
    ];
    const fetched: string[] = [];
    const transports = {
      fetchLayer: async (_ref: string, blob: string) => {
        fetched.push(blob);
        return files;
      },
    };
    const cacheRoot = path.join(workdir, "cache");
    const read = () => readArtifactBillOfMaterials({ pinnedRef: `${DESTINATION}@0.3.0`, layers, cacheRoot, transports });

    expect((await read())!.text).toBe(record);
    expect((await read())!.record.metadata.component.name).toBe("M");
    expect(fetched).toEqual([sbom.blob]);
    expect(fs.existsSync(path.join(cacheRoot, "layers", `sha256-${"b".repeat(64)}`, "sbom.cdx.json"))).toBe(true);

    const swapped = { fetchLayer: async () => [{ name: "sbom.cdx.json", content: Buffer.from("{}\n") }] };
    await expect(
      readArtifactBillOfMaterials({ pinnedRef: DESTINATION, layers, cacheRoot: path.join(workdir, "other"), transports: swapped }),
    ).rejects.toMatchObject({ code: "ERR_MODULE_LAYER_INTEGRITY" });
  });

  it("answers nothing for an artifact published without the layer", async () => {
    expect(
      await readArtifactBillOfMaterials({ pinnedRef: DESTINATION, layers: [], cacheRoot: path.join(workdir, "cache") }),
    ).toBeUndefined();
  });
});
